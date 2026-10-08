import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { OpenWikiLocalShellBackend } from "../agent/docs-only-backend.js";
import type { RunContext } from "../agent/types.js";
import {
  createOpenWikiContentSnapshot,
  createRunContext,
  writeLastUpdateMetadata,
} from "../agent/utils.js";
import {
  deserializePreparedWikiState,
  finalizeWikiArtifacts,
  prepareWikiForAuthoring,
  serializePreparedWikiState,
} from "../agent/wiki-finalizer.js";
import { ClaimsStore } from "../claims/brains/code/store.js";
import {
  getConnectorRawDir,
  openWikiLocalWikiDir,
} from "../config/openwiki-home.js";
import {
  repairPersistedFile,
  type FrontmatterIssue,
} from "../okf/frontmatter.js";
import {
  resolveConceptTypeLabel,
  resolveIndexLabels,
} from "../okf/index-labels.js";
import { isFileNotFoundError } from "../platform/fs-errors.js";
import {
  getPrimaryLanguageSubtag,
  requireResolvedLanguage,
  resolveLanguage,
} from "../platform/language.js";
import { readOpenWikiOnboardingConfig } from "../setup/onboarding.js";
import { RepositoryRunError } from "./errors.js";
import {
  acquirePersonalRunLock,
  parsePersonalRunLockHolder,
  releasePersonalRunLock,
  renewPersonalRunLock,
} from "./personal-run-lock.js";
import {
  PERSONAL_OPEN_QUESTIONS_PAGE,
  createPersonalPlan,
  extractActiveSection,
  isCanonicalPersonalPagePath,
  samePersonalPlan,
  type ProposedPersonalPlan,
} from "./personal-run-plan.js";
import {
  AGENTIC_PERSONAL_CONNECTORS,
  CONNECTOR_ID_PATTERN,
  RAW_RUN_ID_PATTERN,
  parseRawEvidenceRef,
  readPersonalRunState,
  readSynthesisCursor,
  removePersonalRunState,
  writePersonalRunState,
  writeSynthesisCursor,
  type PersonalFrontierEntry,
  type PersonalPageJob,
  type PersonalRunActor,
  type PersonalRunMode,
  type PersonalRunPhase,
  type PersonalRunScope,
  type PersonalRunState,
  type SynthesisCursor,
} from "./personal-run-state.js";
import {
  isNotFoundBackendError,
  readPageMarkdownSnapshot,
  restorePageMarkdown,
} from "./shared/page-snapshot.js";
import { requirePendingJob } from "./shared/pending-job.js";
import { withRunMutation } from "./shared/run-mutation.js";

/**
 * Virtual page prefix of the personal wiki, which is rooted at its directory.
 */
const PERSONAL_PAGE_PREFIX = "/";

/**
 * Inputs required to start or resume one personal run.
 */
export interface BeginPersonalRunInput {
  /**
   * Command to start or resume.
   */
  mode: PersonalRunMode;

  /**
   * Narrowing of connectors and pages for a new run.
   *
   * @default undefined - every connected source and no page restriction.
   */
  scope?: PersonalRunScope;

  /**
   * Requested language, resolved before anything is written.
   *
   * @default undefined - the wiki's persisted language, or English.
   */
  language?: string;

  /**
   * User request text.
   *
   * @default undefined - none.
   */
  instruction?: string;

  /**
   * Producer and metadata identities for the current session.
   */
  actor: PersonalRunActor;

  /**
   * Lock holder ID, `<driver>:<hostname>:<pid>`.
   */
  holder: string;

  /**
   * Whether an expired lock may be taken over. Interactive drivers pass it
   * only after the user confirms; scheduled ingestion never does.
   *
   * @default false
   */
  takeover?: boolean;

  /**
   * Deterministic clock used by tests.
   *
   * @default () => new Date()
   */
  now?: () => Date;
}

/**
 * Process-local runtime rebuilt from one durable personal checkpoint.
 */
export interface ActivePersonalRun {
  /**
   * Personal wiki directory owned by the run.
   */
  wikiDir: string;

  /**
   * Lock holder ID of this process.
   */
  holder: string;

  /**
   * Current authoritative state, replaced only after persistence succeeds.
   */
  state: PersonalRunState;

  /**
   * Wiki backend used by code-owned lifecycle work.
   */
  backend: OpenWikiLocalShellBackend;
}

/**
 * Markdown of one page captured before model-owned work.
 */
export interface PersonalPageSnapshot {
  /**
   * Job the snapshot belongs to.
   */
  jobId: string;

  /**
   * Canonical virtual page path.
   */
  path: string;

  /**
   * Page content before the worker started, or `null` when it did not exist.
   */
  markdown: string | null;
}

/**
 * Driver-facing view of an active run.
 */
export interface PersonalBeginView {
  /**
   * Discriminator for a run that needs driver work.
   */
  status: "active";

  /**
   * UUID required by subsequent operations.
   */
  runId: string;

  /**
   * Command being executed.
   */
  mode: PersonalRunMode;

  /**
   * Current durable phase.
   */
  phase: PersonalRunPhase;

  /**
   * Resolved language.
   */
  language: string;

  /**
   * Whether the language differs from the last completed run.
   */
  languageChanged: boolean;

  /**
   * Whether this view reconstructs an interrupted run.
   */
  resumed: boolean;

  /**
   * Metadata of the run before this one, when present.
   */
  lastUpdate: RunContext["lastUpdate"];

  /**
   * Contents of `<home>/INSTRUCTIONS.md`.
   */
  wikiGoal?: string;

  /**
   * User request text.
   */
  instruction?: string;

