import { scheduler } from "node:timers/promises";
import {
  AIMessage,
  AIMessageChunk,
  ChatMessage,
  ChatMessageChunk,
  collapseToolCallChunks,
  defaultToolCallParser,
  type InvalidToolCall,
  type ToolCall,
  type ToolCallChunk,
} from "@langchain/core/messages";
import type { createDeepAgent } from "deepagents";
import { createMiddleware } from "langchain";
import type { OpenWikiRunEvent } from "./types.js";

// DeepAgents 1.12 adds a general-purpose task tool even when subagents is
// empty. Page workers are deliberately non-delegating, so remove that
// model-facing capability after all tool-contributing middleware has run.
export const NO_DELEGATION_MIDDLEWARE = createMiddleware({
  name: "OpenWikiRepositoryWorkerNoDelegation",
  wrapModelCall: async (request, handler) => {
    const response = await handler({
      ...request,
      tools: request.tools?.filter(({ name }) => name !== "task"),
    });

    return coerceWorkerModelResponse(response);
  },
});

/**
 * Normalizes provider-streaming aggregates that are assistant output but were
 * typed as generic chat messages because the first OpenAI-compatible SSE delta
 * arrived without `role:"assistant"` (for example reasoning-only first deltas).
 *
 * LangChain validates each wrapModelCall response before the agent node can
 * continue. Coerce only this worker boundary so provider transport
 * handling stays owned by the model client.
 */
function coerceWorkerModelResponse(response: AIMessage): AIMessage {
  const candidate: unknown = response;

  if (AIMessage.isInstance(candidate)) {
    return candidate;
  }

  if (
    ChatMessageChunk.isInstance(candidate) &&
    isGenericAssistantModelResponse(candidate)
  ) {
    const rawToolCalls = getOpenAiRawToolCalls(candidate.additional_kwargs);
    const toolCallFields =
      rawToolCalls === null
        ? {}
        : collapseToolCallChunks(rawToolCalls.map(toToolCallChunk));

    return new AIMessageChunk({
      content: candidate.content,
      additional_kwargs: candidate.additional_kwargs,
      response_metadata: candidate.response_metadata,
      id: candidate.id,
      name: candidate.name,
      ...toolCallFields,
    });
  }

  if (
    ChatMessage.isInstance(candidate) &&
    isGenericAssistantModelResponse(candidate)
  ) {
    const rawToolCalls = getOpenAiRawToolCalls(candidate.additional_kwargs);
    const toolCallFields =
      rawToolCalls === null ? {} : parseRawOpenAiToolCalls(rawToolCalls);

    return new AIMessage({
      content: candidate.content,
      additional_kwargs: candidate.additional_kwargs,
      response_metadata: candidate.response_metadata,
      id: candidate.id,
      name: candidate.name,
      ...toolCallFields,
    });
  }

  return response;
}

function isGenericAssistantModelResponse(response: { role?: string }): boolean {
  return response.role === undefined || response.role === "assistant";
}

function getOpenAiRawToolCalls(
  additionalKwargs: Record<string, unknown> | undefined,
): Record<string, unknown>[] | null {
  const rawToolCalls = additionalKwargs?.tool_calls;

  if (!Array.isArray(rawToolCalls)) {
    return null;
  }

  return rawToolCalls.filter(isRecord);
}

function parseRawOpenAiToolCalls(rawToolCalls: Record<string, unknown>[]): {
  invalid_tool_calls: InvalidToolCall[];
  tool_calls: ToolCall[];
} {
  const [toolCalls, invalidToolCalls] = defaultToolCallParser(rawToolCalls);

  return {
    invalid_tool_calls: invalidToolCalls,
    tool_calls: toolCalls,
  };
}

function toToolCallChunk(rawToolCall: Record<string, unknown>): ToolCallChunk {
  const rawFunction = rawToolCall.function;
  const functionFields = isRecord(rawFunction) ? rawFunction : {};

  return {
    id: typeof rawToolCall.id === "string" ? rawToolCall.id : undefined,
    index:
      typeof rawToolCall.index === "number" ? rawToolCall.index : undefined,
    name:
      typeof functionFields.name === "string" ? functionFields.name : undefined,
    args:
      typeof functionFields.arguments === "string"
        ? functionFields.arguments
        : undefined,
    type: "tool_call_chunk",
  };
}

