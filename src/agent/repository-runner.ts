import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ToolMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
import { z } from "zod";
import { resolveTraceThreadId } from "../config/constants.js";
import { RepositoryRunError } from "../generation/errors.js";
import {
  beginRepositoryRun,
  captureRepositoryPageSnapshot,
  finishRepositoryRun,
  inspectRepositoryPageClaims,
  nextRepositoryPage,
  restoreRepositoryPage,
  skipRepositoryPage,
  submitRepositoryPage,
  submitRepositoryPlan,
  type ActiveBeginView,
  type ActiveRepositoryRun,
  type BeginRepositoryRunResult,
  type NextRepositoryPageResult,
  type RepositoryPageSnapshot,
} from "../generation/repository-run.js";
import type { RepositoryRunMode } from "../generation/run-state.js";
import { OPENWIKI_PRODUCER_ACTOR } from "../version.js";
import {
  AGENT_FILESYSTEM_PERMISSIONS,
  createAgentBackend,
} from "./agent-backend.js";
import { OpenWikiLocalShellBackend } from "./docs-only-backend.js";
import { OpenWikiIgnore } from "./openwiki-ignore.js";
import {
  createWorkerToolEventParser,
  DEFAULT_WORKER_START_STAGGER_MS,
  NO_DELEGATION_MIDDLEWARE,
  runPageWorkers,
  streamWorkerTools,
  type PageWorkerAttemptOutcome,
} from "./page-workers.js";
import {
  createRepositoryPagePrompt,
  createRepositoryPlannerPrompt,
} from "./repository-prompts.js";
import type { OpenWikiRunEvent } from "./types.js";

const PlanPageSchema = z
  .object({
    path: z.string().trim().min(1),
    title: z.string().trim().min(1),
    purpose: z.string().trim().min(1),
    seedPaths: z.array(z.string().trim().min(1)).optional(),
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

const ClaimSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    statement: z.string().trim().min(1),
    evidence: z
      .array(z.object({ resource: z.string().trim().min(1) }).strict())
      .min(1),
  })
  .strict();

