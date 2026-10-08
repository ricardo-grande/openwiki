import { randomUUID } from "node:crypto";
import path from "node:path";
import { RepositoryRunError } from "./errors.js";
import {
  requireFrontierEvidence,
  type PersonalPageJob,
  type PersonalRunPlan,
  type PersonalRunState,
} from "./personal-run-state.js";

/**
 * The navigation page every init run writes and no plan may delete.
 */
export const PERSONAL_QUICKSTART_PAGE = "/quickstart.md";

/**
 * The memory-questions page every non-empty run maintains once it exists.
 */
export const PERSONAL_OPEN_QUESTIONS_PAGE = "/open-questions.md";

/**
 * Canonical cross-source pages, written after the domain pages that feed them.
 */
const CANONICAL_SUMMARY_PAGES: ReadonlySet<string> = new Set([
  "/commitments.md",
  "/personal-logistics.md",
  "/themes.md",
]);

/**
 * Page basenames the finalizer owns in every directory.
 */
const RESERVED_PAGE_BASENAMES: ReadonlySet<string> = new Set([
  "index.md",
  "log.md",
]);

/**
 * Driver proposal for one page of a personal plan.
 */
export interface ProposedPersonalPlanPage {
  /**
   * Canonical virtual Markdown path, such as `/topics/x.md`.
   */
  path: string;

  /**
   * Human-readable page title.
   */
  title: string;

  /**
   * Page-specific objective supplied to its worker.
   */
  purpose: string;

  /**
   * `raw://` evidence refs inside the frontier.
   *
   * @default []
   */
  seedEvidence?: string[];

  /**
   * Wiki pages relevant to this job.
   *
   * @default []
   */
  relatedPages?: string[];

  /**
   * Plan-level constraints such as stable topic keys.
   *
   * @default []
   */
  instructions?: string[];
}

/**
 * Complete planner submission before validation and required-job insertion.
 */
export interface ProposedPersonalPlan {
  /**
   * Pages the planner wants written. May be empty for an update.
   */
  pages: ProposedPersonalPlanPage[];

  /**
   * Existing pages to delete at finish.
   *
   * @default []
   */
  deletePages?: string[];
}

/**
 * Run state a plan is validated against.
 */
export type PersonalPlanContext = Pick<
  PersonalRunState,
  | "mode"
  | "frontier"
  | "scope"
  | "instruction"
  | "initialPages"
  | "languageChanged"
  | "requiredRewritePages"
>;

/**
 * Validates a proposed plan, adds the core's required jobs, and orders the
 * queue by tier, then by path.
 *
 * @param context - Mode, frontier, scope, and pages of the run.
 * @param proposed - Planner submission.
 * @returns The complete plan, every job pending.
 * @throws RepositoryRunError (`invalid_input`) when the plan breaks a §3.3 rule.
 */
export function createPersonalPlan(
  context: PersonalPlanContext,
  proposed: ProposedPersonalPlan,
): PersonalRunPlan {
  const pages = proposed.pages.map((page) => normalizePlanPage(context, page));
  const deletePages = uniqueSorted(
    (proposed.deletePages ?? []).map((page) =>
      requirePlanPagePath(page, "Deleted page"),
    ),
  );

  const byPath = new Map<string, PersonalPageJob>();
  for (const page of pages) {
    if (byPath.has(page.path)) {
      throw invalidPlan(`Duplicate planned page: ${page.path}`);
    }
    byPath.set(page.path, page);
  }
  for (const deleted of deletePages) {
    if (byPath.has(deleted)) {
      throw invalidPlan(
        `A page cannot be both planned and deleted: ${deleted}`,
      );
    }
    if (
      deleted === PERSONAL_QUICKSTART_PAGE ||
      deleted === PERSONAL_OPEN_QUESTIONS_PAGE
    ) {
      throw invalidPlan(`The canonical ${deleted} page cannot be deleted.`);
    }
  }
  if (context.mode === "init" && deletePages.length > 0) {
    throw invalidPlan("A personal init plan cannot delete pages.");
  }

  const scopedPages = context.scope?.pages;
  if (scopedPages) {
    const allowed = new Set(scopedPages);
    for (const page of [...byPath.keys(), ...deletePages]) {
      if (!allowed.has(page)) {
        throw invalidPlan(`${page} is outside this run's page scope.`);
      }
    }
  }

  // Required jobs are added after the scope check: the core's own jobs are
  // exempt from it.
  addSourceJobs(context, byPath, deletePages);
  addOpenQuestionsJob(context, byPath);
  addRewriteJobs(context, byPath, deletePages);
  addQuickstartJob(context, byPath, deletePages);

  const queue = [...byPath.values()].sort(
    (left, right) =>
      pageTier(left.path) - pageTier(right.path) ||
      compareCodeUnits(left.path, right.path),
  );
  return { pages: queue, deletePages };
}

