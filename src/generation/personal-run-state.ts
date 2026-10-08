import { rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PersistedPreparedWikiState } from "../agent/wiki-finalizer.js";
import type { UpdateMetadata } from "../agent/types.js";
import { RepositoryRunError } from "./errors.js";
import { readJsonState, writeJsonState } from "./shared/json-state.js";

/**
 * Basename of the durable personal-run checkpoint below the wiki directory.
 */
export const PERSONAL_RUN_STATE_BASENAME = ".run.json";

/**
 * Basename of the persistent per-connector synthesis cursor.
 */
export const SYNTHESIS_CURSOR_BASENAME = ".synthesis-cursor.json";

/**
 * Current on-disk personal-run schema version.
 */
export const PERSONAL_RUN_STATE_SCHEMA_VERSION = 1 as const;

/**
 * Current on-disk synthesis-cursor schema version.
 */
export const SYNTHESIS_CURSOR_SCHEMA_VERSION = 1 as const;

/**
 * Connectors whose evidence is gathered by a driver during the run rather than
 * pulled before it.
 */
export const AGENTIC_PERSONAL_CONNECTORS: ReadonlySet<string> = new Set([
  "notion",
  "custom-mcp",
]);

/**
 * Connector IDs as the connector raw store accepts them.
 */
export const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

/**
 * Raw run directory names produced by `createRunId()`.
 */
export const RAW_RUN_ID_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/u;

/**
 * Personal wiki commands supported by the lifecycle.
 */
export type PersonalRunMode = "init" | "update";

/**
 * Persisted high-level personal lifecycle phase.
 */
export type PersonalRunPhase = "gathering" | "planning" | "generating";

/**
 * Persisted completion state for one personal page job.
 */
export type PersonalPageJobStatus = "pending" | "skipped" | "complete";

/**
 * Producer and metadata identities for the current session.
 */
export interface PersonalRunActor {
  /**
   * Provenance actor used for page work performed by the current session.
   */
  producerActor: string;

  /**
   * Model or host identity written to `.last-update.json`.
   */
  metadataModel: string;
}

/**
 * Optional narrowing of what one run reads and edits.
 */
export interface PersonalRunScope {
  /**
   * Connectors whose evidence the run consumes.
   *
   * @default undefined - every connected source.
   */
  connectors?: string[];

  /**
   * Pages the plan may name.
   *
   * @default undefined - no page restriction.
   */
  pages?: string[];
}

/**
 * Raw runs of one connector that the run consumes.
 */
export interface PersonalFrontierEntry {
  /**
   * Connector whose raw directory holds the runs.
   */
  connectorId: string;

  /**
   * Consumed raw run directory names, ascending.
   */
  rawRunIds: string[];

  /**
   * Consumed files, relative to the connector's raw directory.
   */
  rawFiles: string[];

  /**
   * Whether gathering has ended for this connector; no raw run is added after.
   */
  frozen: boolean;
}

/**
 * One unit of personal page work.
 */
export interface PersonalPageJob {
  /**
   * Stable identifier used by page submission.
   */
  id: string;

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
   */
  seedEvidence: string[];

  /**
   * Wiki pages relevant to this job.
   */
  relatedPages: string[];

  /**
   * Plan-level constraints propagated to this page.
   */
  instructions: string[];

  /**
   * Whether the job is a maintenance job that carries no raw seeds.
   *
   * @default undefined - a regular job.
   */
  maintenance?: boolean;

  /**
   * Durable completion state for this queue entry.
   */
  status: PersonalPageJobStatus;

  /**
   * Producer that durably completed this page.
   *
   * @default undefined for pending and skipped jobs.
   */
  completedBy?: string;
}

/**
 * Accepted personal plan persisted as the run's ordered queue.
 */
export interface PersonalRunPlan {
  /**
   * Ordered queue of page jobs.
   */
  pages: PersonalPageJob[];

  /**
   * Existing pages the plan deletes at finish.
   */
  deletePages: string[];
}

/**
 * Complete JSON checkpoint of an active personal run.
 */
