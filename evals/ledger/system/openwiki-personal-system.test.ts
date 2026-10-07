import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { SystemRunError } from "../core/errors.js";
import {
  childEnvironment,
  OpenWikiPersonalSystem,
} from "./openwiki-personal-system.js";

const originalConfigDir = process.env.OPENWIKI_CONFIG_DIR;
const tempDirs: string[] = [];

afterEach(async () => {
  vi.resetModules();
  if (originalConfigDir === undefined) {
    delete process.env.OPENWIKI_CONFIG_DIR;
  } else {
    process.env.OPENWIKI_CONFIG_DIR = originalConfigDir;
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-personal-system-"));
  tempDirs.push(dir);
  return dir;
}

describe("childEnvironment", () => {
  test("keeps provider credentials, drops connector secrets, and pins the home", () => {
    const env = childEnvironment(
      {
        PATH: "/bin",
        ANTHROPIC_API_KEY: "provider-key",
        OPENWIKI_GMAIL_ACCESS_TOKEN: "gmail",
        OPENWIKI_SLACK_USER_TOKEN: "slack",
        OPENWIKI_NOTION_TOKEN: "notion",
        OPENWIKI_X_REFRESH_TOKEN: "x",
        OPENWIKI_CONFIG_DIR: "/Users/someone/.openwiki",
        OPENWIKI_MODEL_ID: "stale-model",
      },
      "/tmp/ledger/home",
      "anthropic",
      undefined,
    );

    expect(env).toEqual({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "provider-key",
      OPENWIKI_CONFIG_DIR: "/tmp/ledger/home",
      OPENWIKI_PROVIDER: "anthropic",
      OPENWIKI_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
    });
    expect(
      childEnvironment({}, "/h", "openai", "gpt-x").OPENWIKI_MODEL_ID,
    ).toBe("gpt-x");
  });
});

describe("createReplayConnector", () => {
  test("returns the recorded pull and records the run like the real connector", async () => {
    const home = await tempDir();
    const runId = "2026-03-03T07-00-00-000Z";
    const runDir = path.join(home, "connectors", "google", "raw", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "gmail-messages.json"),
      JSON.stringify({ messageCount: 5, messages: [] }),
    );

    vi.resetModules();
    process.env.OPENWIKI_CONFIG_DIR = home;
    const { createConnectorRegistry } =
      await import("../../../src/connectors/registry.js");
    const { createReplayConnector } = await import("./personal-child.js");
    const connector = createReplayConnector(createConnectorRegistry().google, {
      connectorId: "google",
      instanceId: "gmail",
      rawRunId: runId,
      files: ["gmail-messages.json"],
    });

    const result = await connector.ingest();
    const state = JSON.parse(
      await readFile(
        path.join(home, "connectors", "google", "state.json"),
        "utf8",
      ),
    ) as { lastRunAt: string; runs: Array<{ runId: string }> };

    expect(connector.supportsAgenticDiscovery).toBe(false);
    expect(result).toMatchObject({
      connectorId: "google",
      message: "Fetched 5 Gmail message(s).",
      rawFiles: [path.join(runDir, "gmail-messages.json")],
      runId,
      status: "success",
    });
    expect(state.lastRunAt).toBe("2026-03-03T07:00:00.000Z");
    expect(state.runs.map((run) => run.runId)).toEqual([runId]);
  });
});

describe("OpenWikiPersonalSystem", () => {
  test("reports a failed child run with its log", async () => {
    const replayRoot = await tempDir();
    const home = path.join(replayRoot, "home");
    await mkdir(home);
    // No pending-pulls.json: the child boots, then fails to read its handoff.
    const system = new OpenWikiPersonalSystem({
      provider: "openai",
      environment: {},
    });

    const failure = system.update(home);
    await expect(failure).rejects.toThrow(SystemRunError);
    await expect(failure).rejects.toThrow(/pending-pulls\.json/);
    expect(
      await readFile(path.join(replayRoot, "child.log"), "utf8"),
    ).toContain("ENOENT");
  }, 60_000);
});
