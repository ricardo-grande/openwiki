import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { listSavedOpenWikiEnvKeys } from "../../config/env.js";
import {
  getConnectorConfigPath,
  openWikiLocalWikiDir,
} from "../../config/openwiki-home.js";
import { createConnectorRegistry } from "../../connectors/registry.js";
import type { ConnectorId } from "../../connectors/types.js";
import { computePersonalFrontier } from "../../generation/personal-run.js";
import {
  getPersonalRunLockAgeMs,
  isPersonalRunLockExpired,
  readPersonalRunLock,
} from "../../generation/personal-run-lock.js";
import {
  CONNECTOR_ID_PATTERN,
  readPersonalRunState,
  readSynthesisCursor,
  type PersonalRunMode,
  type PersonalRunPhase,
  type SynthesisCursorEntry,
} from "../../generation/personal-run-state.js";
import { isFileNotFoundError } from "../../platform/fs-errors.js";
import { readOpenWikiOnboardingConfig } from "../../setup/onboarding.js";

/**
 * The personal wiki's last recorded run, from `.last-update.json`.
 */
export interface PersonalLastUpdate {
  /**
   * When the run was recorded.
   */
  updatedAt: string;

  /**
   * Command that ran, such as `init` or `update`.
   */
  command: string | null;

  /**
   * Model or host identity that ran it.
   */
  model: string | null;

  /**
   * `complete` or `interrupted`.
   */
  status: string | null;

  /**
   * Wiki language, when recorded.
   */
  language: string | null;
}

/**
 * One configured source instance.
 */
export interface PersonalSourceInstanceStatus {
  /**
   * Instance ID.
   */
  id: string;

  /**
   * Connector that serves the instance.
   */
  connectorId: ConnectorId;

  /**
   * Display name, or `null`.
   */
  name: string | null;

  /**
   * When the instance was connected, or `null` when it is not connected.
   */
  connectedAt: string | null;

  /**
   * The user's ingestion goal for the instance, or `null`.
   */
  ingestionGoal: string | null;
}

/**
 * Whether one personal connector has what a pull needs. Reports key names and
 * their presence, never their values.
 */
export interface PersonalConnectorReadiness {
  /**
   * Connector ID.
   */
  id: ConnectorId;

  /**
   * Whether the connector's `config.json` exists.
   */
  configExists: boolean;

  /**
   * Each required environment key and whether it is set in the process or in
   * `<home>/.env`.
   */
  requiredEnv: { key: string; set: boolean }[];

  /**
   * Whether the config exists and every required key is set.
   */
  ready: boolean;
}

/**
 * The lock on the active run.
 */
export interface PersonalRunLockStatus {
  /**
   * `<driver>:<hostname>:<pid>` of the process holding the run.
   */
  holder: string;

  /**
   * ISO time of the holder's latest activity.
   */
  renewedAt: string;

  /**
   * Milliseconds since `renewedAt`.
   */
  ageMs: number;

  /**
   * Whether the lock may be taken over: unrenewed for 30 minutes, or held by
   * a dead process on this machine.
   */
  expired: boolean;
}

/**
 * The active personal run, from `.run.json` and `.run.lock`.
 */
export interface PersonalActiveRunStatus {
  /**
   * Run ID.
   */
  runId: string;

  /**
   * `init` or `update`.
   */
  mode: PersonalRunMode;

  /**
   * Current lifecycle phase.
   */
  phase: PersonalRunPhase;

  /**
   * ISO time the run began.
   */
  startedAt: string;

  /**
   * The lock, or `null` when no process holds the run and any driver may
   * resume it.
   */
  lock: PersonalRunLockStatus | null;
}

/**
 * The `openwiki_personal_status` result (host §3.4).
 */
export interface PersonalStatus {
  /**
   * Absolute personal wiki directory.
   */
  wikiDir: string;

  /**
   * The last recorded run, or `null` when none is recorded.
   */
  lastUpdate: PersonalLastUpdate | null;

  /**
   * The user's wiki goal, or `null`.
   */
  wikiGoal: string | null;

  /**
   * Configured source instances.
   */
  sourceInstances: PersonalSourceInstanceStatus[];

  /**
   * Readiness of every personal connector.
   */
  connectors: PersonalConnectorReadiness[];

  /**
   * The synthesis cursor: per connector, the raw run it is synthesized
   * through. A connector no run has consumed is absent.
   */
  synthesisCursor: Record<string, SynthesisCursorEntry>;