export interface PersonalRunState {
  /**
   * On-disk schema discriminator for this checkpoint.
   */
  schemaVersion: 1;

  /**
   * Lets code-mode readers reject the file.
   */
  kind: "personal";

  /**
   * UUID that addresses the run.
   */
  runId: string;

  /**
   * Command that created the run.
   */
  mode: PersonalRunMode;

  /**
   * Current persisted lifecycle phase.
   */
  phase: PersonalRunPhase;

  /**
   * ISO time the run began; also the provenance stamp time.
   */
  startedAt: string;

  /**
   * Resolved language for the run.
   */
  language: string;

  /**
   * Whether `language` differs from the last completed run.
   */
  languageChanged: boolean;

  /**
   * Pages to rewrite because of a language change.
   */
  requiredRewritePages: string[];

  /**
   * Pages that existed at begin.
   */
  initialPages: string[];

  /**
   * The evidence frontier the run consumes.
   */
  frontier: PersonalFrontierEntry[];

  /**
   * Narrowing of connectors and pages.
   *
   * @default undefined - every connected source and no page restriction.
   */
  scope?: PersonalRunScope;

  /**
   * User request text.
   *
   * @default undefined - none.
   */
  instruction?: string;

  /**
   * Current producer and metadata identities, refreshed on resume.
   */
  actor: PersonalRunActor;

  /**
   * `.last-update.json` content before this run marked itself interrupted.
   */
  previousLastUpdate: UpdateMetadata | null;

  /**
   * Contents of `<home>/INSTRUCTIONS.md`.
   *
   * @default undefined - no goal.
   */
  wikiGoal?: string;

  /**
   * Content snapshot taken at begin.
   */
  beforeContentSnapshot: string;

  /**
   * Serialized preparation state required for finalization.
   */
  preparedWiki: PersistedPreparedWikiState;

  /**
   * Accepted plan, absent until one is submitted.
   */
  plan?: PersonalRunPlan;
}

/**
 * Newest raw run of one connector consumed by a completed run.
 */
export interface SynthesisCursorEntry {
  /**
   * Raw run directory name the connector is synthesized through.
   */
  synthesizedThrough: string;

  /**
   * ISO time the cursor advanced.
   */
  at: string;

  /**
   * Run that advanced the cursor.
   */
  runId: string;
}

/**
 * Persistent record of which raw runs earlier runs consumed.
 */
export interface SynthesisCursor {
  /**
   * On-disk schema discriminator.
   */
  schemaVersion: 1;

  /**
   * Cursor per connector ID.
   */
  connectors: Record<string, SynthesisCursorEntry>;
}

/**
 * Parsed `raw://<connectorId>/<rawRunId>/<file>[#<json-pointer>]` ref.
 */
export interface RawEvidenceRef {
  /**
   * Connector whose raw directory holds the file.
   */
  connectorId: string;

  /**
   * Raw run directory name.
   */
  rawRunId: string;

  /**
   * File path inside the raw run, using `/` separators.
   */
  file: string;

  /**
   * Path relative to the connector's raw directory, as frontier `rawFiles`
   * record it.
   */
  rawFile: string;

  /**
   * Decoded RFC 6901 pointer addressing a value inside the file.
   *
   * @default undefined - the whole file.
   */
  pointer?: string;
}

const UpdateMetadataSchema = z
  .object({
    updatedAt: z.string(),
    command: z.enum(["init", "update"]),
    gitHead: z.string().optional(),
    model: z.string(),
    status: z.enum(["complete", "interrupted"]).optional(),
    language: z.string().optional(),
  })
  .strict();