  /**
   * Narrowing of connectors and pages.
   */
  scope?: PersonalRunScope;

  /**
   * The evidence frontier the run consumes.
   */
  frontier: PersonalFrontierEntry[];

  /**
   * Conditions the driver should report, such as dropped raw runs.
   */
  warnings: string[];

  /**
   * Number of page jobs already completed.
   */
  completedPages: number;

  /**
   * Total page jobs, absent until a plan is accepted.
   */
  totalPages?: number;
}

/**
 * Result of an update with nothing to synthesize.
 */
export interface PersonalNoopView {
  /**
   * Discriminator for an update that needs no driver work.
   */
  status: "noop";

  /**
   * Fixed mode for no-op results.
   */
  mode: "update";

  /**
   * Resolved language recorded in `.last-update.json`.
   */
  language: string;

  /**
   * Conditions the driver should report.
   */
  warnings: string[];
}

/**
 * Result of beginning or resuming a run, or of a no-op update.
 */
export type BeginPersonalRunResult =
  | { view: PersonalBeginView; run: ActivePersonalRun }
  | { view: PersonalNoopView };

/**
 * Result of a finished run.
 */
export interface FinishPersonalRunResult {
  /**
   * Fixed completion discriminator.
   */
  status: "complete";

  /**
   * Status written to `.last-update.json`: `interrupted` when a job was
   * skipped.
   */
  lastUpdateStatus: "complete" | "interrupted";

  /**
   * Connectors whose synthesis cursor advanced.
   */
  advancedConnectors: string[];

  /**
   * Connectors with frontier evidence whose cursor stayed, because a job
   * seeded with their evidence was skipped.
   */
  heldConnectors: string[];
}

/**
 * Starts a new run or resumes the active one.
 *
 * The lock is acquired before any state is read. Every failure after that
 * releases it again; durable run state is kept, so the run stays resumable.
 *
 * @param input - Mode, scope, language, request, actor, and lock holder.
 * @returns The active run and its view, or a no-op for an update with no
 *   evidence, no request, and no rewrites.
 */
export async function beginPersonalRun(
  input: BeginPersonalRunInput,
): Promise<BeginPersonalRunResult> {
  const now = input.now ?? (() => new Date());
  // Reject an unrecognized language before touching the wiki. Resume refuses
  // to change a started run's language, so persisting a typo would strand it.
  const resolvedRequest = resolveLanguage(input.language);
  if (resolvedRequest.kind === "unrecognized") {
    throw new RepositoryRunError("invalid_input", resolvedRequest.message);
  }
  parsePersonalRunLockHolder(input.holder);
  const scope = normalizeScope(input.scope);
  const instruction = input.instruction?.trim() || undefined;
  const wikiDir = openWikiLocalWikiDir;
  await mkdir(wikiDir, { recursive: true, mode: 0o700 });

  // The active run's ID is read before locking only to label the lock, so a
  // holder that begins again keeps its lock pointed at its own run. State is
  // read again under the lock before anything is decided.
  const active = await readPersonalRunState(wikiDir);
  const { alreadyHeld } = await acquirePersonalRunLock(wikiDir, {
    holder: input.holder,
    runId: active?.runId ?? randomUUID(),
    takeover: input.takeover,
    now,
  });
  try {
    const persisted = await readPersonalRunState(wikiDir);
    const result = persisted
      ? await resumePersonalRun(wikiDir, input, instruction, persisted)
      : await startPersonalRun(wikiDir, input, scope, instruction);
    if (result.view.status === "noop") {
      if (!alreadyHeld) await releasePersonalRunLock(wikiDir, input.holder);
    } else {
      await acquirePersonalRunLock(wikiDir, {
        holder: input.holder,
        runId: result.view.runId,
        now,
      });
    }
    return result;
  } catch (error) {
    // A lock this holder held before the call still covers its active run.
    if (!alreadyHeld) await releasePersonalRunLock(wikiDir, input.holder);
    throw error;
  }
}

/**
 * Computes the frontier and writes a new run, or proves an update no-op.
 */
async function startPersonalRun(
  wikiDir: string,
  input: BeginPersonalRunInput,
  scope: PersonalRunScope | undefined,
  instruction: string | undefined,
): Promise<BeginPersonalRunResult> {
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const context = await createRunContext(wikiDir, "local-wiki", input.language);
  const language = context.language ?? "en";
  const requestedLanguage = requireResolvedLanguage(input.language);
  const languageChanged =
    requestedLanguage !== undefined &&
    getPrimaryLanguageSubtag(requestedLanguage) !==
      getPrimaryLanguageSubtag(context.lastUpdate?.language);

  const cursor = await readSynthesisCursor(wikiDir);
  const { connectors, warnings } = await resolveInScopeConnectors(scope);
  const frontier = await computePersonalFrontier(connectors, cursor);
  const initialPages = await new ClaimsStore(
    wikiDir,
    PERSONAL_PAGE_PREFIX,
  ).discoverPages();
  const requiredRewritePages =
    input.mode === "update" && languageChanged ? initialPages : [];

  if (
    input.mode === "update" &&
    !instruction &&
    isFrontierEmpty(frontier) &&
    requiredRewritePages.length === 0
  ) {
    await writeLastUpdateMetadata(
      "update",
      wikiDir,
      context.lastUpdate?.model ?? input.actor.metadataModel,
      "local-wiki",
      "complete",
      language,
    );
    return { view: { status: "noop", mode: "update", language, warnings } };
  }

  const beforeContentSnapshot = await createOpenWikiContentSnapshot(
    wikiDir,
    "local-wiki",
  );
  const backend = createPersonalBackend(wikiDir);
  const preparedWiki = await prepareWikiForAuthoring({
    backend,
    outputMode: "local-wiki",
    conceptType: resolveConceptTypeLabel(language),
  });
  const gathering = frontier.some(({ frozen }) => !frozen);

  const state: PersonalRunState = {
    schemaVersion: 1,
    kind: "personal",
    runId: randomUUID(),
    mode: input.mode,
    phase: gathering ? "gathering" : "planning",
    startedAt,
    language,
    languageChanged,
    requiredRewritePages,
    initialPages,
    frontier,
    ...(scope ? { scope } : {}),
    ...(instruction ? { instruction } : {}),
    actor: { ...input.actor },
    previousLastUpdate: context.lastUpdate,
    ...(context.wikiGoal ? { wikiGoal: context.wikiGoal } : {}),
    beforeContentSnapshot,
    preparedWiki: serializePreparedWikiState(preparedWiki),
  };

  // The durability point: from here on the run is resumable.
  await writePersonalRunState(wikiDir, state);
  await writeLastUpdateMetadata(
    input.mode,
    wikiDir,
    input.actor.metadataModel,
    "local-wiki",
    "interrupted",
    language,
  );

  const run: ActivePersonalRun = {
    wikiDir,
    holder: input.holder,
    state,
    backend,
  };
  return { run, view: toBeginView(run, false, warnings) };
}

