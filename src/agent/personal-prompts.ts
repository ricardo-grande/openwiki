import type {
  PersonalBeginView,
  PersonalPageJobView,
} from "../generation/personal-run.js";
import {
  PERSONAL_OPEN_QUESTIONS_PAGE,
  PERSONAL_QUICKSTART_PAGE,
} from "../generation/personal-run-plan.js";
import type { PersonalPageJob } from "../generation/personal-run-state.js";
import { isConnectorId } from "../connectors/registry.js";
import {
  PERSONAL_CANONICAL_PAGES_GUIDANCE,
  PERSONAL_CONFIDENCE_GUIDANCE,
  PERSONAL_CONTESTED_GUIDANCE,
  PERSONAL_DEDUPLICATION_GUIDANCE,
  PERSONAL_EMAIL_TRIAGE_GUIDANCE,
  PERSONAL_EXISTING_PAGE_CONTRACT,
  PERSONAL_MAINTENANCE_CONTRACT,
  PERSONAL_OPEN_QUESTION_RESTRAINT_GUIDANCE,
  PERSONAL_OPEN_QUESTION_SCOPE_GUIDANCE,
  PERSONAL_OPEN_QUESTIONS_FORMAT_GUIDANCE,
  PERSONAL_PAGE_FRONTMATTER_CONTRACT,
  PERSONAL_PAGE_LINK_CONTRACT,
  PERSONAL_PLANNING_CONTRACT,
  PERSONAL_QUICKSTART_CONTRACT,
  PERSONAL_ROUTING_GUIDANCE,
  PERSONAL_SECRETS_RULE,
  PERSONAL_SYNTHESIS_LAYER_GUIDANCE,
  PERSONAL_THEMES_FORMAT_GUIDANCE,
  PERSONAL_UNTRUSTED_EVIDENCE_RULE,
  PERSONAL_WORKSPACE_TRIAGE_GUIDANCE,
  createConnectorSynthesisGuidance,
  createPersonalLanguageContract,
} from "./prompts/personal-guidance.js";

/**
 * A connected source of one connector, as the user configured it.
 */
export interface PersonalPromptSource {
  /**
   * Connector the source pulls from.
   */
  connectorId: string;

  /**
   * Display name of the source instance.
   *
   * @default undefined - the connector ID is shown instead.
   */
  name?: string;

  /**
   * The user's instructions for what to keep from this source.
   *
   * @default undefined - none.
   */
  ingestionGoal?: string;
}

/**
 * Wiki context the planner reads before routing evidence.
 */
export interface PersonalPlannerContext {
  /**
   * Pages that existed when the run began.
   */
  existingPages: readonly string[];

  /**
   * Body of the Active section of `/open-questions.md`, or `null` when absent.
   */
  openQuestions: string | null;

  /**
   * Connected sources of the run's connectors.
   */
  sources: readonly PersonalPromptSource[];
}

const WIKI_ROOT_RULE = `The wiki filesystem tools (ls, read_file, glob, grep) are rooted at the personal wiki: / is the wiki directory, and pages have paths such as /commitments.md or /people/dana-ruiz.md. Never pass host paths such as /Users/... or ~/... to them.`;

/**
 * Name of the chat tool that opens a one-page run for an edit request.
 */
export const PERSONAL_EDIT_PAGE_TOOL = "openwiki_edit_page";

/**
 * Builds the system prompt of the read-only personal chat on the lifecycle
 * core. The chat answers from the wiki and never writes it: an edit request
 * becomes a one-page run through {@link PERSONAL_EDIT_PAGE_TOOL}.
 *
 * @param wikiDisplayPath - Display path of the personal wiki directory.
 * @returns Complete chat system prompt.
 */