/**
 * Minimal page-job shape the worker pool schedules.
 */
export interface PageWorkerJob {
  /**
   * Stable job identifier owned by the calling core.
   */
  id: string;

  /**
   * Canonical virtual Markdown path the job writes.
   */
  path: string;
}

/**
 * Next job offered by the calling core, or queue completion.
 */
export type NextPageWorkerJob<Job extends PageWorkerJob> =
  { status: "pending"; job: Job } | { status: "complete" };

/**
 * Result of one bounded worker attempt.
 *
 * An attempt that hits a fatal failure (one a retry would repeat, such as the
 * core refusing a submission) throws instead of returning.
 */
export type PageWorkerAttemptOutcome =
  { status: "submitted" } | { status: "failed"; error?: unknown };

/**
 * Lifecycle operations of the core whose page queue the workers drain.
 *
 * The core owns every durable step; the pool only decides which job runs
 * where and when a page is retried or given up on.
 */
export interface PageWorkerCore<Job extends PageWorkerJob, Snapshot> {
  /**
   * Returns the first pending job not in `exclude`, without reserving it.
   */
  next(options: {
    exclude: ReadonlySet<string>;
  }): Promise<NextPageWorkerJob<Job>>;

  /**
   * Captures the page state a failed worker is rolled back to.
   */
  snapshot(jobId: string): Promise<Snapshot>;

  /**
   * Restores a page to its snapshot between attempts, leaving the job pending.
   */
  restore(snapshot: Snapshot): Promise<void>;

  /**
   * Restores a page to its snapshot and durably marks its job skipped.
   */
  skip(snapshot: Snapshot): Promise<void>;

  /**
   * Runs one fresh bounded worker that completes the job through the core's
   * submit operation.
   */
  attempt(job: Job, snapshot: Snapshot): Promise<PageWorkerAttemptOutcome>;
}

/**
 * Scheduling options for one pass over a page queue.
 */
export interface PageWorkerPoolOptions {
  /**
   * Maximum workers running at once; lowered after rate limits, never below 1.
   */
  concurrency: number;

  /**
   * Delay between the first wave of worker starts, per slot, in milliseconds.
   */
  workerStartStaggerMs: number;

  /**
   * Job ids run only after every other job finished, by a single worker.
   *
   * Applied only when more than one worker runs; a single worker already
   * follows queue order.
   *
   * @default empty
   */
  finalJobIds?: ReadonlySet<string>;

  /**
   * Optional lifecycle and bounded worker-tool event consumer.
   */
  onEvent?: (event: OpenWikiRunEvent) => void;

  /**
   * Reports the page a worker just started, or the newest in-flight page
   * after one finished.
   *
   * `inFlightPages` lists the pages being written, in start order, and is
   * present only when more than one worker runs.
   */
  onProgress?: (
    focusPage: string | undefined,
    inFlightPages: readonly string[] | undefined,
  ) => void;
}

/**
 * Default per-slot delay between the first wave of worker starts.
 */
export const DEFAULT_WORKER_START_STAGGER_MS = 1_000;

/**
 * Result of one bounded page worker.
 */
type PageAgentOutcome<Snapshot> =
  | { status: "submitted" }
  | { status: "skipped"; snapshot: Snapshot; error?: unknown };

/**
 * Process-local bookkeeping shared by the worker loops of one run.
 *
 * Nothing here is durable: the checkpoint only records pending, skipped, and
 * complete jobs, and a resumed run rebuilds ownership from scratch.
 */
interface PageWorkerPool<Snapshot> {
  /**
   * Whether the run was configured with more than one worker.
   */
  concurrent: boolean;

  /**
   * Job ids handed to a worker in this process; never offered again.
   */
  claimed: Set<string>;

  /**
   * Serializes job acquisition so two loops never select the same job.
   *
   * The core's `next` selects before its first await, so concurrent calls
   * in one tick would all see the same unclaimed head of the queue.
   */
  acquiring: Promise<void>;

