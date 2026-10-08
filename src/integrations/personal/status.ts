import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { listSavedOpenWikiEnvKeys } from "../../config/env.js";
import {
  getConnectorConfigPath,
  openWikiLocalWikiDir,
} from "../../config/openwiki-home.js";
import { createConnectorRegistry } from "../../connectors/registry.js";
import type { ConnectorId } from "../../connectors/types.js";
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
   * The synthesis cursor. `null` until the lifecycle core's state formats
   * ship (host §3.2, "Delivery staging").
   */
  synthesisCursor: null;

  /**
   * Raw runs newer than the cursor, per connector. `null` until the core's
   * state formats ship.
   */
  pending: null;

  /**
   * The active run. `null` until the core's state formats ship.
   */
  activeRun: null;
}

/**
 * Reports the personal wiki, its sources, and connector readiness without
 * loading the connector environment (host §3.1, §3.4).
 *
 * @returns The personal status.
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
    synthesisCursor: null,
    pending: null,
    activeRun: null,
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