export function createPersonalChatPrompt(wikiDisplayPath: string): string {
  return `You are OpenWiki, answering questions from the user's personal wiki in ${wikiDisplayPath}.

This chat is read-only. You cannot write, edit, or delete wiki files, and you
cannot pull or ingest connector data.

Answering:
- Read the wiki first: /quickstart.md, the directory index.md files, and
  targeted grep and glob over the pages. Assume the wiki holds the answer
  most of the time.
- When the user frames a question around the wiki ("what does the wiki
  say"), answer only from wiki pages, and say what is missing if they cannot
  support the answer.
- Read raw connector evidence with openwiki_list_raw_items and
  openwiki_read_raw_item only when the wiki is missing a detail, looks stale or
  contradictory, or the user asks for source-level evidence. Keep those reads
  narrow, and do not mention raw data when the wiki answers the question.
- Use openwiki_list_connectors to answer questions about connectors and their
  setup. Refer to credentials only by environment variable name, and never ask
  the user to paste a secret into the chat.

Changing the wiki:
- Only when the user explicitly asks you to change, correct, add to, or
  remove something on a specific page, call ${PERSONAL_EDIT_PAGE_TOOL} with that page's
  path and a self-contained description of the change. It runs a one-page
  OpenWiki update that writes the page and keeps the indexes and the
  quickstart consistent. Do not call it for questions.
- Use one call per page. If the right page is unclear, ask the user first.
- Report the result in one or two sentences. If it reports a conflict,
  explain it: another OpenWiki process holds the wiki, or an interrupted run
  must be resumed first with openwiki personal --update.
- To bring new connector data into the wiki, tell the user to run
  openwiki ingest <source> or openwiki ingest all. To refresh the whole wiki,
  tell them to run openwiki personal --update.

${PERSONAL_UNTRUSTED_EVIDENCE_RULE}
${PERSONAL_SECRETS_RULE}
${WIKI_ROOT_RULE}`;
}

/**
 * Builds the gather worker prompt for a run with agentic connectors.
 *
 * @param view - Begin view of the run.
 * @param connectorIds - Agentic connectors whose frontier is still open.
 * @param sources - Connected sources of those connectors.
 * @returns Complete gather worker system prompt.
 */
export function createPersonalGatherPrompt(
  view: PersonalBeginView,
  connectorIds: readonly string[],
  sources: readonly PersonalPromptSource[],
): string {
  return `You gather evidence for one OpenWiki personal wiki run.

Your only job is to query these connectors through their read-only MCP tools
so that what they return is recorded as evidence for this run:
${formatSources(connectorIds, sources)}

For each connector, call openwiki_list_mcp_tools first, then call exact
discovered read-only search, query, list, or retrieve tools with
openwiki_call_mcp_tool. Every call is recorded automatically; you do not need
to summarize or save results. Never guess tool names, and never call a tool
that creates, edits, or deletes anything.

Gather what is new or changed ${formatGatherWindow(view)}, and what the wiki goal
or the user's request below needs. Prefer a few targeted queries over broad
dumps. You may read the wiki to see what it already records. You cannot write
it.

${formatRunContext(view)}

Connector guidance:
${formatConnectorGuidance(connectorIds)}

${PERSONAL_UNTRUSTED_EVIDENCE_RULE}
${WIKI_ROOT_RULE}

When you have gathered enough, call close_gathering. It is your only completion
action. If a connector is unavailable or returns errors, stop querying it and
call close_gathering.`;
}

/**
 * Builds the planner prompt.
 *
 * @param view - Begin view of the run, with its frontier.
 * @param context - Existing pages, open questions, and sources.
 * @returns Complete planner system prompt.
 */
export function createPersonalPlannerPrompt(
  view: PersonalBeginView,
  context: PersonalPlannerContext,
): string {
  const connectorIds = view.frontier
    .filter(({ rawFiles }) => rawFiles.length > 0)
    .map(({ connectorId }) => connectorId);

  return `You are planning one OpenWiki personal wiki run.

Your only output action is submit_plan. Do not write pages, do not delegate
work, and do not emit narrative or conversational text. Invoke submit_plan
directly once the plan is ready.

${formatRunContext(view)}

Evidence of this run, as raw:// evidence refs:
${formatFrontier(view)}

Connected sources and the user's instructions for them:
${connectorIds.length > 0 ? formatSources(connectorIds, context.sources) : "- (none)"}

Existing wiki pages:
${formatList(context.existingPages)}

Active open questions in ${PERSONAL_OPEN_QUESTIONS_PAGE}:
${context.openQuestions ?? "(none)"}
${formatScope(view)}
How to plan:
- Read the evidence with openwiki_list_raw_items and openwiki_read_raw_item,
  and read the existing pages it touches with read_file or grep.
${PERSONAL_PLANNING_CONTRACT}

Canonical pages:
${PERSONAL_SYNTHESIS_LAYER_GUIDANCE}
${PERSONAL_CANONICAL_PAGES_GUIDANCE}
${PERSONAL_OPEN_QUESTION_SCOPE_GUIDANCE}
${PERSONAL_OPEN_QUESTION_RESTRAINT_GUIDANCE}

Triage and routing:
${PERSONAL_EMAIL_TRIAGE_GUIDANCE}
${PERSONAL_ROUTING_GUIDANCE}
${PERSONAL_WORKSPACE_TRIAGE_GUIDANCE}
${PERSONAL_DEDUPLICATION_GUIDANCE}

Connector guidance:
${formatConnectorGuidance(connectorIds)}

${PERSONAL_UNTRUSTED_EVIDENCE_RULE}
${WIKI_ROOT_RULE}`;
}