/**
 * Whether two plans describe the same ordered work, ignoring job IDs and
 * progress.
 */
export function samePersonalPlan(
  left: PersonalRunPlan,
  right: PersonalRunPlan,
): boolean {
  const simplify = (plan: PersonalRunPlan) => ({
    pages: plan.pages.map(
      ({
        path,
        title,
        purpose,
        seedEvidence,
        relatedPages,
        instructions,
        maintenance,
      }) => ({
        path,
        title,
        purpose,
        seedEvidence,
        relatedPages,
        instructions,
        maintenance: maintenance ?? false,
      }),
    ),
    deletePages: plan.deletePages,
  });
  return JSON.stringify(simplify(left)) === JSON.stringify(simplify(right));
}

/**
 * Extracts the body of a page's `## Active` section.
 *
 * @param markdown - Complete page Markdown.
 * @returns The section body without its heading, or `null` when the page has
 *   no Active section or it is empty.
 */
export function extractActiveSection(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^##\s+Active\s*$/iu.test(line));
  if (start === -1) return null;
  const end = lines.findIndex(
    (line, index) => index > start && /^#{1,2}\s/u.test(line),
  );
  const body = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
  return body === "" ? null : body;
}

/**
 * Whether a path is a canonical virtual Markdown path such as `/topics/x.md`:
 * rooted, with no empty, dot, or hidden segment.
 */
export function isCanonicalPersonalPagePath(page: string): boolean {
  if (!page.startsWith("/") || !page.endsWith(".md") || page.includes("\\")) {
    return false;
  }
  return page
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && !segment.startsWith("."));
}

/**
 * Queue tier of a page: domain pages first, the quickstart last.
 */
function pageTier(page: string): number {
  if (page === PERSONAL_QUICKSTART_PAGE) return 4;
  if (page === PERSONAL_OPEN_QUESTIONS_PAGE) return 3;
  if (page.startsWith("/sources/")) return 2;
  if (CANONICAL_SUMMARY_PAGES.has(page)) return 1;
  return 0;
}

/**
 * Validates and canonicalizes one proposed page into a pending job.
 */
function normalizePlanPage(
  context: PersonalPlanContext,
  page: ProposedPersonalPlanPage,
): PersonalPageJob {
  const pagePath = requirePlanPagePath(page.path, "Planned page");
  const title = page.title.trim();
  const purpose = page.purpose.trim();
  if (!title || !purpose) {
    throw invalidPlan(`Planned page requires a title and purpose: ${pagePath}`);
  }
  for (const ref of page.seedEvidence ?? []) {
    requireFrontierEvidence(context.frontier, ref);
  }
  return {
    id: randomUUID(),
    path: pagePath,
    title,
    purpose,
    seedEvidence: uniqueSorted(page.seedEvidence ?? []),
    relatedPages: uniqueSorted(
      (page.relatedPages ?? []).map((related) =>
        requirePlanPagePath(related, "Related page"),
      ),
    ),
    instructions: uniqueSorted(
      (page.instructions ?? [])
        .map((instruction) => instruction.trim())
        .filter(Boolean),
    ),
    status: "pending",
  };
}

/**
 * Routes every frontier file to its connector's source page.
 */
function addSourceJobs(
  context: PersonalPlanContext,
  byPath: Map<string, PersonalPageJob>,
  deletePages: readonly string[],
): void {
  for (const entry of context.frontier) {
    if (entry.rawFiles.length === 0) continue;
    const page = `/sources/${entry.connectorId}.md`;
    if (deletePages.includes(page)) {
      throw invalidPlan(
        `${page} cannot be deleted: this run routes ${entry.connectorId} evidence to it.`,
      );
    }
    const seeds = entry.rawFiles.map(
      (rawFile) => `raw://${entry.connectorId}/${rawFile}`,
    );
    mergeRequiredJob(byPath, page, {
      title: `${entry.connectorId} source`,
      purpose: `Record the ${entry.connectorId} evidence of this run as a compact source evidence index.`,
      seedEvidence: seeds,
    });
  }
}

