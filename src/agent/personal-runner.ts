import os from "node:os";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ToolMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
import { z } from "zod";
import { resolveTraceThreadId } from "../config/constants.js";
import { RepositoryRunError } from "../generation/errors.js";
import {
  beginPersonalRun,
  capturePersonalPageSnapshot,
  closePersonalGathering,
  finishPersonalRun,
  nextPersonalPage,
  readPersonalOpenQuestions,
  releasePersonalRun,
  renewPersonalRun,
  restorePersonalPage,
  skipPersonalPage,
  submitPersonalPage,
  submitPersonalPlan,
  type ActivePersonalRun,
  type PersonalBeginView,
  type PersonalPageJobView,
  type PersonalPageSnapshot,
} from "../generation/personal-run.js";
import { PERSONAL_QUICKSTART_PAGE } from "../generation/personal-run-plan.js";
import type { PersonalRunMode } from "../generation/personal-run-state.js";
import { readOpenWikiOnboardingConfig } from "../setup/onboarding.js";
import { OPENWIKI_PRODUCER_ACTOR } from "../version.js";
import {
  AGENT_FILESYSTEM_PERMISSIONS,
  createAgentBackend,
} from "./agent-backend.js";
import { OpenWikiLocalShellBackend } from "./docs-only-backend.js";
import {
  createWorkerToolEventParser,
  DEFAULT_WORKER_START_STAGGER_MS,
  NO_DELEGATION_MIDDLEWARE,
  runPageWorkers,
  streamWorkerTools,
  type PageWorkerAttemptOutcome,
} from "./page-workers.js";
import {
  createPersonalGatherPrompt,
  createPersonalPagePrompt,
  createPersonalPlannerPrompt,
  type PersonalPromptSource,
} from "./personal-prompts.js";
import {
  createPersonalGatherTools,
  createPersonalRawEvidenceTools,
  PersonalPageWorkerBackend,
} from "./personal-worker-tools.js";
import type { OpenWikiRunEvent } from "./types.js";

/**
 * Environment flag that opts `openwiki personal --init/--update` in to the
 * lifecycle core and this driver until the release gate passes (core §3.5).
 */
export const OPENWIKI_PERSONAL_CORE_ENV_KEY = "OPENWIKI_PERSONAL_CORE";

/**
 * Whether the native personal driver is opted in.
 *
 * @param env - Environment to read.
 * @returns `true` only when `OPENWIKI_PERSONAL_CORE` is `1`.
 */
export function isPersonalCoreEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[OPENWIKI_PERSONAL_CORE_ENV_KEY]?.trim() === "1";
}