const ClaimReconciliationSchema = z
  .object({
    confirmedClaimIds: z.array(z.string().trim().min(1)).optional(),
    claims: z.array(ClaimSchema).optional(),
    retractedClaimIds: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

const PLANNER_FILESYSTEM_TOOLS = ["read_file", "ls", "glob", "grep"] as const;
const PAGE_FILESYSTEM_TOOLS = [
  ...PLANNER_FILESYSTEM_TOOLS,
  "write_file",
  "edit_file",
] as const;
const WORKER_TOOL_NAMES = new Set<string>([
  ...PAGE_FILESYSTEM_TOOLS,
  "submit_plan",
  "inspect_claims",
  "submit_page",
]);

/**
 * Normalizes a DeepAgents tools-stream chunk from an approved worker tool.
 *
 * @param chunk - Unknown streamed graph chunk.
 * @returns Bounded tool lifecycle event or `null` for narration/unknown tools.
 */
export const parseWorkerToolEvent =
  createWorkerToolEventParser(WORKER_TOOL_NAMES);

type PendingPageJob = Extract<
  NextRepositoryPageResult,
  { status: "pending" }
>["job"];

/**
 * Converts a bounded submission rejection into a failed tool result.
 *
 * @param toolName - Completion tool that rejected the model payload.
 * @param error - Repository lifecycle error returned to the worker.
 * @param retry - Concrete next-step instruction shown to the worker.
 * @param toolCallId - LangChain identifier for the active tool call.
 * @returns Error-status tool message that keeps the worker loop active.
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

/**
 * Inputs for one native repository-generation command.
 */
export interface NativeRepositoryGenerationOptions {
  /**
   * Absolute Git repository root owned by the run.
   */
  root: string;

  /**
   * Repository generation command to execute or resume.
   */
  mode: RepositoryRunMode;

  /**
   * Requested output language, resolved by the durable lifecycle.
   */
  language?: string | null;

  /**
   * Whether strict update no-op detection must be bypassed.
   */
  force?: boolean;

  /**
   * Actual user and connector context supplied to planning.
   */
  planningContext?: string | null;

  /**
   * Stable model identity written to repository run metadata.
   */
  modelId: string;

  /**
   * Initialized chat model reused by fresh planner and page workers.
   */
  model: BaseChatModel;

  /**
   * Maximum page workers running at once.
   *
   * Each worker still owns exactly one page. With more than one worker the
   * quickstart page is held back until every other page has finished, so its
   * task-routing map links to pages that exist. A worker that fails on a
   * provider rate limit lowers the live limit by one, never below 1.
   *
   * @default 1
   */
  pageConcurrency?: number;

  /**
   * Delay between the first wave of worker starts, per slot, in milliseconds.
   *
   * Spreads the opening model requests of concurrent workers so they do not
   * hit the provider at the same instant. Ignored for a single worker.
   *
   * @default 1000
   */
  workerStartStaggerMs?: number;

  /**
   * Optional lifecycle and bounded worker-tool event consumer.
   */
  onEvent?: (event: OpenWikiRunEvent) => void;
}

/**
 * Observable result of one native repository-generation command.
 */
export interface NativeRepositoryGenerationResult {
  /**
   * Whether strict preflight proved that an update required no generation.
   */
  skipped: boolean;

  /**
   * Whether the repository changed after planning, leaving a later update due.
   */
  sourceChanged?: true;
}

/**
 * Drives the shared lifecycle with one planner and one fresh agent per page.
 *
 * The supplied model is reused, but no repository-generation checkpointer or
 * worker state survives beyond the durable core.
 *
 * @param options - Repository, model, planning context, and event consumer.
 * @returns No-op status and whether a later update remains due to source drift.
 */
export async function runNativeRepositoryGeneration(
  options: NativeRepositoryGenerationOptions,
): Promise<NativeRepositoryGenerationResult> {
  const begun = await beginNativeRepositoryRun(options);
  if (!("run" in begun)) {
    options.onEvent?.({ type: "repository_progress", stage: "noop" });
    return { skipped: true };
  }

  const { run, view } = begun;
  if (run.state.phase === "planning") {
    options.onEvent?.({
      type: "repository_progress",
      stage: "planning",
      resumed: view.resumed,
    });
    await runPlanningAgent(
      run,
      view,
      options.model,
      run.state.planningContext,
      options.onEvent,
    );
  }

  const skippedPageSnapshots = await runPendingPageAgents(
    run,
    options.model,
    options.onEvent,
    view,
    options.pageConcurrency ?? 1,
    options.workerStartStaggerMs ?? DEFAULT_WORKER_START_STAGGER_MS,
  );
  options.onEvent?.({
    type: "repository_progress",
    stage: "finalizing",
    resumed: view.resumed,
    pageCount: run.state.plan?.pages.length,
  });

  const result = await finishRepositoryRun(run, {
    skippedPageSnapshots,
    onEvent: options.onEvent,
  });
  if (result.sourceChanged) {
    options.onEvent?.({
      type: "text",
      source: "main",
      text: "Repository source changed while OpenWiki was running. The wiki was finalized without advancing its source checkpoint; run openwiki --update to reconcile the changes.\n",
    });
  }
  return result.sourceChanged
    ? { skipped: false, sourceChanged: true }
    : { skipped: false };
}

/**
 * Begins or reconstructs the durable lifecycle with a stable producer actor.
 *
 * @param options - Native runner options preserved across source-drift replans.
 * @returns Active or strict no-op begin result.
 */
async function beginNativeRepositoryRun(
  options: NativeRepositoryGenerationOptions,
): Promise<BeginRepositoryRunResult> {
  return beginRepositoryRun({
    root: options.root,
    mode: options.mode,
    language: options.language ?? undefined,
    force: options.force,
    planningContext: options.planningContext ?? undefined,
    actor: {
      producerActor: OPENWIKI_PRODUCER_ACTOR,
      metadataModel: options.modelId,
    },
  });
}

/**
 * Runs one bounded planner that must submit a durable plan.
 *
 * @param run - Active durable repository run.
 * @param view - Current host-facing planning context.
 * @param model - Initialized model used only for this worker.
 * @param planningContext - Actual user and connector planning context.
 * @param onEvent - Optional bounded worker event consumer.
 */
async function runPlanningAgent(
  run: ActiveRepositoryRun,
  view: ActiveBeginView,
  model: BaseChatModel,
  planningContext?: string,
  onEvent?: (event: OpenWikiRunEvent) => void,
): Promise<void> {
  const ignore = await OpenWikiIgnore.load(run.root);
  const wikiBackend = new OpenWikiLocalShellBackend({
    docsOnly: true,
    writableWikiPages: [],
    openWikiIgnore: ignore,
    maxOutputBytes: 100_000,
    outputMode: "repository",
    rootDir: run.root,
    timeout: 120,
    virtualMode: true,
  });

  let submitted = false;
  const submitPlanTool = new DynamicStructuredTool({
    name: "submit_plan",
    description:
      "Submit the final canonical OpenWiki page plan. This is the only completion action for planning.",
    schema: PlanSchema,
    func: async (input, _runManager, config) => {
      try {
        const result = await submitRepositoryPlan(run, input);
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
            (config as { toolCall?: { id?: string } } | undefined)?.toolCall
              ?.id,
          );
        }
        if (
          error instanceof RepositoryRunError &&
          error.code === "invalid_state" &&
          submitted &&
          run.state.plan
        ) {
          return createSubmissionRejection(
            "submit_plan",
            error,
            "A plan is already installed. Stop planning and do not call submit_plan again.",
            (config as { toolCall?: { id?: string } } | undefined)?.toolCall
              ?.id,
          );
        }
        throw error;
      }
    },
  });

  const backend = createAgentBackend(wikiBackend);
  const agent = createDeepAgent({
    name: PLANNER_AGENT_NAME,
    model,
    tools: [submitPlanTool],
    backend,
    middleware: [
      createFilesystemMiddleware({
        backend,
        permissions: AGENT_FILESYSTEM_PERMISSIONS,
        tools: PLANNER_FILESYSTEM_TOOLS,
      }),
      NO_DELEGATION_MIDDLEWARE,
    ],
    skills: ["/skills/"],
    subagents: [],
    permissions: AGENT_FILESYSTEM_PERMISSIONS,
    systemPrompt: createRepositoryPlannerPrompt(view, planningContext),
  });

  await streamWorkerTools(
    agent,
    [{ role: "user", content: "Plan this repository wiki now." }],
    resolveTraceThreadId(run.state.runId),
    parseWorkerToolEvent,
    onEvent,
  );

  if (!submitted || !run.state.plan) {
    throw new Error("Repository planning worker exited without submit_plan.");
  }
}

