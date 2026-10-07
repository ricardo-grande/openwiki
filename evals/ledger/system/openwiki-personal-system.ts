import { spawn } from "node:child_process";
import { open, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SystemRunError } from "../core/errors.js";
import type { SystemRunOutcome, SystemUnderTest } from "../core/types.js";
import type { PersonalChildOutcome } from "./personal-child.js";
import { PENDING_PULLS_FILE } from "./personal-protocol.js";

/**
 * Absolute path of the child entry point.
 */
const CHILD_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "personal-child.ts",
);

/**
 * Name of the child's outcome file, beside the home.
 */
const OUTCOME_FILE = "child-outcome.json";

/**
 * Name of the child's combined stdout and stderr log, beside the home.
 */
const LOG_FILE = "child.log";

/**
 * Most log characters quoted in a failure message.
 */
const MAX_LOG_TAIL = 4_000;

/**
 * Environment keys for connector credentials. The replayed connectors never
 * fetch, so the child gets none of them.
 */
const CONNECTOR_SECRET_PATTERN =
  /^OPENWIKI_(?:GOOGLE|GMAIL|NOTION|SLACK|X|TAVILY|LANGSMITH|GITHUB)_/u;

/**
 * Build the child's environment: the parent's provider configuration with
 * connector credentials removed, OpenWiki pointed at the temporary home, and
 * telemetry off.
 *
 * @param parent - The parent environment.
 * @param homeDir - Temporary OpenWiki home.
 * @param provider - Provider id the system runs with.
 * @param modelId - System model id.
 *
 * @returns The child environment.
 */
export function childEnvironment(
  parent: NodeJS.ProcessEnv,
  homeDir: string,
  provider: string,
  modelId: string | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(parent)) {
    if (!CONNECTOR_SECRET_PATTERN.test(key) && key !== "OPENWIKI_MODEL_ID") {
      env[key] = value;
    }
  }

  env.OPENWIKI_CONFIG_DIR = homeDir;
  env.OPENWIKI_PROVIDER = provider;
  env.OPENWIKI_TELEMETRY_DISABLED = "1";
  env.DO_NOT_TRACK = "1";

  if (modelId !== undefined) {
    env.OPENWIKI_MODEL_ID = modelId;
  }

  return env;
}

/**
 * Options for the personal OpenWiki system adapter.
 */
export interface OpenWikiPersonalSystemOptions {
  /**
   * Provider id OpenWiki should run with.
   */
  provider: string;

  /**
   * Model id for the system under test.
   *
   * @default OpenWiki's own default model for the provider
   */
  modelId?: string;

  /**
   * Parent environment the child inherits provider credentials from.
   *
   * @default process.env
   */
  environment?: NodeJS.ProcessEnv;
}

/**
 * Today's legacy personal path as a System Under Test. Each checkpoint is one
 * OpenWiki invocation in a child process whose `OPENWIKI_CONFIG_DIR` is the
 * replay's temporary home: `personal --init` at T0, then one `openwiki ingest`
 * of the checkpoint's recorded pulls, which the replay names in
 * `pending-pulls.json` beside the home.
 */
export class OpenWikiPersonalSystem implements SystemUnderTest {
  readonly name = "openwiki-personal-legacy";

  constructor(private readonly options: OpenWikiPersonalSystemOptions) {}

  async init(homeDir: string): Promise<SystemRunOutcome> {
    return this.run(homeDir);
  }

  async update(homeDir: string): Promise<SystemRunOutcome> {
    return this.run(homeDir);
  }

  /**
   * Run the child for the checkpoint the replay prepared.
   *
   * @param homeDir - Temporary OpenWiki home.
   *
   * @returns The run outcome.
   *
   * @throws SystemRunError when the child fails or a source fails to ingest.
   */
  private async run(homeDir: string): Promise<SystemRunOutcome> {
    const replayRoot = path.dirname(homeDir);
    const pendingPath = path.join(replayRoot, PENDING_PULLS_FILE);
    const outcomePath = path.join(replayRoot, OUTCOME_FILE);
    const logPath = path.join(replayRoot, LOG_FILE);
    const tsxLoader = pathToFileURL(
      createRequire(import.meta.url).resolve("tsx/esm"),
    ).href;

    await rm(outcomePath, { force: true });
    const log = await open(logPath, "a");
    const start = performance.now();

    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", tsxLoader, CHILD_SCRIPT, pendingPath, outcomePath],
          {
            cwd: replayRoot,
            env: childEnvironment(
              this.options.environment ?? process.env,
              homeDir,
              this.options.provider,
              this.options.modelId,
            ),
            stdio: ["ignore", log.fd, log.fd],
          },
        );
        child.once("error", reject);
        child.once("exit", resolve);
      });

      if (exitCode !== 0) {
        throw new Error(`child exited with code ${String(exitCode)}`);
      }

      const outcome = JSON.parse(
        await readFile(outcomePath, "utf8"),
      ) as PersonalChildOutcome;

      if (outcome.errors.length > 0) {
        throw new Error(`ingestion failed: ${outcome.errors.join("; ")}`);
      }

      return {
        skipped: outcome.skipped,
        durationMs: Math.round(performance.now() - start),
      };
    } catch (error) {
      const tail = (await readFile(logPath, "utf8").catch(() => "")).slice(
        -MAX_LOG_TAIL,
      );
      throw new SystemRunError(
        `OpenWiki personal run failed in ${homeDir}: ${(error as Error).message}${tail ? `\n${tail}` : ""}`,
      );
    } finally {
      await log.close();
    }
  }
}