/**
 * Rebuilds an interrupted run; skipped jobs return to pending.
 */
async function resumePersonalRun(
  wikiDir: string,
  input: BeginPersonalRunInput,
  instruction: string | undefined,
  state: PersonalRunState,
): Promise<BeginPersonalRunResult> {
  if (state.mode !== input.mode) {
    throw new RepositoryRunError(
      "conflict",
      `An interrupted OpenWiki personal ${state.mode} run already exists. Resume that run before starting ${input.mode}.`,
    );
  }
  const requestedLanguage = requireResolvedLanguage(input.language);
  if (requestedLanguage && requestedLanguage !== state.language) {
    throw new RepositoryRunError(
      "conflict",
      `Interrupted OpenWiki personal run uses ${state.language}; resume it before changing the wiki language to ${requestedLanguage}.`,
    );
  }

  const { frontier, warnings } = await dropDeletedRawRuns(state.frontier);
  const nextState: PersonalRunState = {
    ...state,
    frontier,
    actor: { ...input.actor },
    ...(state.plan
      ? {
          plan: {
            ...state.plan,
            pages: state.plan.pages.map((page) =>
              page.status === "skipped"
                ? { ...page, status: "pending" as const }
                : page,
            ),
          },
        }
      : {}),
    // A new request may replace the old one only while nothing was planned
    // from it.
    ...(!state.plan && instruction ? { instruction } : {}),
  };
  if (JSON.stringify(nextState) !== JSON.stringify(state)) {
    await writePersonalRunState(wikiDir, nextState);
  }

  const run: ActivePersonalRun = {
    wikiDir,
    holder: input.holder,
    state: nextState,
    backend: createPersonalBackend(wikiDir),
  };
  return { run, view: toBeginView(run, true, warnings) };
}

/**
 * Ends gathering: adds the raw runs that agentic connectors wrote since the
 * run began, freezes every entry, and moves the run to planning.
 *
 * @param run - Active run in the gathering phase.
 * @returns The frozen frontier.
 */
export async function closePersonalGathering(
  run: ActivePersonalRun,
): Promise<{ phase: "planning"; frontier: PersonalFrontierEntry[] }> {
  return withRunMutation(run, async () => {
    await renewHeldLock(run);
    if (run.state.phase !== "gathering") {
      throw new RepositoryRunError(
        "invalid_state",
        `OpenWiki can close gathering only in the gathering phase, not ${run.state.phase}.`,
      );
    }

    const startedRunId = toRawRunId(run.state.startedAt);
    const frontier: PersonalFrontierEntry[] = [];
    for (const entry of run.state.frontier) {
      if (entry.frozen) {
        frontier.push(entry);
        continue;
      }
      const known = new Set(entry.rawRunIds);
      const gathered = (await listRawRunIds(entry.connectorId)).filter(
        (rawRunId) => rawRunId >= startedRunId && !known.has(rawRunId),
      );
      const rawRunIds = [...entry.rawRunIds, ...gathered].sort(
        compareCodeUnits,
      );
      frontier.push({
        connectorId: entry.connectorId,
        rawRunIds,
        rawFiles: [
          ...entry.rawFiles,
          ...(await listRawFiles(entry.connectorId, gathered)),
        ].sort(compareCodeUnits),
        frozen: true,
      });
    }

    const nextState: PersonalRunState = {
      ...run.state,
      phase: "planning",
      frontier,
    };
    await writePersonalRunState(run.wikiDir, nextState);
    run.state = nextState;
    return { phase: "planning" as const, frontier };
  });
}

/**
 * Validates a plan, adds the required jobs, orders the queue, and moves the
 * run to generating.
 *
 * Submitting the same plan again is accepted without change, so a driver may
 * retry a call whose response it lost.
 *
 * @param run - Active run in the planning phase.
 * @param input - Planner submission.
 * @returns Accepted queue in order.
 * @throws RepositoryRunError (`invalid_input`) for a plan that breaks a §3.3
 *   rule; nothing is written and the driver resubmits.
 */