/** The planner's trace name in LangSmith (otherwise the graph default, "LangGraph"). */
export const PLANNER_AGENT_NAME = "planning agent";

/**
 * A page worker's trace name in LangSmith: the page it owns, so a run's thread
 * reads as one planner and one worker per page.
 *
 * @param page - Canonical page path, such as `/openwiki/coverage/forms/ho-3.md`.
 */
export function workerAgentName(page: string): string {
  return `worker agent: ${page.replace(/^\/openwiki\//u, "").replace(/\.md$/u, "")}`;
}

const QUICKSTART_PAGE_PATH = "/openwiki/quickstart.md";

/**
 * Runs every remaining page job with fresh bounded workers, up to
 * `pageConcurrency` at a time.
 *
 * Every page except quickstart is documented first. With one worker the
 * queue order already places quickstart last; with several, it is held back
 * explicitly so its task-routing map links to pages that already exist. A
 * fatal submission error stops new work, lets in-flight workers submit or
 * skip, and is rethrown before finish so the run never finalizes with
 * pending jobs.
 *
 * @param run - Active run containing the persisted queue.
 * @param model - Initialized model reused across fresh workers.
 * @param onEvent - Optional lifecycle and tool-event consumer.
 * @param view - Begin view used to retain resume state in progress events.
 * @param pageConcurrency - Maximum workers running at once.
 * @param workerStartStaggerMs - Per-slot delay for the first wave of starts.
 * @returns Snapshots of every page skipped during this pass.
 */