const PlanPageSchema = z
  .object({
    path: z.string().trim().min(1),
    title: z.string().trim().min(1),
    purpose: z.string().trim().min(1),
    seedEvidence: z.array(z.string().trim().min(1)).optional(),
    relatedPages: z.array(z.string().trim().min(1)).optional(),
    instructions: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

const PlanSchema = z
  .object({
    pages: z.array(PlanPageSchema),
    deletePages: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

/**
 * Read-only wiki tools of the gather worker and the planner.
 */
export const PERSONAL_READ_TOOLS = ["read_file", "ls", "glob", "grep"] as const;

/**
 * Wiki tools of a page worker, confined to its page by the backend.
 */
export const PERSONAL_PAGE_TOOLS = [
  ...PERSONAL_READ_TOOLS,
  "write_file",
  "edit_file",
] as const;

const WORKER_TOOL_NAMES = new Set<string>([
  ...PERSONAL_PAGE_TOOLS,
  "openwiki_list_raw_items",
  "openwiki_read_raw_item",
  "openwiki_list_mcp_tools",
  "openwiki_call_mcp_tool",
  "close_gathering",
  "submit_plan",
  "submit_page",
]);

/**
 * Normalizes a DeepAgents tools-stream chunk from an approved worker tool.
 */
const parseWorkerToolEvent = createWorkerToolEventParser(WORKER_TOOL_NAMES);

/**
 * Interval at which the driver renews its lock while workers run. Well under
 * the lock's 30-minute expiry, so a long model call never lets it lapse.
 */
const DEFAULT_LOCK_RENEWAL_INTERVAL_MS = 5 * 60_000;

/**
 * Inputs for one native personal init or update.
 */
export interface NativePersonalGenerationOptions {
  /**
   * Command to start or resume.
   */
  mode: PersonalRunMode;

  /**
   * Requested output language, resolved by the core.
   *
   * @default undefined - the wiki's persisted language, or English.
   */
  language?: string | null;

  /**
   * User request text, recorded as the run's instruction.
   *
   * @default undefined - none.
   */
  instruction?: string | null;

  /**
   * Stable model identity written to `.last-update.json`.
   */
  modelId: string;

  /**
   * Initialized chat model reused by every fresh worker.
   */
  model: BaseChatModel;

  /**
   * Maximum page workers running at once. With more than one, the quickstart
   * page waits until every other page has finished.
   *
   * @default 1
   */
  pageConcurrency?: number;

  /**
   * Delay between the first wave of worker starts, per slot, in milliseconds.
   *
   * @default 1000
   */
  workerStartStaggerMs?: number;

  /**
   * Interval at which the lock is renewed while workers run, in milliseconds.
   *
   * @default 300000
   */
  lockRenewalIntervalMs?: number;

  /**
   * Lock holder ID, `<driver>:<hostname>:<pid>`.
   *
   * @default `native:<hostname>:<pid>` of this process.
   */
  holder?: string;

  /**
   * Optional lifecycle and bounded worker-tool event consumer.
   */
  onEvent?: (event: OpenWikiRunEvent) => void;
}

/**
 * Observable result of one native personal init or update.
 */
export interface NativePersonalGenerationResult {
  /**
   * Whether the update was a no-op: no evidence, no request, no rewrites.
   */
  skipped: boolean;

  /**
   * Status written to `.last-update.json`: `interrupted` when a page job was
   * skipped and will be retried by the next run.
   *
   * @default undefined for a no-op.
   */
  lastUpdateStatus?: "complete" | "interrupted";
}

/**
 * Drives one personal run through the lifecycle core: gathering when an
 * agentic connector is in scope, then one planner and one fresh worker per
 * page job.
 *
 * No worker has a shell, ingest tools, or delegation. A failure releases the
 * lock and leaves `.run.json` in place, so the next `begin` from any driver
 * resumes the run.
 *
 * @param options - Mode, request, model, concurrency, and event consumer.
 * @returns No-op status, or the status written to `.last-update.json`.
 * @throws RepositoryRunError (`conflict`) when another process holds the lock
 *   or the interrupted run has a different mode or language.
 */
export async function runNativePersonalGeneration(
  options: NativePersonalGenerationOptions,
): Promise<NativePersonalGenerationResult> {
  const begun = await beginPersonalRun({
    mode: options.mode,
    language: options.language ?? undefined,
    instruction: options.instruction ?? undefined,
    actor: {
      producerActor: OPENWIKI_PRODUCER_ACTOR,
      metadataModel: options.modelId,
    },
    holder: options.holder ?? `native:${os.hostname()}:${process.pid}`,
  });
  for (const warning of begun.view.warnings) {
    emitText(options.onEvent, `${warning}\n`);
  }
  if (!("run" in begun)) {
    options.onEvent?.({
      type: "repository_progress",
      wiki: "personal",
      stage: "noop",
    });
    return { skipped: true };
  }

  const { run, view } = begun;
  const stopRenewal = startLockRenewal(
    run,
    options.lockRenewalIntervalMs ?? DEFAULT_LOCK_RENEWAL_INTERVAL_MS,
  );
  try {
    const sources = await readPromptSources();
    if (run.state.phase === "gathering") {
      options.onEvent?.({
        type: "repository_progress",
        wiki: "personal",
        stage: "gathering",
        resumed: view.resumed,
      });
      await runGatherAgent(run, view, options.model, sources, options.onEvent);
    }
    if (run.state.phase === "planning") {
      options.onEvent?.({
        type: "repository_progress",
        wiki: "personal",
        stage: "planning",
        resumed: view.resumed,
      });
      // Gathering may have added raw runs to the frontier since begin.
      await runPlanningAgent(
        run,
        { ...view, phase: run.state.phase, frontier: run.state.frontier },
        options.model,
        sources,
        options.onEvent,
      );
    }

    const skippedPageSnapshots = await runPendingPageAgents(
      run,
      view,
      options.model,
      options.pageConcurrency ?? 1,
      options.workerStartStaggerMs ?? DEFAULT_WORKER_START_STAGGER_MS,
      options.onEvent,
    );
    options.onEvent?.({
      type: "repository_progress",
      wiki: "personal",
      stage: "finalizing",
      resumed: view.resumed,
      pageCount: run.state.plan?.pages.length,
    });

    const result = await finishPersonalRun(run, { skippedPageSnapshots });
    for (const connectorId of result.heldConnectors) {
      emitText(
        options.onEvent,
        `Evidence from ${connectorId} stays pending because a page seeded with it was skipped; the next update reads it again.\n`,
      );
    }
    return { skipped: false, lastUpdateStatus: result.lastUpdateStatus };
  } catch (error) {
    // Keep .run.json so the run stays resumable; release only the lock.
    await releasePersonalRun(run).catch(() => undefined);
    throw error;
  } finally {
    stopRenewal();
  }
}

/**
 * Renews the lock on a timer while workers run.
 *
 * A failed renewal is left to the next core operation, which reports the lost
 * lock as `conflict` and stops the run.
 *
 * @returns A function that stops the timer.
 */
function startLockRenewal(
  run: ActivePersonalRun,
  intervalMs: number,
): () => void {
  const timer = setInterval(() => {
    renewPersonalRun(run).catch(() => undefined);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Reads the connected sources and their ingestion goals for the prompts.
 */
async function readPromptSources(): Promise<PersonalPromptSource[]> {
  const onboarding = await readOpenWikiOnboardingConfig();
  return onboarding.sourceInstances
    .filter(({ connectedAt }) => Boolean(connectedAt))
    .map(({ connectorId, name, ingestionGoal }) => ({
      connectorId,
      ...(name ? { name } : {}),
      ...(ingestionGoal ? { ingestionGoal } : {}),
    }));
}

/**
 * Runs the gather worker, then closes gathering if the worker did not.
 *
 * A worker that ends without calling `close_gathering` still recorded its
 * evidence, so the driver closes gathering for it. A worker that fails leaves
 * the run in gathering, to be resumed.
 */
async function runGatherAgent(
  run: ActivePersonalRun,
  view: PersonalBeginView,
  model: BaseChatModel,
  sources: readonly PersonalPromptSource[],
  onEvent?: (event: OpenWikiRunEvent) => void,
): Promise<void> {
  const connectorIds = run.state.frontier
    .filter(({ frozen }) => !frozen)
    .map(({ connectorId }) => connectorId);
  const wikiBackend = createReadOnlyWikiBackend(run);
  const backend = createAgentBackend(wikiBackend);
  const agent = createDeepAgent({
    name: GATHER_AGENT_NAME,
    model,
    tools: createPersonalGatherTools(run, connectorIds),
    backend,
    middleware: [
      createFilesystemMiddleware({
        backend,
        permissions: AGENT_FILESYSTEM_PERMISSIONS,
        tools: PERSONAL_READ_TOOLS,
      }),
      NO_DELEGATION_MIDDLEWARE,
    ],
    subagents: [],
    permissions: AGENT_FILESYSTEM_PERMISSIONS,
    systemPrompt: createPersonalGatherPrompt(view, connectorIds, sources),
  });

  await streamWorkerTools(
    agent,
    [{ role: "user", content: "Gather this run's evidence now." }],
    resolveTraceThreadId(run.state.runId),
    parseWorkerToolEvent,
    onEvent,
  );

  if (run.state.phase === "gathering") {
    await closePersonalGathering(run);
  }
}

/**
 * Runs one planner that must submit the plan.
 *
 * A run with no evidence and no request has nothing to route: its plan is
 * empty and only the core's required jobs remain, so no planner is started.
 */
async function runPlanningAgent(
  run: ActivePersonalRun,
  view: PersonalBeginView,
  model: BaseChatModel,
  sources: readonly PersonalPromptSource[],
  onEvent?: (event: OpenWikiRunEvent) => void,
): Promise<void> {
  const hasEvidence = run.state.frontier.some(
    ({ rawFiles }) => rawFiles.length > 0,
  );
  if (!hasEvidence && !run.state.instruction) {
    await submitPersonalPlan(run, { pages: [] });
    return;
  }

  let submitted = false;
  const submitPlanTool = new DynamicStructuredTool({
    name: "submit_plan",
    description:
      "Submit the page plan for this run. This is the only completion action for planning.",
    schema: PlanSchema,
    func: async (input, _runManager, config) => {
      try {
        const result = await submitPersonalPlan(run, input);
        submitted = true;
        return JSON.stringify(result);
      } catch (error) {
        if (
          error instanceof RepositoryRunError &&
          error.code === "invalid_input"
        ) {
          return createSubmissionRejection(
            "submit_plan",
            error,
            "Correct the plan and call submit_plan again.",
            getToolCallId(config),
          );
        }
        if (
          error instanceof RepositoryRunError &&
          error.code === "invalid_state" &&
          submitted
        ) {
          return createSubmissionRejection(
            "submit_plan",
            error,
            "A plan is already accepted. Stop planning and do not call submit_plan again.",
            getToolCallId(config),
          );
        }
        throw error;
      }
    },
  });

  const wikiBackend = createReadOnlyWikiBackend(run);
  const backend = createAgentBackend(wikiBackend);
  const agent = createDeepAgent({
    name: PLANNER_AGENT_NAME,
    model,
    tools: [...createPersonalRawEvidenceTools(run), submitPlanTool],
    backend,
    middleware: [
      createFilesystemMiddleware({
        backend,
        permissions: AGENT_FILESYSTEM_PERMISSIONS,
        tools: PERSONAL_READ_TOOLS,
      }),
      NO_DELEGATION_MIDDLEWARE,
    ],
    subagents: [],
    permissions: AGENT_FILESYSTEM_PERMISSIONS,
    systemPrompt: createPersonalPlannerPrompt(view, {
      existingPages: run.state.initialPages,
      openQuestions: await readPersonalOpenQuestions(run.wikiDir),
      sources,
    }),
  });

  await streamWorkerTools(
    agent,
    [{ role: "user", content: "Plan this personal wiki run now." }],
    resolveTraceThreadId(run.state.runId),
    parseWorkerToolEvent,
    onEvent,
  );

  if (!submitted || !run.state.plan) {
    throw new Error("Personal planning worker exited without submit_plan.");
  }
}

/** The gather worker's trace name in LangSmith. */
export const GATHER_AGENT_NAME = "gather agent";

/** The planner's trace name in LangSmith. */
export const PLANNER_AGENT_NAME = "planning agent";

/**
 * A page worker's trace name in LangSmith: the page it owns.
 *
 * @param page - Canonical page path, such as `/people/dana-ruiz.md`.
 */
export function personalWorkerAgentName(page: string): string {
  return `worker agent: ${page.replace(/^\//u, "").replace(/\.md$/u, "")}`;
}

/**
 * Runs every remaining page job with fresh workers, up to `pageConcurrency`
 * at a time. With several workers, quickstart waits for every other page.
 *
 * @returns Snapshots of every page skipped during this pass.
 */
async function runPendingPageAgents(
  run: ActivePersonalRun,
  view: PersonalBeginView,
  model: BaseChatModel,
  pageConcurrency: number,
  workerStartStaggerMs: number,
  onEvent: ((event: OpenWikiRunEvent) => void) | undefined,
): Promise<PersonalPageSnapshot[]> {
  const pages = run.state.plan?.pages ?? [];
  return runPageWorkers<PersonalPageJobView, PersonalPageSnapshot>(
    {
      next: (nextOptions) => nextPersonalPage(run, nextOptions),
      snapshot: (jobId) => capturePersonalPageSnapshot(run, jobId),
      restore: (snapshot) => restorePersonalPage(run, snapshot),
      skip: (snapshot) => skipPersonalPage(run, snapshot),
      attempt: (job) => runPageWorkerAttempt(run, view, job, model, onEvent),
    },
    {
      concurrency: pageConcurrency,
      workerStartStaggerMs,
      finalJobIds: new Set(
        pages
          .filter(({ path }) => path === PERSONAL_QUICKSTART_PAGE)
          .map(({ id }) => id),
      ),
      onEvent,
      onProgress: (focusPage, inFlightPages) =>
        emitGeneratingProgress(run, view, focusPage, inFlightPages, onEvent),
    },
  );
}

/**
 * Emits generating-stage progress for the focused page.
 */
function emitGeneratingProgress(
  run: ActivePersonalRun,
  view: PersonalBeginView,
  focusPage: string | undefined,
  inFlightPages: readonly string[] | undefined,
  onEvent: ((event: OpenWikiRunEvent) => void) | undefined,
): void {
  const pages = run.state.plan?.pages ?? [];
  onEvent?.({
    type: "repository_progress",
    wiki: "personal",
    stage: "generating",
    resumed: view.resumed,
    page: focusPage,
    pageIndex: pages.findIndex(({ path }) => path === focusPage) + 1,
    pageCount: pages.length,
    ...(inFlightPages
      ? {
          completedCount: pages.filter(({ status }) => status !== "pending")
            .length,
          inFlightPages: [...inFlightPages],
        }
      : {}),
  });
}

/**
 * Runs one fresh worker attempt for a page job.
 *
 * Its backend may write only the job's page, and every write carries the
 * page version the worker last saw, starting from the version the job was
 * acquired at. A retry starts there too: the snapshot restored before it was
 * captured right after acquisition.
 *
 * @returns Whether the attempt submitted the page.
 */
async function runPageWorkerAttempt(
  run: ActivePersonalRun,
  view: PersonalBeginView,
  job: PersonalPageJobView,
  model: BaseChatModel,
  onEvent?: (event: OpenWikiRunEvent) => void,
): Promise<PageWorkerAttemptOutcome> {
  let submitted = false;
  let fatalSubmissionFailure = false;
  const submitPageTool = new DynamicStructuredTool({
    name: "submit_page",
    description:
      "Complete the assigned page after writing it. Call it without arguments.",
    schema: z.object({}).strict(),
    func: async (_input, _runManager, config) => {
      if (submitted) {
        throw new Error("submit_page was already called for this page worker.");
      }
      try {
        const result = await submitPersonalPage(run, { jobId: job.id });
        submitted = true;
        return JSON.stringify(result);
      } catch (error) {
        if (
          error instanceof RepositoryRunError &&
          error.code === "invalid_input"
        ) {
          return createSubmissionRejection(
            "submit_page",
            error,
            "Correct the assigned page and call submit_page again.",
            getToolCallId(config),
          );
        }
        fatalSubmissionFailure = true;
        throw error;
      }
    },
  });

  const backend = createAgentBackend(new PersonalPageWorkerBackend(run, job));
  const agent = createDeepAgent({
    name: personalWorkerAgentName(job.path),
    model,
    tools: [...createPersonalRawEvidenceTools(run), submitPageTool],
    backend,
    middleware: [
      createFilesystemMiddleware({
        backend,
        permissions: AGENT_FILESYSTEM_PERMISSIONS,
        tools: PERSONAL_PAGE_TOOLS,
      }),
      NO_DELEGATION_MIDDLEWARE,
    ],
    subagents: [],
    permissions: AGENT_FILESYSTEM_PERMISSIONS,
    systemPrompt: createPersonalPagePrompt(
      job,
      view,
      run.state.plan?.pages ?? [],
      run.state.initialPages,
    ),
  });

  try {
    await streamWorkerTools(
      agent,
      [
        {
          role: "user",
          content: "Write the assigned page from its evidence, then submit it.",
        },
      ],
      resolveTraceThreadId(run.state.runId),
      parseWorkerToolEvent,
      onEvent,
      job.path,
    );
  } catch (error) {
    if (submitted) return { status: "submitted" };
    // The core refusing a submission would refuse a retry the same way.
    if (fatalSubmissionFailure) throw error;
    return { status: "failed", error };
  }

  return submitted ? { status: "submitted" } : { status: "failed" };
}

/**
 * Creates a wiki backend that refuses every write.
 */
function createReadOnlyWikiBackend(
  run: ActivePersonalRun,
): OpenWikiLocalShellBackend {
  return new OpenWikiLocalShellBackend({
    docsOnly: true,
    writableWikiPages: [],
    maxOutputBytes: 100_000,
    outputMode: "local-wiki",
    rootDir: run.wikiDir,
    timeout: 120,
    virtualMode: true,
  });
}

/**
 * Converts a correctable submission rejection into a failed tool result that
 * keeps the worker running.
 */
function createSubmissionRejection(
  toolName: "submit_plan" | "submit_page",
  error: RepositoryRunError,
  retry: string,
  toolCallId: string | undefined,
): ToolMessage {
  if (!toolCallId) {
    throw new Error(`${toolName} rejection requires an active tool call id.`);
  }
  return new ToolMessage({
    name: toolName,
    tool_call_id: toolCallId,
    status: "error",
    content: JSON.stringify({
      status: "rejected",
      code: error.code,
      message: error.message,
      retry,
    }),
  });
}

function getToolCallId(config: unknown): string | undefined {
  return (config as { toolCall?: { id?: string } } | undefined)?.toolCall?.id;
}

function emitText(
  onEvent: ((event: OpenWikiRunEvent) => void) | undefined,
  text: string,
): void {
  onEvent?.({ type: "text", source: "main", text });
}