  /**
   * Per connected connector, the raw runs the next run would consume: those
   * newer than its cursor, or only the newest when it has no cursor (core
   * §3.2).
   */
  pending: Record<string, number>;

  /**
   * The active run, or `null` when no run is active.
   */
  activeRun: PersonalActiveRunStatus | null;
}

/**
 * Reports the personal wiki, its sources, connector readiness, and the
 * lifecycle core's state without loading the connector environment (host
 * §3.1, §3.4).
 *
 * @returns The personal status.
 * @throws RepositoryRunError (`invalid_state`) when a state file is corrupt.
 */
export async function readPersonalStatus(): Promise<PersonalStatus> {
  const onboarding = await readOpenWikiOnboardingConfig();
  const savedKeys = await listSavedOpenWikiEnvKeys();
  const connectors: PersonalConnectorReadiness[] = [];
  for (const connector of Object.values(createConnectorRegistry())) {
    if (connector.mode !== "personal") continue;
    const configExists = await isRegularFile(
      getConnectorConfigPath(connector.id),
    );
    const requiredEnv = connector.requiredEnv.map((key) => ({
      key,
      set: Boolean(process.env[key]?.trim()) || savedKeys.has(key),
    }));
    connectors.push({
      id: connector.id,
      configExists,
      requiredEnv,
      ready: configExists && requiredEnv.every((env) => env.set),
    });
  }

  const cursor = await readSynthesisCursor(openWikiLocalWikiDir);
  const connected = [
    ...new Set(
      onboarding.sourceInstances
        .filter(
          ({ connectedAt, connectorId }) =>
            Boolean(connectedAt) && CONNECTOR_ID_PATTERN.test(connectorId),
        )
        .map(({ connectorId }) => connectorId),
    ),
  ];
  const pending: Record<string, number> = Object.fromEntries(
    connected.sort().map((connectorId) => [connectorId, 0]),
  );
  for (const entry of await computePersonalFrontier(connected, cursor)) {
    pending[entry.connectorId] = entry.rawRunIds.length;
  }

  return {
    wikiDir: openWikiLocalWikiDir,
    lastUpdate: await readLastUpdate(),
    wikiGoal: onboarding.wikiGoal?.trim() || null,
    sourceInstances: onboarding.sourceInstances.map((instance) => ({
      id: instance.id,
      connectorId: instance.connectorId,
      name: instance.name ?? null,
      connectedAt: instance.connectedAt ?? null,
      ingestionGoal: instance.ingestionGoal ?? null,
    })),
    connectors,
    synthesisCursor: cursor.connectors,
    pending,
    activeRun: await readActiveRun(),
  };
}

/**
 * Reads the active run and its lock.
 *
 * @returns The active run, or `null` when `.run.json` is absent.
 */
async function readActiveRun(): Promise<PersonalActiveRunStatus | null> {
  const state = await readPersonalRunState(openWikiLocalWikiDir);
  if (!state) return null;
  const lock = await readPersonalRunLock(openWikiLocalWikiDir);
  return {
    runId: state.runId,
    mode: state.mode,
    phase: state.phase,
    startedAt: state.startedAt,
    lock: lock && {
      holder: lock.holder,
      renewedAt: lock.renewedAt,
      ageMs: getPersonalRunLockAgeMs(lock),
      expired: isPersonalRunLockExpired(lock),
    },
  };
}

/**
 * Reads the personal wiki's `.last-update.json`.
 *
 * @returns The recorded run, or `null` when the file is absent, a symbolic
 *   link, or not a run record.
 */
async function readLastUpdate(): Promise<PersonalLastUpdate | null> {
  const file = path.join(openWikiLocalWikiDir, ".last-update.json");
  if (!(await isRegularFile(file))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.updatedAt !== "string") return null;
  return {
    updatedAt: parsed.updatedAt,
    command: stringOrNull(parsed.command),
    model: stringOrNull(parsed.model),
    status: stringOrNull(parsed.status),
    language: stringOrNull(parsed.language),
  };
}

/**
 * Checks for a regular file without following a symbolic link.
 *
 * @param file - Absolute path.
 * @returns Whether the path is a regular file.
 */
async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isFile();
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw error;
  }
}

/**
 * Narrows a value to a string.
 *
 * @param value - Unknown parsed JSON value.
 * @returns The string, or `null`.
 */
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Narrows an unknown value to a non-array object.
 *
 * @param value - Unknown parsed JSON value.
 * @returns Whether the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