const PersistedPreparedWikiStateSchema = z
  .object({
    generatedProvenance: z.array(
      z
        .object({
          page: z.string().min(1),
          bodyHash: z.string().min(1),
          generated: z
            .object({
              by: z.string().min(1),
              at: z.string().min(1).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();

const ConnectorIdSchema = z.string().regex(CONNECTOR_ID_PATTERN);
const RawRunIdSchema = z.string().regex(RAW_RUN_ID_PATTERN);

const FrontierEntrySchema = z
  .object({
    connectorId: ConnectorIdSchema,
    rawRunIds: z.array(RawRunIdSchema),
    rawFiles: z.array(z.string().min(1)),
    frozen: z.boolean(),
  })
  .strict();

const PersonalPageJobSchema = z
  .object({
    id: z.string().uuid(),
    path: z.string().min(1),
    title: z.string().trim().min(1),
    purpose: z.string().trim().min(1),
    seedEvidence: z.array(z.string().min(1)),
    relatedPages: z.array(z.string()),
    instructions: z.array(z.string().trim().min(1)),
    maintenance: z.boolean().optional(),
    status: z.enum(["pending", "skipped", "complete"]),
    completedBy: z.string().trim().min(1).optional(),
  })
  .strict();

const PersonalRunStateSchema = z
  .object({
    schemaVersion: z.literal(PERSONAL_RUN_STATE_SCHEMA_VERSION),
    kind: z.literal("personal"),
    runId: z.string().uuid(),
    mode: z.enum(["init", "update"]),
    phase: z.enum(["gathering", "planning", "generating"]),
    startedAt: z.string().min(1),
    language: z.string().min(1),
    languageChanged: z.boolean(),
    requiredRewritePages: z.array(z.string().min(1)),
    initialPages: z.array(z.string().min(1)),
    frontier: z.array(FrontierEntrySchema),
    scope: z
      .object({
        connectors: z.array(ConnectorIdSchema).optional(),
        pages: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    instruction: z.string().min(1).optional(),
    actor: z
      .object({
        producerActor: z.string().trim().min(1),
        metadataModel: z.string().trim().min(1),
      })
      .strict(),
    previousLastUpdate: UpdateMetadataSchema.nullable(),
    wikiGoal: z.string().optional(),
    beforeContentSnapshot: z.string(),
    preparedWiki: PersistedPreparedWikiStateSchema,
    plan: z
      .object({
        pages: z.array(PersonalPageJobSchema),
        deletePages: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();

// Unknown extra fields are tolerated so a newer writer does not break an
// older reader; they are not preserved when the cursor is rewritten.
const SynthesisCursorSchema = z.object({
  schemaVersion: z.literal(SYNTHESIS_CURSOR_SCHEMA_VERSION),
  connectors: z.record(
    ConnectorIdSchema,
    z.object({
      synthesizedThrough: RawRunIdSchema,
      at: z.string().min(1),
      runId: z.string().min(1),
    }),
  ),
});

/**
 * Resolves the personal checkpoint path below a wiki directory.
 */
export function personalRunStatePath(wikiDir: string): string {
  return path.join(wikiDir, PERSONAL_RUN_STATE_BASENAME);
}

/**
 * Resolves the synthesis cursor path below a wiki directory.
 */
export function synthesisCursorPath(wikiDir: string): string {
  return path.join(wikiDir, SYNTHESIS_CURSOR_BASENAME);
}

/**
 * Loads and validates an active personal run.
 *
 * @returns Valid state, or `null` when no run is active.
 * @throws RepositoryRunError when the checkpoint is malformed or belongs to
 *   another lifecycle.
 */
export async function readPersonalRunState(
  wikiDir: string,
): Promise<PersonalRunState | null> {
  const file = personalRunStatePath(wikiDir);
  return readJsonState(
    file,
    PersonalRunStateSchema,
    `OpenWiki personal run state is malformed at ${file}; refusing to discard resumable work.`,
  );
}

/**
 * Atomically replaces the personal checkpoint.
 *
 * @throws Error when validation or filesystem persistence fails.
 */
export async function writePersonalRunState(
  wikiDir: string,
  state: PersonalRunState,
): Promise<void> {
  await writeJsonState(
    personalRunStatePath(wikiDir),
    PersonalRunStateSchema,
    state,
  );
}

/**
 * Idempotently removes the personal checkpoint after finish.
 */
export async function removePersonalRunState(wikiDir: string): Promise<void> {
  await rm(personalRunStatePath(wikiDir), { force: true });
}

/**
 * Loads the synthesis cursor.
 *
 * A corrupt cursor is never reset: a silent reset would re-ingest or skip
 * evidence.
 *
 * @returns The cursor; an absent file is a cursor with no connectors.
 * @throws RepositoryRunError (`invalid_state`) naming the corrupt file.
 */
export async function readSynthesisCursor(
  wikiDir: string,
): Promise<SynthesisCursor> {
  const file = synthesisCursorPath(wikiDir);
  const cursor = await readJsonState(
    file,
    SynthesisCursorSchema,
    `OpenWiki synthesis cursor is malformed at ${file}; fix or remove it before the next personal run.`,
  );
  return cursor
    ? { schemaVersion: cursor.schemaVersion, connectors: cursor.connectors }
    : { schemaVersion: SYNTHESIS_CURSOR_SCHEMA_VERSION, connectors: {} };
}

/**
 * Atomically replaces the synthesis cursor.
 */
export async function writeSynthesisCursor(
  wikiDir: string,
  cursor: SynthesisCursor,
): Promise<void> {
  await writeJsonState(
    synthesisCursorPath(wikiDir),
    SynthesisCursorSchema,
    cursor,
  );
}

/**
 * Parses a `raw://` evidence ref.
 *
 * @param ref - `raw://<connectorId>/<rawRunId>/<file>` with an optional
 *   `#<json-pointer>` fragment (RFC 6901, URI fragment encoding).
 * @returns The parsed ref.
 * @throws RepositoryRunError (`invalid_input`) when the ref is malformed.
 */
export function parseRawEvidenceRef(ref: string): RawEvidenceRef {
  const invalid = (reason: string) =>
    new RepositoryRunError(
      "invalid_input",
      `Invalid evidence ref ${JSON.stringify(ref)}: ${reason}`,
    );
  if (!ref.startsWith("raw://")) {
    throw invalid("it must start with raw://");
  }

  const hashIndex = ref.indexOf("#");
  const location = ref.slice(
    "raw://".length,
    hashIndex === -1 ? undefined : hashIndex,
  );
  const [connectorId = "", rawRunId = "", ...fileSegments] =
    location.split("/");
  if (!CONNECTOR_ID_PATTERN.test(connectorId)) {
    throw invalid("the connector ID is invalid");
  }
  if (!RAW_RUN_ID_PATTERN.test(rawRunId)) {
    throw invalid("the raw run ID is invalid");
  }
  if (
    fileSegments.length === 0 ||
    fileSegments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\\"),
    )
  ) {
    throw invalid("the file path is empty or not canonical");
  }

  const file = fileSegments.join("/");
  const parsed: RawEvidenceRef = {
    connectorId,
    rawRunId,
    file,
    rawFile: `${rawRunId}/${file}`,
  };
  if (hashIndex === -1) return parsed;

  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(hashIndex + 1));
  } catch {
    throw invalid("the fragment is not valid percent-encoding");
  }
  if (pointer !== "" && !pointer.startsWith("/")) {
    throw invalid("the fragment must be a JSON pointer starting with /");
  }
  if (/~(?![01])/u.test(pointer)) {
    throw invalid("the JSON pointer has an invalid ~ escape");
  }
  return { ...parsed, pointer };
}

/**
 * Parses an evidence ref and requires it to name a frontier file.
 *
 * @param frontier - The run's evidence frontier.
 * @param ref - Evidence ref supplied by a driver.
 * @returns The parsed ref.
 * @throws RepositoryRunError (`invalid_input`) when the ref is malformed or
 *   names a file outside the frontier.
 */
export function requireFrontierEvidence(
  frontier: readonly PersonalFrontierEntry[],
  ref: string,
): RawEvidenceRef {
  const parsed = parseRawEvidenceRef(ref);
  const entry = frontier.find(
    ({ connectorId }) => connectorId === parsed.connectorId,
  );
  if (!entry?.rawFiles.includes(parsed.rawFile)) {
    throw new RepositoryRunError(
      "invalid_input",
      `Evidence ref ${ref} names a file outside this run's evidence frontier.`,
    );
  }
  return parsed;
}