export async function submitPersonalPlan(
  run: ActivePersonalRun,
  input: ProposedPersonalPlan,
): Promise<{ status: "accepted"; totalPages: number; pages: string[] }> {
  return withRunMutation(run, async () => {
    await renewHeldLock(run);
    const accepted = (plan: NonNullable<PersonalRunState["plan"]>) => ({
      status: "accepted" as const,
      totalPages: plan.pages.length,
      pages: plan.pages.map(({ path: page }) => page),
    });

    if (run.state.plan) {
      // Never silently replace a persisted plan.
      const proposed = createPersonalPlan(run.state, input);
      if (!samePersonalPlan(run.state.plan, proposed)) {
        throw new RepositoryRunError(
          "invalid_state",
          "This OpenWiki personal run already has a different plan.",
        );
      }
      return accepted(run.state.plan);
    }
    if (run.state.phase !== "planning") {
      throw new RepositoryRunError(
        "invalid_state",
        `OpenWiki accepts a plan only in the planning phase, not ${run.state.phase}.`,
      );
    }

    const plan = createPersonalPlan(run.state, input);
    const nextState: PersonalRunState = {
      ...run.state,
      phase: "generating",
      plan,
    };
    await writePersonalRunState(run.wikiDir, nextState);
    run.state = nextState;
    return accepted(plan);
  });
}

/**
 * Page job handed to a worker, with the page's current version.
 */
export interface PersonalPageJobView extends PersonalPageJob {
  /**
   * Command being executed.
   */
  mode: PersonalRunMode;

  /**
   * Whether the page exists on disk.
   */
  existing: boolean;

  /**
   * `sha256:` digest of the page's current bytes, or `"absent"`. The
   * `baseVersion` of the job's first write.
   */
  pageVersion: string;

  /**
   * Body of the page's Active section, for a maintenance job only.
   *
   * @default undefined - not a maintenance job.
   */
  activeEntries?: string | null;

  /**
   * Pages completed earlier in this run, for a maintenance job only.
   *
   * @default undefined - not a maintenance job.
   */
  changedPages?: string[];
}

/**
 * Next pending job, or queue completion.
 */
export type NextPersonalPageResult =
  { status: "pending"; job: PersonalPageJobView } | { status: "complete" };

/**
 * Returns the first pending job not excluded, without reserving it.
 *
 * @param run - Active run in the generating phase.
 * @param options - Job IDs already owned by this driver's in-flight workers.
 * @returns The job with its page version, or completion when none remains.
 */
export async function nextPersonalPage(
  run: ActivePersonalRun,
  options: { exclude?: ReadonlySet<string> } = {},
): Promise<NextPersonalPageResult> {
  await renewHeldLock(run);
  const plan = requireGeneratingPlan(run);
  const exclude = options.exclude ?? new Set<string>();
  const job = plan.pages.find(
    ({ id, status }) => status === "pending" && !exclude.has(id),
  );
  if (!job) return { status: "complete" };

  const markdown = await readPageMarkdownSnapshot(run.backend, job.path);
  const view: PersonalPageJobView = {
    ...job,
    mode: run.state.mode,
    existing: markdown !== null,
    pageVersion: toPageVersion(markdown),
  };
  if (job.maintenance) {
    view.activeEntries =
      markdown === null ? null : extractActiveSection(markdown);
    view.changedPages = plan.pages
      .filter(({ id, status }) => status === "complete" && id !== job.id)
      .map(({ path: page }) => page);
  }
  return { status: "pending", job: view };
}

/**
 * Reads the Active section of `/open-questions.md`.
 *
 * @param wikiDir - Personal wiki directory.
 * @returns The section body, or `null` when the page or section is absent.
 */
export async function readPersonalOpenQuestions(
  wikiDir: string = openWikiLocalWikiDir,
): Promise<string | null> {
  const markdown = await readPageMarkdownSnapshot(
    createPersonalBackend(wikiDir),
    PERSONAL_OPEN_QUESTIONS_PAGE,
  );
  return markdown === null ? null : extractActiveSection(markdown);
}

/**
 * Captures one pending page before model-owned work.
 */
export async function capturePersonalPageSnapshot(
  run: ActivePersonalRun,
  jobId: string,
): Promise<PersonalPageSnapshot> {
  await renewHeldLock(run);
  const job = requirePendingJob(run.state.plan?.pages, jobId, "snapshotted");
  return {
    jobId: job.id,
    path: job.path,
    markdown: await readPageMarkdownSnapshot(run.backend, job.path),
  };
}

/**
 * Rolls one pending page back to its snapshot between worker attempts,
 * leaving the job pending.
 */
export async function restorePersonalPage(
  run: ActivePersonalRun,
  snapshot: PersonalPageSnapshot,
): Promise<void> {
  await renewHeldLock(run);
  requireSnapshotJob(run, snapshot);
  await restorePageMarkdown(run.backend, snapshot);
}

/**
 * Gives up on a page job: restores its snapshot and marks it skipped.
 *
 * A skipped job returns to pending when the run is resumed, and `finish`
 * holds the cursor of every connector whose evidence it was seeded with.
 */
export async function skipPersonalPage(
  run: ActivePersonalRun,
  snapshot: PersonalPageSnapshot,
): Promise<void> {
  await withRunMutation(run, async () => {
    await renewHeldLock(run);
    requireSnapshotJob(run, snapshot);
    await restorePageMarkdown(run.backend, snapshot);

    const plan = requireGeneratingPlan(run);
    const nextState: PersonalRunState = {
      ...run.state,
      plan: {
        ...plan,
        pages: plan.pages.map((page) =>
          page.id === snapshot.jobId
            ? { ...page, status: "skipped" as const }
            : page,
        ),
      },
    };
    await writePersonalRunState(run.wikiDir, nextState);
    run.state = nextState;
  });
}

/**
 * Result of a page write.
 */
export interface PersonalPageWriteResult {
  /**
   * Page the job owns.
   */
  page: string;