  /**
   * Canonical pages currently being written, in start order.
   */
  inFlight: string[];

  /**
   * Live worker limit; lowered after rate-limit failures, never below 1.
   */
  size: number;

  /**
   * First fatal error; once set, loops stop taking new jobs.
   */
  fatal: { error: unknown } | null;

  /**
   * Snapshots of pages whose worker exited without submitting.
   */
  skipped: Snapshot[];
}

/**
 * Runs every remaining page job with fresh bounded workers, up to
 * `concurrency` at a time.
 *
 * Final jobs run after every other job, so a page such as quickstart can link
 * to pages that already exist. A fatal error stops new work, lets in-flight
 * workers submit or skip, and is rethrown so the run never finalizes with
 * pending jobs.
 *
 * @param core - Lifecycle operations of the core owning the queue.
 * @param options - Concurrency, start stagger, final jobs, and event consumers.
 * @returns Snapshots of every page skipped during this pass.
 */
export async function runPageWorkers<Job extends PageWorkerJob, Snapshot>(
  core: PageWorkerCore<Job, Snapshot>,
  options: PageWorkerPoolOptions,
): Promise<Snapshot[]> {
  const size = Math.max(1, Math.floor(options.concurrency));
  const pool: PageWorkerPool<Snapshot> = {
    concurrent: size > 1,
    claimed: new Set(),
    acquiring: Promise.resolve(),
    inFlight: [],
    size,
    fatal: null,
    skipped: [],
  };
  const heldBack: ReadonlySet<string> = pool.concurrent
    ? (options.finalJobIds ?? new Set())
    : new Set();

  await runWorkerLoops(
    core,
    options,
    pool,
    heldBack,
    options.workerStartStaggerMs,
  );
  if (!pool.fatal && heldBack.size > 0) {
    pool.size = 1;
    await runWorkerLoops(core, options, pool, new Set(), 0);
  }

  if (pool.fatal) throw pool.fatal.error;
  return pool.skipped;
}

/**
 * Runs `pool.size` worker loops to completion over the jobs not held back.
 */
async function runWorkerLoops<Job extends PageWorkerJob, Snapshot>(
  core: PageWorkerCore<Job, Snapshot>,
  options: PageWorkerPoolOptions,
  pool: PageWorkerPool<Snapshot>,
  heldBack: ReadonlySet<string>,
  workerStartStaggerMs: number,
): Promise<void> {
  await Promise.all(
    Array.from({ length: pool.size }, (_, slot) =>
      runWorkerLoop(slot, core, options, pool, heldBack, workerStartStaggerMs),
    ),
  );
}

/**
 * One worker slot: claims the next unowned pending job, documents it with a
 * fresh agent, and repeats until the queue is drained, a fatal error is
 * recorded, or the live pool size no longer includes this slot.
 */
async function runWorkerLoop<Job extends PageWorkerJob, Snapshot>(
  slot: number,
  core: PageWorkerCore<Job, Snapshot>,
  options: PageWorkerPoolOptions,
  pool: PageWorkerPool<Snapshot>,
  heldBack: ReadonlySet<string>,
  workerStartStaggerMs: number,
): Promise<void> {
  const { onEvent } = options;
  if (slot > 0 && workerStartStaggerMs > 0) {
    await scheduler.wait(slot * workerStartStaggerMs);
  }

  while (!pool.fatal && slot < pool.size) {
    const next = await acquireNextJob(core, pool, heldBack);
    // Another worker can fail fatally while this loop waits for serialized job
    // acquisition. Do not start model work for that newly claimed page.
    if (pool.fatal || slot >= pool.size) return;
    if (next.status === "complete") return;

    pool.inFlight.push(next.job.path);
    reportProgress(options, pool, next.job.path);

    let outcome: PageAgentOutcome<Snapshot>;
    try {
      outcome = await runPageAgent(core, next.job, onEvent);
    } catch (error) {
      pool.fatal ??= { error };
      removeInFlightPage(pool, next.job.path);
      return;
    }
    removeInFlightPage(pool, next.job.path);

    if (outcome.status === "skipped") {
      pool.skipped.push(outcome.snapshot);
      if (pool.size > 1 && isRateLimitError(outcome.error)) {
        pool.size -= 1;
        onEvent?.({
          type: "text",
          source: "main",
          text: `Reduced page concurrency to ${pool.size} after a provider rate limit while documenting ${next.job.path}.\n`,
        });
      }
    }

    if (pool.concurrent && pool.inFlight.length > 0) {
      reportProgress(options, pool, pool.inFlight.at(-1));
    }
  }
}