async function runPendingPageAgents(
  run: ActiveRepositoryRun,
  model: BaseChatModel,
  onEvent: ((event: OpenWikiRunEvent) => void) | undefined,
  view: ActiveBeginView,
  pageConcurrency: number,
  workerStartStaggerMs: number,
): Promise<RepositoryPageSnapshot[]> {
  const pages = run.state.plan?.pages ?? [];
  return runPageWorkers<PendingPageJob, RepositoryPageSnapshot>(
    {
      next: (options) => nextRepositoryPage(run, options),
      snapshot: (jobId) => captureRepositoryPageSnapshot(run, jobId),
      restore: (snapshot) => restoreRepositoryPage(run, snapshot),
      skip: (snapshot) => skipRepositoryPage(run, snapshot),
      attempt: (job) => runPageWorkerAttempt(run, job, model, onEvent),
    },
    {
      concurrency: pageConcurrency,
      workerStartStaggerMs,
      finalJobIds: new Set(
        pages
          .filter(({ path }) => path === QUICKSTART_PAGE_PATH)
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
 *
 * A single worker emits exactly the historical shape. A concurrent pool adds
 * the completed count and the in-flight page list so consumers can render the
 * run without pretending one queue position describes it.
 */
function emitGeneratingProgress(
  run: ActiveRepositoryRun,
  view: ActiveBeginView,
  focusPage: string | undefined,
  inFlightPages: readonly string[] | undefined,
  onEvent: ((event: OpenWikiRunEvent) => void) | undefined,
): void {
  const pages = run.state.plan?.pages ?? [];
  const pageIndex = pages.findIndex(({ path }) => path === focusPage) + 1;
  onEvent?.({
    type: "repository_progress",
    stage: "generating",
    resumed: view.resumed,
    page: focusPage,
    pageIndex,
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
 * Runs one bounded worker attempt for the current page job.
 *
 * @param run - Active durable repository run.
 * @param job - Pending page job owned by this worker.
 * @param model - Initialized model used only for this attempt.
 * @param onEvent - Optional bounded worker event consumer.
 * @returns Whether this attempt submitted the page, or its skip outcome.
 */
async function runPageWorkerAttempt(
  run: ActiveRepositoryRun,
  job: PendingPageJob,
  model: BaseChatModel,
  onEvent?: (event: OpenWikiRunEvent) => void,
): Promise<PageWorkerAttemptOutcome> {
  const ignore = await OpenWikiIgnore.load(run.root);
  const wikiBackend = new OpenWikiLocalShellBackend({
    docsOnly: true,
    writableWikiPages: [job.path],
    openWikiIgnore: ignore,
    maxOutputBytes: 100_000,
    outputMode: "repository",
    rootDir: run.root,
    timeout: 120,
    virtualMode: true,
  });

  let submitted = false;
  let fatalSubmissionFailure = false;
  const inspectClaimsTool = new DynamicStructuredTool({
    name: "inspect_claims",
    description:
      "Return this page's complete current Claim set without opaque evidence versions. Use only before intentionally revising or removing otherwise-current content; stale or unresolved Claims already appear in the assignment.",
    schema: z.object({}).strict(),
    func: () =>
      Promise.resolve(JSON.stringify(inspectRepositoryPageClaims(run, job.id))),
  });
  const submitPageTool = new DynamicStructuredTool({
    name: "submit_page",
    description:
      "Complete the assigned page after writing it. Submit only sparse Claim decisions: confirmedClaimIds for rechecked issue Claims kept unchanged, claims for revisions/additions, and retractedClaimIds for removals. Other current Claims are retained automatically. Evidence must use repo://<repository-relative-path>, optionally with #Lx-Ly.",
    schema: ClaimReconciliationSchema,
    func: async (reconciliation, _runManager, config) => {
      if (submitted) {
        throw new Error("submit_page was already called for this page worker.");
      }
      try {
        const result = await submitRepositoryPage(run, {
          jobId: job.id,
          ...reconciliation,
        });
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
            "Correct the assigned page or sparse Claim decisions and call submit_page again.",
            (config as { toolCall?: { id?: string } } | undefined)?.toolCall
              ?.id,
          );
        }
        fatalSubmissionFailure = true;
        throw error;
      }
    },
  });

  const backend = createAgentBackend(wikiBackend);
  const agent = createDeepAgent({
    name: workerAgentName(job.path),
    model,
    tools: [inspectClaimsTool, submitPageTool],
    backend,
    middleware: [
      createFilesystemMiddleware({
        backend,
        permissions: AGENT_FILESYSTEM_PERMISSIONS,
        tools: PAGE_FILESYSTEM_TOOLS,
      }),
      NO_DELEGATION_MIDDLEWARE,
    ],
    skills: ["/skills/"],
    subagents: [],
    permissions: AGENT_FILESYSTEM_PERMISSIONS,
    systemPrompt: createRepositoryPagePrompt(
      job,
      run.state.plan?.pages ?? [],
      run.state.language,
    ),
  });

  try {
    await streamWorkerTools(
      agent,
      [
        {
          role: "user",
          content: "Research and document the assigned page, then submit it.",
        },
      ],
      resolveTraceThreadId(run.state.runId),
      parseWorkerToolEvent,
      onEvent,
      job.path,
    );
  } catch (error) {
    if (submitted) return { status: "submitted" };
    // A fatal submission failure is not retried: the store itself is refusing,
    // so a second attempt would fail the same way and the run should stop.
    if (fatalSubmissionFailure) throw error;
    return { status: "failed", error };
  }

  if (submitted) return { status: "submitted" };

  return { status: "failed" };
}