  /**
   * UTF-8 size of the page after front-matter repair.
   */
  bytes: number;

  /**
   * Version after the write, the `baseVersion` of the job's next write.
   */
  version: string;

  /**
   * Front-matter state after repair. `submit` rejects an invalid page.
   */
  frontmatter: {
    valid: boolean;
    repaired: boolean;
    issues: FrontmatterIssue[];
  };
}

/**
 * Replaces a pending job's page, if it is still at `baseVersion`, then repairs
 * its front matter.
 *
 * @param run - Active run in the generating phase.
 * @param input - Job, the version the content was based on, and the content.
 * @returns The new version and front-matter state.
 * @throws RepositoryRunError (`conflict`) when the page changed since
 *   `baseVersion`; the page is left unchanged.
 */
export async function writePersonalPage(
  run: ActivePersonalRun,
  input: { jobId: string; baseVersion: string; content: string },
): Promise<PersonalPageWriteResult> {
  const { job, backend } = await preparePageWrite(run, input);
  const result = await backend.write(job.path, input.content);
  if (result.error) {
    throw new RepositoryRunError(
      "invalid_input",
      `Could not write ${job.path}: ${result.error}`,
    );
  }
  return completePageWrite(run, job, backend);
}

/**
 * Replaces text in a pending job's page, if it is still at `baseVersion`,
 * then repairs its front matter.
 *
 * @param run - Active run in the generating phase.
 * @param input - Job, base version, and the replacement.
 * @returns The new version and front-matter state.
 * @throws RepositoryRunError (`conflict`) when the page changed since
 *   `baseVersion`, or (`invalid_input`) when the edit does not apply.
 */
export async function editPersonalPage(
  run: ActivePersonalRun,
  input: {
    jobId: string;
    baseVersion: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  },
): Promise<PersonalPageWriteResult> {
  const { job, backend } = await preparePageWrite(run, input);
  const result = await backend.edit(
    job.path,
    input.oldString,
    input.newString,
    input.replaceAll,
  );
  if (result.error) {
    throw new RepositoryRunError(
      "invalid_input",
      `Could not edit ${job.path}: ${result.error}`,
    );
  }
  return completePageWrite(run, job, backend);
}

/**
 * Returns the current version of a pending job's page, for a driver that
 * tracks the base version of its writes.
 */
export async function readPersonalPageVersion(
  run: ActivePersonalRun,
  jobId: string,
): Promise<string> {
  await renewHeldLock(run);
  requireGeneratingPlan(run);
  const job = requirePendingJob(run.state.plan?.pages, jobId, "written");
  return toPageVersion(await readPageMarkdownSnapshot(run.backend, job.path));
}

/**
 * Completes a pending job whose page exists with valid front matter.
 *
 * Completing an already complete job returns the same result again.
 *
 * @param run - Active run in the generating phase.
 * @param input - Job to complete.
 * @returns The page and the number of jobs still pending.
 * @throws RepositoryRunError (`invalid_input`) when the page is missing or its
 *   front matter cannot be repaired.
 */
export async function submitPersonalPage(
  run: ActivePersonalRun,
  input: { jobId: string },
): Promise<{ status: "complete"; page: string; remaining: number }> {
  await renewHeldLock(run);
  const plan = requireGeneratingPlan(run);
  const requested = plan.pages.find(({ id }) => id === input.jobId);
  if (!requested) {
    throw new RepositoryRunError(
      "invalid_input",
      `Unknown OpenWiki page job ${input.jobId}.`,
    );
  }
  const completed = (pages: readonly PersonalPageJob[]) => ({
    status: "complete" as const,
    page: requested.path,
    remaining: pages.filter(({ status }) => status === "pending").length,
  });
  if (requested.status === "complete") return completed(plan.pages);
  const job = requirePendingJob(plan.pages, requested.id, "submitted");

  // Page-local validation runs outside the mutation lock: it touches only
  // this job's page.
  const markdown = await readPageMarkdownSnapshot(run.backend, job.path);
  if (markdown === null) {
    throw new RepositoryRunError(
      "invalid_input",
      `Write ${job.path} before submitting its page job.`,
    );
  }
  const repair = await repairPersistedFile(
    createJobBackend(run, job),
    job.path,
    resolveConceptTypeLabel(run.state.language),
  );
  if (!repair.validation.valid) {
    throw new RepositoryRunError(
      "invalid_input",
      `Could not repair front matter in ${job.path}: ${formatIssues(repair.validation.issues)}`,
    );
  }

  return withRunMutation(run, async () => {
    // Another worker may have advanced the plan while this one waited.
    const latestPlan = requireGeneratingPlan(run);
    const latest = latestPlan.pages.find(({ id }) => id === job.id);
    if (latest?.status === "complete") return completed(latestPlan.pages);
    requirePendingJob(latestPlan.pages, job.id, "submitted");

    const pages = latestPlan.pages.map((page) =>
      page.id === job.id
        ? {
            ...page,
            status: "complete" as const,
            completedBy: run.state.actor.producerActor,
          }
        : page,
    );
    const nextState: PersonalRunState = {
      ...run.state,
      plan: { ...latestPlan, pages },
    };
    await writePersonalRunState(run.wikiDir, nextState);
    run.state = nextState;
    return completed(pages);
  });
}

/**
 * Finalizes a run whose queue has no pending job.
 *
 * Every step is idempotent and `.run.json` is removed last, so a crash at any
 * point leaves a run that the next `begin` resumes and finishes again.
 *
 * @param run - Active run with an accepted plan.
 * @param options - Snapshots of the jobs skipped by this process.
 * @returns Final status and which connector cursors advanced.
 */