/**
 * Selects and claims the next unowned pending job, one loop at a time.
 *
 * @param core - Core offering the persisted queue.
 * @param pool - Shared worker bookkeeping holding the claim set.
 * @param heldBack - Job ids deferred to a later pass.
 * @returns The claimed job, or queue completion.
 */
function acquireNextJob<Job extends PageWorkerJob, Snapshot>(
  core: PageWorkerCore<Job, Snapshot>,
  pool: PageWorkerPool<Snapshot>,
  heldBack: ReadonlySet<string>,
): Promise<NextPageWorkerJob<Job>> {
  const acquisition = pool.acquiring.then(async () => {
    const next = await core.next({
      exclude: new Set([...pool.claimed, ...heldBack]),
    });
    if (next.status === "pending") pool.claimed.add(next.job.id);
    return next;
  });
  pool.acquiring = acquisition.then(
    () => undefined,
    () => undefined,
  );
  return acquisition;
}

function removeInFlightPage<Snapshot>(
  pool: PageWorkerPool<Snapshot>,
  page: string,
): void {
  const index = pool.inFlight.indexOf(page);
  if (index >= 0) pool.inFlight.splice(index, 1);
}

function reportProgress<Snapshot>(
  options: PageWorkerPoolOptions,
  pool: PageWorkerPool<Snapshot>,
  focusPage: string | undefined,
): void {
  options.onProgress?.(
    focusPage,
    pool.concurrent ? [...pool.inFlight] : undefined,
  );
}

/**
 * Recognizes provider rate limiting in an error raised by a page worker.
 *
 * Checks HTTP 429 status fields, common provider error codes, and message
 * text, following `cause` chains so wrapped SDK errors are recognized too.
 *
 * @param error - Unknown error thrown by a worker's agent stream.
 * @returns Whether the failure was a rate limit rather than a page problem.
 */
export function isRateLimitError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let candidate: unknown = error;
  while (isRecord(candidate) && !seen.has(candidate)) {
    seen.add(candidate);
    const status = candidate.status ?? candidate.statusCode;
    if (status === 429 || candidate.code === 429) return true;
    if (
      typeof candidate.code === "string" &&
      /rate.?limit/iu.test(candidate.code)
    ) {
      return true;
    }
    if (
      typeof candidate.message === "string" &&
      /\b429\b|rate.?limit|too many requests/iu.test(candidate.message)
    ) {
      return true;
    }
    candidate = candidate.cause;
  }
  return false;
}

/** Worker attempts per pending page before it is given up on. */
const PAGE_WORKER_ATTEMPT_LIMIT = 2;

/**
 * Runs one page job with a fresh bounded worker per attempt, retrying a worker
 * that exits without submitting once before the page is skipped.
 *
 * @param core - Lifecycle operations of the core owning the job.
 * @param job - Pending page job owned by this worker.
 * @param onEvent - Optional bounded worker event consumer.
 * @returns Whether the page was submitted, or the snapshot restored on skip.
 */
