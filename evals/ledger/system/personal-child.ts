/**
 * Child-process entry point for the personal system under test. Runs exactly
 * one OpenWiki personal invocation against the temporary home named by
 * `OPENWIKI_CONFIG_DIR`, then writes a JSON outcome file.
 *
 * It must run in its own process: OpenWiki resolves its home directory into
 * module-level constants at import time (`src/config/openwiki-home.ts`), so the
 * parent eval process cannot redirect it. Usage:
 *
 *   node --import <tsx> personal-child.ts <pending-pulls.json> <outcome.json>
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createOpenWikiThreadId,
  runOpenWikiAgent,
} from "../../../src/agent/index.js";
import {
  ensureOpenWikiHome,
  getConnectorRawDir,
  openWikiConnectorsDisplayPath,
  openWikiHomeDir,
  openWikiLocalWikiDir,
} from "../../../src/config/openwiki-home.js";
import {
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
} from "../../../src/connectors/io.js";
import { createConnectorRegistry } from "../../../src/connectors/registry.js";
import type {
  ConnectorId,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../../../src/connectors/types.js";
import { runOpenWikiIngestion } from "../../../src/ingestion/ingestion.js";
import { rawRunIdToIso } from "../benchmark/personal.js";
import type { PendingPull, PendingPulls } from "./personal-protocol.js";

/**
 * Outcome the child reports to the parent.
 */
export interface PersonalChildOutcome {
  /**
   * Whether OpenWiki made no wiki change (an init no-op, or every source
   * skipped).
   */
  skipped: boolean;

  /**
   * Per-source failures reported by ingestion, empty on success.
   */
  errors: string[];
}

/**
 * The order the real connector writes its raw files in, so the replayed
 * source-update prompt lists them identically. Unlisted files follow, sorted.
 */
const RAW_FILE_ORDER: Partial<Record<string, string[]>> = {
  slack: [
    "identity.json",
    "my-messages-search.json",
    "recent-messages.json",
    "my-recent-messages.json",
    "assistant-search.json",
  ],
};

/**
 * Order a pull's files as the real connector would have written them.
 */
function orderRawFiles(connectorId: string, files: string[]): string[] {
  const order = RAW_FILE_ORDER[connectorId] ?? [];
  const rank = (file: string): number => {
    const position = order.indexOf(file);
    return position === -1 ? order.length : position;
  };

  return [...files].sort(
    (a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0),
  );
}

/**
 * The summary message the real connector returns for a pull.
 */
async function pullMessage(
  connectorId: string,
  rawFiles: string[],
): Promise<string> {
  if (connectorId === "google") {
    const dump = JSON.parse(await readFile(rawFiles[0], "utf8")) as {
      messageCount?: number;
    };
    return `Fetched ${dump.messageCount ?? 0} Gmail message(s).`;
  }

  if (connectorId === "slack") {
    return `Fetched ${rawFiles.length} Slack dump(s).`;
  }

  return `Replayed ${rawFiles.length} recorded file(s).`;
}

/**
 * A connector runtime whose `ingest` returns one recorded pull, already copied
 * into the home by the replay, instead of fetching. It records the run in the
 * connector's `state.json` exactly as the real connector does.
 *
 * @param base - The real connector runtime, for its definition.
 * @param pull - The recorded pull to return.
 *
 * @returns The replay runtime.
 */
export function createReplayConnector(
  base: ConnectorRuntime,
  pull: PendingPull,
): ConnectorRuntime {
  return {
    ...base,
    async ingest(): Promise<ConnectorIngestResult> {
      const rawDir = getConnectorRawDir(base.id);
      const rawFiles = orderRawFiles(base.id, pull.files).map((file) =>
        path.join(rawDir, pull.rawRunId, file),
      );
      const status = rawFiles.length > 0 ? "success" : "skipped";

      await writeConnectorState(
        base.id,
        updateStateWithRun(await readConnectorState(base.id), {
          at: rawRunIdToIso(pull.rawRunId) ?? new Date(0).toISOString(),
          rawFiles,
          runId: pull.rawRunId,
          status,
          warnings: [],
        }),
      );

      return {
        connectorId: base.id,
        message: await pullMessage(base.id, rawFiles),
        rawFiles,
        runId: pull.rawRunId,
        statePath: `${openWikiConnectorsDisplayPath}/${base.id}/state.json`,
        status,
        warnings: [],
      };
    },
  };
}

/**
 * Run onboarding init: `openwiki personal --init` with no raw data.
 */
async function runInit(
  modelId: string | undefined,
): Promise<PersonalChildOutcome> {
  const cwd = openWikiLocalWikiDir;
  const result = await runOpenWikiAgent("init", cwd, {
    isFollowup: false,
    modelId,
    outputMode: "local-wiki",
    threadId: createOpenWikiThreadId(cwd),
  });

  return { skipped: result.skipped === true, errors: [] };
}

/**
 * Run one `openwiki ingest` of the checkpoint's recorded pulls: `all` when they
 * cover every connected source, else one source-instance ingest per pull.
 */
async function runIngest(
  pending: PendingPulls,
  modelId: string | undefined,
): Promise<PersonalChildOutcome> {
  const registry = createConnectorRegistry();
  for (const pull of pending.pulls) {
    const id = pull.connectorId as ConnectorId;
    registry[id] = createReplayConnector(registry[id], pull);
  }

  const targets =
    pending.allSources === true
      ? (["all"] as const)
      : pending.pulls.map((pull) => ({
          kind: "source-instance" as const,
          id: pull.instanceId,
        }));
  const errors: string[] = [];
  let changed = false;

  for (const target of targets) {
    const { results } = await runOpenWikiIngestion(openWikiLocalWikiDir, {
      connectorRegistry: registry,
      modelId,
      target,
    });

    for (const result of results) {
      if (result.status === "error") {
        errors.push(
          `${result.sourceInstanceId}: ${result.deterministicPull?.message ?? "ingestion failed"}`,
        );
      } else if (
        result.status === "agent-updated" &&
        result.agentResult?.skipped !== true
      ) {
        changed = true;
      }
    }
  }

  return { skipped: !changed, errors };
}

/**
 * Read the handoff, run the invocation, and write the outcome.
 */
async function main(): Promise<void> {
  const [pendingPath, outcomePath] = process.argv.slice(2);

  if (pendingPath === undefined || outcomePath === undefined) {
    throw new Error(
      "Usage: personal-child.ts <pending-pulls.json> <outcome.json>",
    );
  }

  if (
    path.resolve(openWikiHomeDir) !==
    path.resolve(process.env.OPENWIKI_CONFIG_DIR ?? "")
  ) {
    throw new Error(
      "Refusing to run without OPENWIKI_CONFIG_DIR set to the replay home.",
    );
  }

  await ensureOpenWikiHome();
  const pending = JSON.parse(
    await readFile(pendingPath, "utf8"),
  ) as PendingPulls;
  const modelId = process.env.OPENWIKI_MODEL_ID || undefined;
  const outcome =
    pending.command === "init"
      ? await runInit(modelId)
      : await runIngest(pending, modelId);

  await writeFile(outcomePath, `${JSON.stringify(outcome)}\n`, "utf8");
}

// Direct-invocation guard: run only as the child script, not when a test
// imports the replay connector.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