export async function finishPersonalRun(
  run: ActivePersonalRun,
  options: {
    skippedPageSnapshots?: readonly PersonalPageSnapshot[];
    now?: () => Date;
  } = {},
): Promise<FinishPersonalRunResult> {
  return withRunMutation(run, async () => {
    await renewHeldLock(run);
    const plan = run.state.plan;
    if (!plan) {
      throw new RepositoryRunError(
        "invalid_state",
        "OpenWiki cannot finish a personal run before a plan is accepted.",
      );
    }
    const pending = plan.pages.filter(({ status }) => status === "pending");
    if (pending.length > 0) {
      throw new RepositoryRunError(
        "invalid_state",
        `OpenWiki cannot finish with ${pending.length} pending page job(s).`,
      );
    }
    // Plan validation already refuses this; checked again because init must
    // never remove user knowledge.
    if (run.state.mode === "init" && plan.deletePages.length > 0) {
      throw new RepositoryRunError(
        "invalid_state",
        "A personal init run cannot delete pages.",
      );
    }

    const skippedJobs = plan.pages.filter(({ status }) => status === "skipped");
    const snapshots = options.skippedPageSnapshots ?? [];
    const snapshotsByJobId = new Map(
      snapshots.map((snapshot) => [snapshot.jobId, snapshot]),
    );
    if (
      skippedJobs.length !== snapshots.length ||
      skippedJobs.some((job) => snapshotsByJobId.get(job.id)?.path !== job.path)
    ) {
      throw new RepositoryRunError(
        "invalid_state",
        "Every skipped OpenWiki page job requires its original page snapshot before finish.",
      );
    }

    for (const page of plan.deletePages) {
      const result = await run.backend.delete(page);
      if (result.error && !isNotFoundBackendError(result.error)) {
        throw new RepositoryRunError(
          "invalid_state",
          `Could not delete planned OpenWiki page ${page}: ${result.error}`,
        );
      }
    }

    const producerActorsByPage = new Map<string, string>();
    for (const job of plan.pages) {
      if (job.status === "complete" && job.completedBy) {
        producerActorsByPage.set(job.path, job.completedBy);
      }
    }
    await finalizeWikiArtifacts({
      backend: run.backend,
      outputMode: "local-wiki",
      labels: resolveIndexLabels(run.state.language),
      conceptType: resolveConceptTypeLabel(run.state.language),
      prepared: deserializePreparedWikiState(run.state.preparedWiki),
      at: run.state.startedAt,
      producerActor: run.state.actor.producerActor,
      producerActorsByPage,
    });

    for (const snapshot of snapshots) {
      await restorePageMarkdown(run.backend, snapshot);
    }

    const { advanced, held } = await advanceSynthesisCursor(
      run,
      options.now ?? (() => new Date()),
    );

    const lastUpdateStatus =
      skippedJobs.length > 0 ? "interrupted" : "complete";
    await writeLastUpdateMetadata(
      run.state.mode,
      run.wikiDir,
      run.state.actor.metadataModel,
      "local-wiki",
      lastUpdateStatus,
      run.state.language,
    );

    // Delete these LAST, state before lock. If anything above fails, begin()
    // resumes the run and finish runs again.
    await removePersonalRunState(run.wikiDir);
    await releasePersonalRunLock(run.wikiDir, run.holder);

    return {
      status: "complete" as const,
      lastUpdateStatus,
      advancedConnectors: advanced,
      heldConnectors: held,
    };
  });
}

/**
 * Renews the lock while a driver's workers run.
 *
 * @throws RepositoryRunError (`conflict`) when this process lost the lock.
 */
export async function renewPersonalRun(run: ActivePersonalRun): Promise<void> {
  await renewHeldLock(run);
}

/**
 * Releases the lock of a driver that exits without finishing.
 *
 * `.run.json` stays in place, so another driver's `begin` resumes the run.
 */
export async function releasePersonalRun(
  run: ActivePersonalRun,
): Promise<void> {
  await releasePersonalRunLock(run.wikiDir, run.holder);
}

/**
 * Computes the evidence frontier for the in-scope connectors.
 *
 * A connector contributes the raw runs after its cursor, or only its newest
 * raw run when it has no cursor. A deterministic connector with nothing new
 * contributes no entry. An agentic connector always contributes an unfrozen
 * entry, because gathering may still add evidence to it.
 *
 * @param connectorIds - In-scope connectors.
 * @param cursor - Current synthesis cursor.
 * @returns Frontier entries in connector order.
 */
export async function computePersonalFrontier(
  connectorIds: readonly string[],
  cursor: SynthesisCursor,
): Promise<PersonalFrontierEntry[]> {
  const frontier: PersonalFrontierEntry[] = [];
  for (const connectorId of [...connectorIds].sort(compareCodeUnits)) {
    const rawRunIds = await listRawRunIds(connectorId);
    const through = cursor.connectors[connectorId]?.synthesizedThrough;
    const selected =
      through === undefined
        ? rawRunIds.slice(-1)
        : rawRunIds.filter((rawRunId) => rawRunId > through);
    const agentic = AGENTIC_PERSONAL_CONNECTORS.has(connectorId);
    if (!agentic && selected.length === 0) continue;
    frontier.push({
      connectorId,
      rawRunIds: selected,
      rawFiles: await listRawFiles(connectorId, selected),
      frozen: !agentic,
    });
  }
  return frontier;
}

/**
 * Connected connectors, narrowed by the scope.
 */
