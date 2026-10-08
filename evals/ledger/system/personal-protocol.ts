/**
 * Name of the handoff file the personal replay writes beside the temporary
 * OpenWiki home, telling the personal system what to run at a checkpoint. It
 * lives outside the home so the system under test never sees it.
 */
export const PENDING_PULLS_FILE = "pending-pulls.json";

/**
 * One recorded pull made available in the home at this checkpoint.
 */
export interface PendingPull {
  /**
   * OpenWiki connector id.
   */
  connectorId: string;

  /**
   * Source instance id configured in `onboarding.json`.
   */
  instanceId: string;

  /**
   * Raw run directory name under `connectors/<id>/raw/`.
   */
  rawRunId: string;

  /**
   * File names in the raw run directory, sorted.
   */
  files: string[];
}

/**
 * What the personal system runs at one checkpoint.
 */
export interface PendingPulls {
  /**
   * Checkpoint id, for diagnostics.
   */
  checkpointId: string;

  /**
   * `init` for onboarding at T0, `ingest` for every later checkpoint.
   */
  command: "init" | "ingest";

  /**
   * Pulls to ingest, at most one per connector. Empty at T0.
   */
  pulls: PendingPull[];

  /**
   * Whether the pulls cover every connected source, so one `openwiki ingest
   * all` replays them; otherwise each pulled source is ingested on its own.
   *
   * @default false
   */
  allSources?: boolean;
}
