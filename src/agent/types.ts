export type OpenWikiCommand = "chat" | "init" | "update";
export type OpenWikiOutputMode = "local-wiki" | "repository";

export type OpenWikiRunResult = {
  command: OpenWikiCommand;
  model: string;
  skipped?: boolean;

  /**
   * Status a lifecycle-core personal run wrote to `.last-update.json`:
   * `interrupted` when a page job was skipped and the next run retries it.
   *
   * @default undefined - not a lifecycle-core personal run, or a no-op.
   */
  lastUpdateStatus?: "complete" | "interrupted";
};

/**
 * Structured repository-generation lifecycle progress for CLI consumers.
 */
export interface RepositoryGenerationProgressEvent {
  /**
   * Event discriminator for repository lifecycle progress.
   */
  type: "repository_progress";

  /**
   * Current native repository-generation lifecycle stage.
   */
  stage:
    | "gathering"
    | "planning"
    | "generating"
    | "finalizing"
    | "replanning"
    | "noop";

  /**
   * Wiki the lifecycle maintains. Only the personal wiki has a gathering
   * stage.
   *
   * @default "repository"
   */
  wiki?: "repository" | "personal";

  /**
   * Whether this stage is continuing a previously interrupted durable run.
   *
   * @default false
   */
  resumed?: boolean;

  /**
   * Canonical page currently owned by the active page worker.
   *
   * @default undefined outside page generation
   */
  page?: string;

  /**
   * One-based position of the active page in the persisted ordered queue.
   *
   * @default undefined outside page generation
   */
  pageIndex?: number;

  /**
   * Total number of pages in the persisted ordered queue.
   *
   * @default undefined until a plan is durable
   */
  pageCount?: number;

  /**
   * Number of page jobs already complete or skipped in this run.
   *
   * @default undefined outside page generation
   */
  completedCount?: number;

  /**
   * Canonical pages currently owned by in-flight workers, in start order.
   *
   * A single sequential worker reports at most one entry; consumers fall back
   * to `page` and `pageIndex` in that case.
   *
   * @default undefined outside page generation
   */
  inFlightPages?: string[];
}

export type OpenWikiRunEvent =
  | RepositoryGenerationProgressEvent
  | {
      source?: "main" | "subgraph";
      type: "text";
      text: string;
    }
  | {
      type: "tool_start";
      call: string;
      id: string;
      input: unknown;
      name: string;
      /**
       * Canonical page owned by the worker that issued the call.
       *
       * @default undefined for the planner and non-repository runs
       */
      page?: string;
    }
  | {
      type: "tool_end";
      id: string;
      name: string;
      /**
       * Canonical page owned by the worker that issued the call.
       *
       * @default undefined for the planner and non-repository runs
       */
      page?: string;
      status: "error" | "finished";
    }
  | {
      type: "debug";
      message: string;
    };

export type OpenWikiRunOptions = {
  debug?: boolean;
  isFollowup?: boolean;
  language?: string | null;
  modelId?: string | null;
  onEvent?: (event: OpenWikiRunEvent) => void;
  outputMode?: OpenWikiOutputMode;
  threadId?: string;
  userMessage?: string | null;
  telemetryFile?: string;

  /**
   * Narrowing of a new personal run on the lifecycle core: the connectors an
   * ingest pulled, or the one page a chat edit request names.
   *
   * @default undefined - every connected source and no page restriction.
   */
  personalScope?: PersonalRunScopeRequest;

  /**
   * Asks the user whether to take over an expired personal wiki lock. Only
   * interactive callers pass it; without it an expired lock fails the run
   * with `conflict`, as a fresh one does.
   *
   * @default undefined - never take over.
   */
  confirmPersonalTakeover?: PersonalTakeoverConfirmation;
};

/**
 * Connectors and pages a personal run may consume and edit.
 */
export type PersonalRunScopeRequest = {
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
};

/**
 * The expired lock a takeover would replace.
 */
export type ExpiredPersonalLock = {
  /**
   * Holder ID recorded in the lock, `<driver>:<hostname>:<pid>`.
   */
  holder: string;

  /**
   * Time since the holder last renewed the lock, in milliseconds.
   */
  ageMs: number;
};

/**
 * Resolves to `true` when the user confirms taking over an expired lock.
 */
export type PersonalTakeoverConfirmation = (
  lock: ExpiredPersonalLock,
) => Promise<boolean>;

export type UpdateRunStatus = "complete" | "interrupted";

export type UpdateMetadata = {
  updatedAt: string;
  command: OpenWikiCommand;
  gitHead?: string;
  model: string;
  status?: UpdateRunStatus;
  language?: string;
};

export type RunContext = {
  lastUpdate: UpdateMetadata | null;
  language?: string;
  wikiGoal?: string;
};