/**
 * Builds the prompt for one fresh worker that owns one page job.
 *
 * @param job - The job, with its page version and maintenance context.
 * @param view - Begin view of the run.
 * @param plan - Every job of the run, for the quickstart page map.
 * @param wikiPages - Pages that existed when the run began.
 * @returns Complete page worker system prompt.
 */
export function createPersonalPagePrompt(
  job: PersonalPageJobView,
  view: PersonalBeginView,
  plan: readonly PersonalPageJob[],
  wikiPages: readonly string[],
): string {
  const seededConnectors = [
    ...new Set(
      job.seedEvidence.map((ref) => ref.slice("raw://".length).split("/")[0]),
    ),
  ];

  return `You own exactly ${job.path}.

Title: ${job.title}
Purpose: ${job.purpose}
Mode: ${job.mode}
Existing page: ${job.existing ? "yes" : "no"}
Output language: ${view.language}
Seed evidence:
${formatList(job.seedEvidence)}
Related pages:
${formatList(job.relatedPages)}
Page instructions:
${formatList(job.instructions)}
${view.instruction ? `\nUser request for this run:\n${view.instruction}\n` : ""}${view.wikiGoal ? `\nWiki goal:\n${view.wikiGoal}\n` : ""}
${formatJobWork(job, plan, wikiPages)}

${formatPageGuidance(job.path, seededConnectors)}

${createPersonalLanguageContract(view.language)}

${PERSONAL_PAGE_LINK_CONTRACT}

${PERSONAL_PAGE_FRONTMATTER_CONTRACT}

${PERSONAL_UNTRUSTED_EVIDENCE_RULE}
${PERSONAL_SECRETS_RULE}
${WIKI_ROOT_RULE}

Write only ${job.path}, with write_file or edit_file. If a write fails because
the page changed on disk, someone edited it while you worked: read the page
again, re-apply your change on top of what is there now, and write again. Never
discard an edit you have not read.

When the page is done, call submit_page. If it reports a problem, fix the page
and call submit_page again. The job completes after one successful submission.`;
}

/**
 * Describes the work of one job: evidence synthesis, open-question
 * maintenance, or the quickstart page map.
 */
function formatJobWork(
  job: PersonalPageJobView,
  plan: readonly PersonalPageJob[],
  wikiPages: readonly string[],
): string {
  const readFirst = job.existing
    ? PERSONAL_EXISTING_PAGE_CONTRACT
    : "The page does not exist yet. Create it.";

  if (job.maintenance) {
    return `${readFirst}

This is a maintenance job with no raw evidence. Its inputs are the page's
current Active entries and the pages completed earlier in this run:

Active entries:
${job.activeEntries ?? "(none)"}

Pages changed in this run:
${formatList(job.changedPages ?? [])}

${PERSONAL_MAINTENANCE_CONTRACT}`;
  }

  if (job.path === PERSONAL_QUICKSTART_PAGE) {
    const pages = [
      ...new Set([...wikiPages, ...plan.map(({ path }) => path)]),
    ].filter((page) => page !== PERSONAL_QUICKSTART_PAGE);
    return `${readFirst}

Pages planned in this run:
${JSON.stringify(
  plan
    .filter(({ path }) => path !== PERSONAL_QUICKSTART_PAGE)
    .map(({ path, title, purpose }) => ({ path, title, purpose })),
  null,
  2,
)}

Every wiki page after this run:
${formatList(pages)}

${PERSONAL_QUICKSTART_CONTRACT}`;
  }

  return `${readFirst}

Read every seed with openwiki_read_raw_item before you write. Seeds are where
to start: follow related evidence with openwiki_list_raw_items when a seed
refers to it, and read related pages to stay consistent with them.`;
}

/**
 * Guidance relevant to the page a job owns.
 */