async function resolveInScopeConnectors(
  scope: PersonalRunScope | undefined,
): Promise<{ connectors: string[]; warnings: string[] }> {
  const onboarding = await readOpenWikiOnboardingConfig();
  const connected = new Set<string>(
    onboarding.sourceInstances
      .filter(
        ({ connectedAt, connectorId }) =>
          Boolean(connectedAt) && CONNECTOR_ID_PATTERN.test(connectorId),
      )
      .map(({ connectorId }) => connectorId),
  );
  if (!scope?.connectors) {
    return { connectors: [...connected], warnings: [] };
  }
  const warnings = scope.connectors
    .filter((connectorId) => !connected.has(connectorId))
    .map(
      (connectorId) =>
        `Connector ${connectorId} is not connected, so this run reads none of its evidence.`,
    );
  return {
    connectors: scope.connectors.filter((connectorId) =>
      connected.has(connectorId),
    ),
    warnings,
  };
}

/**
 * Drops frontier files whose raw run the user deleted.
 */
async function dropDeletedRawRuns(
  frontier: readonly PersonalFrontierEntry[],
): Promise<{ frontier: PersonalFrontierEntry[]; warnings: string[] }> {
  const warnings: string[] = [];
  const next: PersonalFrontierEntry[] = [];
  for (const entry of frontier) {
    const rawDir = getConnectorRawDir(entry.connectorId);
    const rawRunIds: string[] = [];
    for (const rawRunId of entry.rawRunIds) {
      if (await isDirectory(path.join(rawDir, rawRunId))) {
        rawRunIds.push(rawRunId);
      } else {
        warnings.push(
          `Raw run ${entry.connectorId}/${rawRunId} was deleted; its evidence was dropped from this run.`,
        );
      }
    }
    const kept = new Set(rawRunIds);
    next.push({
      ...entry,
      rawRunIds,
      rawFiles: entry.rawFiles.filter((file) =>
        kept.has(file.split("/", 1)[0]),
      ),
    });
  }
  return { frontier: next, warnings };
}

/**
 * Advances each connector's cursor whose seeded jobs all completed.
 */
async function advanceSynthesisCursor(
  run: ActivePersonalRun,
  now: () => Date,
): Promise<{ advanced: string[]; held: string[] }> {
  const jobs = run.state.plan?.pages ?? [];
  const cursor = await readSynthesisCursor(run.wikiDir);
  const advanced: string[] = [];
  const held: string[] = [];
  const at = now().toISOString();

  for (const entry of run.state.frontier) {
    const newest = entry.rawRunIds.at(-1);
    if (newest === undefined) continue;
    const seededJobs = jobs.filter(({ seedEvidence }) =>
      seedEvidence.some(
        (ref) => parseRawEvidenceRef(ref).connectorId === entry.connectorId,
      ),
    );
    if (seededJobs.some(({ status }) => status !== "complete")) {
      held.push(entry.connectorId);
      continue;
    }
    const current = cursor.connectors[entry.connectorId];
    if (current && current.synthesizedThrough >= newest) continue;
    cursor.connectors[entry.connectorId] = {
      synthesizedThrough: newest,
      at,
      runId: run.state.runId,
    };
    advanced.push(entry.connectorId);
  }

  if (advanced.length > 0) {
    await writeSynthesisCursor(run.wikiDir, cursor);
  }
  return { advanced, held };
}

/**
 * Verifies that this process holds the run's lock, and renews it.
 */
async function renewHeldLock(run: ActivePersonalRun): Promise<void> {
  await renewPersonalRunLock(run.wikiDir, {
    holder: run.holder,
    runId: run.state.runId,
  });
}

/**
 * Returns the accepted plan of a run in the generating phase.
 */
function requireGeneratingPlan(
  run: ActivePersonalRun,
): NonNullable<PersonalRunState["plan"]> {
  const plan = run.state.plan;
  if (!plan || run.state.phase !== "generating") {
    throw new RepositoryRunError(
      "invalid_state",
      "Submit the OpenWiki personal plan before page work.",
    );
  }
  return plan;
}

/**
 * Requires a snapshot to belong to a pending job of this run.
 */
function requireSnapshotJob(
  run: ActivePersonalRun,
  snapshot: PersonalPageSnapshot,
): void {
  const job = run.state.plan?.pages.find(({ id }) => id === snapshot.jobId);
  if (job?.status !== "pending" || job.path !== snapshot.path) {
    throw new RepositoryRunError(
      "invalid_state",
      "The page worker no longer owns a pending job.",
    );
  }
}

/**
 * Checks that a write targets a pending job whose page is still at
 * `baseVersion`: the page change check.
 */
async function preparePageWrite(
  run: ActivePersonalRun,
  input: { jobId: string; baseVersion: string },
): Promise<{ job: PersonalPageJob; backend: OpenWikiLocalShellBackend }> {
  await renewHeldLock(run);
  requireGeneratingPlan(run);
  const job = requirePendingJob(run.state.plan?.pages, input.jobId, "written");
  const current = toPageVersion(
    await readPageMarkdownSnapshot(run.backend, job.path),
  );
  if (current !== input.baseVersion) {
    throw new RepositoryRunError(
      "conflict",
      `${job.path} changed since version ${input.baseVersion}; it is now ${current}. Read the page again and re-apply the change.`,
    );
  }
  return { job, backend: createJobBackend(run, job) };
}

/**
 * Repairs a written page's front matter and reports its new version.
 */
async function completePageWrite(
  run: ActivePersonalRun,
  job: PersonalPageJob,
  backend: OpenWikiLocalShellBackend,
): Promise<PersonalPageWriteResult> {
  const repair = await repairPersistedFile(
    backend,
    job.path,
    resolveConceptTypeLabel(run.state.language),
  );
  const markdown = await readPageMarkdownSnapshot(backend, job.path);
  if (markdown === null) {
    throw new RepositoryRunError(
      "invalid_state",
      `${job.path} disappeared while it was written.`,
    );
  }
  return {
    page: job.path,
    bytes: Buffer.byteLength(markdown, "utf8"),
    version: toPageVersion(markdown),
    frontmatter: {
      valid: repair.validation.valid,
      repaired: repair.changed,
      issues: repair.validation.valid ? [] : repair.validation.issues,
    },
  };
}