/**
 * Adds the `/open-questions.md` maintenance job once the page exists and the
 * run has evidence or a request.
 */
function addOpenQuestionsJob(
  context: PersonalPlanContext,
  byPath: Map<string, PersonalPageJob>,
): void {
  const page = PERSONAL_OPEN_QUESTIONS_PAGE;
  if (!context.initialPages.includes(page)) return;
  const hasEvidence = context.frontier.some(
    ({ rawFiles }) => rawFiles.length > 0,
  );
  if (!hasEvidence && !context.instruction) return;

  const job = mergeRequiredJob(byPath, page, {
    title: "Open Questions",
    purpose:
      "Resolve, add, or mark stale open questions from the pages this run changed.",
    seedEvidence: [],
  });
  // A planner that seeded the page made it a regular evidence job.
  if (job.seedEvidence.length === 0) job.maintenance = true;
}

/**
 * Adds a rewrite job for every page a language change requires.
 */
function addRewriteJobs(
  context: PersonalPlanContext,
  byPath: Map<string, PersonalPageJob>,
  deletePages: readonly string[],
): void {
  if (!context.languageChanged) return;
  for (const page of context.requiredRewritePages) {
    if (deletePages.includes(page)) continue;
    mergeRequiredJob(byPath, page, {
      title: titleFromPath(page),
      purpose:
        "Rewrite this existing page in the run's language, preserving every fact it records.",
      seedEvidence: [],
    });
  }
}

/**
 * Adds `/quickstart.md` for init, and for an update that adds or deletes
 * pages.
 */
function addQuickstartJob(
  context: PersonalPlanContext,
  byPath: Map<string, PersonalPageJob>,
  deletePages: readonly string[],
): void {
  const initial = new Set(context.initialPages);
  const createsPage = [...byPath.keys()].some((page) => !initial.has(page));
  if (context.mode !== "init" && !createsPage && deletePages.length === 0) {
    return;
  }
  mergeRequiredJob(byPath, PERSONAL_QUICKSTART_PAGE, {
    title: "Quickstart",
    purpose:
      "Give navigation and the current high-level status, linking the pages that hold detail.",
    seedEvidence: [],
  });
}

/**
 * Adds a required job, or merges its seeds into the planner's job for the
 * same page, keeping the planner's purpose.
 *
 * @returns The job now queued for the page.
 */
function mergeRequiredJob(
  byPath: Map<string, PersonalPageJob>,
  page: string,
  defaults: Pick<PersonalPageJob, "title" | "purpose" | "seedEvidence">,
): PersonalPageJob {
  const planned = byPath.get(page);
  if (planned) {
    planned.seedEvidence = uniqueSorted([
      ...planned.seedEvidence,
      ...defaults.seedEvidence,
    ]);
    return planned;
  }
  const job: PersonalPageJob = {
    id: randomUUID(),
    path: page,
    title: defaults.title,
    purpose: defaults.purpose,
    seedEvidence: uniqueSorted(defaults.seedEvidence),
    relatedPages: [],
    instructions: [],
    status: "pending",
  };
  byPath.set(page, job);
  return job;
}

/**
 * Requires a canonical, non-reserved page path.
 */
function requirePlanPagePath(page: string, label: string): string {
  if (!isCanonicalPersonalPagePath(page)) {
    throw invalidPlan(`${label} is not a canonical wiki path: ${page}`);
  }
  if (RESERVED_PAGE_BASENAMES.has(path.posix.basename(page))) {
    throw invalidPlan(`${label} names a page the core owns: ${page}`);
  }
  return page;
}

/**
 * Derives a readable title from a page path.
 */
function titleFromPath(page: string): string {
  return path.posix
    .basename(page, ".md")
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function invalidPlan(message: string): RepositoryRunError {
  return new RepositoryRunError("invalid_input", message);
}

/**
 * Returns unique strings in code-unit order.
 */
function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

/**
 * Orders strings by UTF-16 code units, independent of locale.
 */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