export async function runPageAgent<Job extends PageWorkerJob, Snapshot>(
  core: PageWorkerCore<Job, Snapshot>,
  job: Job,
  onEvent?: (event: OpenWikiRunEvent) => void,
): Promise<PageAgentOutcome<Snapshot>> {
  const snapshot = await core.snapshot(job.id);
  let skipped: PageAgentOutcome<Snapshot> = { status: "skipped", snapshot };

  for (let attempt = 1; attempt <= PAGE_WORKER_ATTEMPT_LIMIT; attempt += 1) {
    const outcome = await core.attempt(job, snapshot);
    if (outcome.status === "submitted") return outcome;
    skipped = { status: "skipped", snapshot, error: outcome.error };

    // A rate limit means the provider is asking for less traffic, so it is
    // surfaced to the pool immediately instead of being retried at once.
    if (
      attempt >= PAGE_WORKER_ATTEMPT_LIMIT ||
      isRateLimitError(outcome.error)
    ) {
      break;
    }

    // A worker that exits without submitting never banked its page edits, so
    // reset the page to the pre-run snapshot before the retry. Both attempts
    // then start from the same state.
    await core.restore(snapshot);
  }

  await core.skip(snapshot);
  emitDeferredPageWarning(job.path, onEvent);
  return skipped;
}

function emitDeferredPageWarning(
  page: string,
  onEvent?: (event: OpenWikiRunEvent) => void,
): void {
  onEvent?.({
    type: "text",
    source: "main",
    text: `${page} was restored after its worker exited without submitting. It was skipped for this update and will be reconsidered on the next update.\n`,
  });
}

/**
 * Streams only bounded worker tool lifecycle events, never worker narration.
 *
 * @param agent - Fresh planner or page agent.
 * @param messages - Single worker instruction message.
 * @param traceThreadId - LangSmith thread shared by every worker of this run.
 * @param parseEvent - Driver parser that keeps only its approved worker tools.
 * @param onEvent - Optional CLI event consumer.
 * @param page - Canonical page owned by a page worker, tagged onto its events.
 */
export async function streamWorkerTools(
  agent: ReturnType<typeof createDeepAgent>,
  messages: Array<{ role: "user"; content: string }>,
  traceThreadId: string,
  parseEvent: (chunk: unknown) => OpenWikiRunEvent | null,
  onEvent?: (event: OpenWikiRunEvent) => void,
  page?: string,
): Promise<void> {
  // LangGraph copies `configurable.thread_id` into every run's metadata, which
  // is what LangSmith groups a thread by. Safe to share across concurrent
  // workers only because they have no checkpointer.
  const stream = await agent.stream(
    { messages },
    {
      streamMode: ["tools"],
      subgraphs: true,
      configurable: { thread_id: traceThreadId },
    },
  );

  for await (const chunk of stream) {
    const event = parseEvent(chunk);
    if (!event) continue;
    onEvent?.(
      page !== undefined &&
        (event.type === "tool_start" || event.type === "tool_end")
        ? { ...event, page }
        : event,
    );
    await scheduler.yield();
  }
}

/**
 * Creates a parser that normalizes DeepAgents tools-stream chunks from the
 * approved worker tools.
 *
 * @param toolNames - Worker tool names whose lifecycle events are reported.
 * @returns Parser returning a bounded tool lifecycle event, or `null` for
 *   narration and unknown tools.
 */
export function createWorkerToolEventParser(
  toolNames: ReadonlySet<string>,
): (chunk: unknown) => OpenWikiRunEvent | null {
  return (chunk) => parseWorkerToolEvent(chunk, toolNames);
}

function parseWorkerToolEvent(
  chunk: unknown,
  toolNames: ReadonlySet<string>,
): OpenWikiRunEvent | null {
  if (
    !Array.isArray(chunk) ||
    chunk.length !== 3 ||
    chunk[1] !== "tools" ||
    !isRecord(chunk[2])
  ) {
    return null;
  }

  const payload = chunk[2];
  const name = typeof payload.name === "string" ? payload.name : "";
  if (!toolNames.has(name)) return null;

  const id = typeof payload.toolCallId === "string" ? payload.toolCallId : name;
  if (payload.event === "on_tool_start") {
    return {
      type: "tool_start",
      call: name,
      id,
      input: payload.input,
      name,
    };
  }

  if (payload.event === "on_tool_end" || payload.event === "on_tool_error") {
    return {
      type: "tool_end",
      id,
      name,
      status: payload.event === "on_tool_error" ? "error" : "finished",
    };
  }

  return null;
}

/**
 * Narrows an unknown value to an object with string keys.
 *
 * @param value - Unknown candidate value.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