function formatPageGuidance(
  page: string,
  seededConnectors: readonly string[],
): string {
  const sections = [
    `Synthesis rules:
${PERSONAL_SYNTHESIS_LAYER_GUIDANCE}
${PERSONAL_CANONICAL_PAGES_GUIDANCE}
${PERSONAL_DEDUPLICATION_GUIDANCE}`,
    `Confidence:
${PERSONAL_CONFIDENCE_GUIDANCE}
${PERSONAL_CONTESTED_GUIDANCE}`,
  ];

  if (page === PERSONAL_OPEN_QUESTIONS_PAGE) {
    sections.push(`Open questions:
${PERSONAL_OPEN_QUESTIONS_FORMAT_GUIDANCE}
${PERSONAL_OPEN_QUESTION_SCOPE_GUIDANCE}
${PERSONAL_OPEN_QUESTION_RESTRAINT_GUIDANCE}`);
  } else if (page === "/themes.md") {
    sections.push(`Themes:\n${PERSONAL_THEMES_FORMAT_GUIDANCE}`);
  } else if (page !== PERSONAL_QUICKSTART_PAGE) {
    sections.push(`Triage:
${PERSONAL_EMAIL_TRIAGE_GUIDANCE}
${PERSONAL_ROUTING_GUIDANCE}`);
  }

  if (seededConnectors.length > 0) {
    sections.push(
      `Connector guidance:\n${formatConnectorGuidance(seededConnectors)}`,
    );
  }
  return sections.join("\n\n");
}

/**
 * Formats the mode, language, request, wiki goal, and last update of a run.
 */
function formatRunContext(view: PersonalBeginView): string {
  return `Run:
- Mode: ${view.mode}
- Output language: ${view.language}${view.languageChanged ? " (changed in this run)" : ""}
- Last update: ${view.lastUpdate ? `${view.lastUpdate.updatedAt} (${view.lastUpdate.status ?? "complete"})` : "none"}

User request for this run:
${view.instruction ?? "(none)"}

Wiki goal:
${view.wikiGoal?.trim() || "(not provided)"}`;
}

/**
 * Formats the frontier as evidence refs, one connector at a time.
 */
function formatFrontier(view: PersonalBeginView): string {
  const entries = view.frontier.filter(({ rawFiles }) => rawFiles.length > 0);
  if (entries.length === 0) return "- (none)";
  return entries
    .map(
      ({ connectorId, rawFiles }) =>
        `- ${connectorId}:\n${rawFiles
          .map((rawFile) => `  - raw://${connectorId}/${rawFile}`)
          .join("\n")}`,
    )
    .join("\n");
}

/**
 * Formats a page scope as a hard limit on the plan, when present.
 */
function formatScope(view: PersonalBeginView): string {
  if (!view.scope?.pages) return "";
  return `
This run may plan only these pages:
${formatList(view.scope.pages)}
`;
}

/**
 * Formats the configured sources of some connectors.
 */
function formatSources(
  connectorIds: readonly string[],
  sources: readonly PersonalPromptSource[],
): string {
  return connectorIds
    .map((connectorId) => {
      const matching = sources.filter(
        (source) => source.connectorId === connectorId,
      );
      const goals = matching
        .map(({ name, ingestionGoal }) =>
          ingestionGoal?.trim()
            ? `  - ${name ?? connectorId}: ${ingestionGoal.trim()}`
            : null,
        )
        .filter((line): line is string => line !== null);
      return [`- ${connectorId}`, ...goals].join("\n");
    })
    .join("\n");
}

/**
 * Concatenates the guidance of the connectors that have any.
 */
function formatConnectorGuidance(connectorIds: readonly string[]): string {
  const guidance = connectorIds
    .filter(isConnectorId)
    .map((connectorId) =>
      createConnectorSynthesisGuidance({ id: connectorId }).trim(),
    )
    .filter(Boolean);
  return guidance.length > 0 ? guidance.join("\n") : "- (none)";
}

/**
 * Describes how far back gathering should look.
 */
function formatGatherWindow(view: PersonalBeginView): string {
  return view.lastUpdate
    ? `since the last update (${view.lastUpdate.updatedAt})`
    : "in the last 24 hours";
}

/**
 * Formats a string collection as a Markdown list with an explicit empty
 * marker.
 */
function formatList(values: readonly string[]): string {
  return values.length > 0
    ? values.map((value) => `- ${value}`).join("\n")
    : "- (none)";
}