/**
 * Creates a backend that may write only the job's page.
 */
function createJobBackend(
  run: ActivePersonalRun,
  job: PersonalPageJob,
): OpenWikiLocalShellBackend {
  return createPersonalBackend(run.wikiDir, [job.path]);
}

/**
 * Version of a page's Markdown: its `sha256:` digest, or `"absent"`.
 */
function toPageVersion(markdown: string | null): string {
  if (markdown === null) return "absent";
  return `sha256:${createHash("sha256").update(markdown, "utf8").digest("hex")}`;
}

/**
 * Formats front-matter issues for an error message.
 */
function formatIssues(issues: readonly FrontmatterIssue[]): string {
  return issues
    .map(
      ({ code, line, message }) =>
        `[${code}]${line ? ` line ${line}:` : ""} ${message}`,
    )
    .join("; ");
}

/**
 * Projects run state into the driver-facing begin view.
 */
function toBeginView(
  run: ActivePersonalRun,
  resumed: boolean,
  warnings: string[],
): PersonalBeginView {
  const { state } = run;
  const pages = state.plan?.pages ?? [];
  return {
    status: "active",
    runId: state.runId,
    mode: state.mode,
    phase: state.phase,
    language: state.language,
    languageChanged: state.languageChanged,
    resumed,
    lastUpdate: state.previousLastUpdate,
    ...(state.wikiGoal ? { wikiGoal: state.wikiGoal } : {}),
    ...(state.instruction ? { instruction: state.instruction } : {}),
    ...(state.scope ? { scope: state.scope } : {}),
    frontier: state.frontier,
    warnings,
    completedPages: pages.filter(({ status }) => status === "complete").length,
    ...(state.plan ? { totalPages: pages.length } : {}),
  };
}

/**
 * Creates the wiki backend used by code-owned lifecycle work.
 *
 * @param writableWikiPages - Pages the backend may write.
 *   @default undefined - every page.
 */
function createPersonalBackend(
  wikiDir: string,
  writableWikiPages?: readonly string[],
): OpenWikiLocalShellBackend {
  return new OpenWikiLocalShellBackend({
    docsOnly: true,
    maxOutputBytes: 100_000,
    outputMode: "local-wiki",
    rootDir: wikiDir,
    timeout: 120,
    virtualMode: true,
    ...(writableWikiPages ? { writableWikiPages } : {}),
  });
}

/**
 * Validates and canonicalizes a requested scope.
 *
 * @throws RepositoryRunError (`invalid_input`) for a malformed connector ID or
 *   page path.
 */
function normalizeScope(
  scope: PersonalRunScope | undefined,
): PersonalRunScope | undefined {
  if (!scope) return undefined;
  const normalized: PersonalRunScope = {};
  if (scope.connectors) {
    for (const connectorId of scope.connectors) {
      if (!CONNECTOR_ID_PATTERN.test(connectorId)) {
        throw new RepositoryRunError(
          "invalid_input",
          `Scope names an invalid connector ID: ${connectorId}`,
        );
      }
    }
    normalized.connectors = [...new Set(scope.connectors)].sort(
      compareCodeUnits,
    );
  }
  if (scope.pages) {
    for (const page of scope.pages) {
      if (!isCanonicalPersonalPagePath(page)) {
        throw new RepositoryRunError(
          "invalid_input",
          `Scope names a page that is not a canonical wiki path: ${page}`,
        );
      }
    }
    normalized.pages = [...new Set(scope.pages)].sort(compareCodeUnits);
  }
  return normalized.connectors || normalized.pages ? normalized : undefined;
}

/**
 * Whether the frontier holds no evidence and needs no gathering.
 */
function isFrontierEmpty(frontier: readonly PersonalFrontierEntry[]): boolean {
  return frontier.every(
    ({ frozen, rawFiles }) => frozen && rawFiles.length === 0,
  );
}

/**
 * Lists a connector's raw run directories, ascending.
 */
async function listRawRunIds(connectorId: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(getConnectorRawDir(connectorId), {
      withFileTypes: true,
    });
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }
  return entries
    .filter(
      (entry) => entry.isDirectory() && RAW_RUN_ID_PATTERN.test(entry.name),
    )
    .map(({ name }) => name)
    .sort(compareCodeUnits);
}

/**
 * Lists the regular files of some raw runs, relative to the connector's raw
 * directory with `/` separators. Dot-files are skipped.
 */
async function listRawFiles(
  connectorId: string,
  rawRunIds: readonly string[],
): Promise<string[]> {
  const rawDir = getConnectorRawDir(connectorId);
  const files: string[] = [];

  async function walk(relativeDirectory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(path.join(rawDir, relativeDirectory), {
        withFileTypes: true,
      });
    } catch (error) {
      if (isFileNotFoundError(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relative = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }

  for (const rawRunId of rawRunIds) {
    await walk(rawRunId);
  }
  return files.sort(compareCodeUnits);
}

/**
 * Whether a path is an existing directory.
 */
async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw error;
  }
}

/**
 * Formats an ISO time the way `createRunId()` names raw runs.
 */
function toRawRunId(iso: string): string {
  return new Date(iso).toISOString().replace(/[:.]/gu, "-");
}

/**
 * Orders strings by UTF-16 code units, independent of locale.
 */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
