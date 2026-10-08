import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

// Isolated OpenWiki home: the core resolves the wiki, raw store, and
// onboarding.json from OPENWIKI_CONFIG_DIR when its modules load.
const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const directory = mkdtempSync(path.join(tmpdir(), "openwiki-personal-run-"));
  vi.stubEnv("OPENWIKI_CONFIG_DIR", directory);
  return directory;
});

const failureHarness = vi.hoisted(() => ({ metadataWrites: 0 }));

vi.mock("../../src/agent/utils.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/agent/utils.js")>();
  return {
    ...actual,
    async writeLastUpdateMetadata(
      ...args: Parameters<typeof actual.writeLastUpdateMetadata>
    ) {
      if (failureHarness.metadataWrites > 0) {
        failureHarness.metadataWrites -= 1;
        throw new Error("injected metadata failure");
      }
      return actual.writeLastUpdateMetadata(...args);
    },
  };
});

import { createOpenWikiContentSnapshot } from "../../src/agent/utils.ts";
import { RepositoryRunError } from "../../src/generation/errors.ts";
import {
  beginPersonalRun,
  capturePersonalPageSnapshot,
  closePersonalGathering,
  editPersonalPage,
  finishPersonalRun,
  nextPersonalPage,
  readPersonalOpenQuestions,
  readPersonalPageVersion,
  releasePersonalRun,
  restorePersonalPage,
  skipPersonalPage,
  submitPersonalPage,
  submitPersonalPlan,
  writePersonalPage,
  type ActivePersonalRun,
  type BeginPersonalRunInput,
  type PersonalBeginView,
  type PersonalPageJobView,
} from "../../src/generation/personal-run.ts";
import {
  PersonalRunLockConflictError,
  acquirePersonalRunLock,
  readPersonalRunLock,
} from "../../src/generation/personal-run-lock.ts";
import {
  parseRawEvidenceRef,
  readPersonalRunState,
  readSynthesisCursor,
  requireFrontierEvidence,
  writePersonalRunState,
  writeSynthesisCursor,
  type PersonalPageJob,
} from "../../src/generation/personal-run-state.ts";
import { readRepositoryRunState } from "../../src/generation/run-state.ts";

const wikiDir = path.join(home, "wiki");
const holderA = `native:${os.hostname()}:${process.pid}`;
const holderB = `host-claude:${os.hostname()}:${process.pid}`;
const actor = { producerActor: "openwiki/test", metadataModel: "test-model" };

const RUN_1 = "2026-10-05T06-00-00-000Z";
const RUN_2 = "2026-10-06T06-00-00-000Z";
const RUN_3 = "2026-10-07T06-00-00-000Z";

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  failureHarness.metadataWrites = 0;
  for (const entry of await readdir(home)) {
    await rm(path.join(home, entry), { recursive: true, force: true });
  }
  await mkdir(wikiDir, { recursive: true });
});

/**
 * Marks connectors as connected sources in onboarding.json.
 */
async function connect(...connectorIds: string[]): Promise<void> {
  await writeFile(
    path.join(home, "onboarding.json"),
    JSON.stringify({
      version: 1,
      sourceInstances: connectorIds.map((connectorId) => ({
        id: connectorId,
        connectorId,
        connectedAt: "2026-10-01T00:00:00.000Z",
      })),
    }),
  );
}

/**
 * Writes one raw run with the given JSON files.
 */
async function writeRawRun(
  connectorId: string,
  rawRunId: string,
  files: Record<string, unknown> = { "items.json": { items: [1] } },
): Promise<void> {
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(
      home,
      "connectors",
      connectorId,
      "raw",
      rawRunId,
      name,
    );
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  }
}

/**
 * Writes one wiki page.
 */
async function writePage(page: string, markdown: string): Promise<void> {
  const file = path.join(wikiDir, page);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, markdown);
}

/**
 * Begins a run with test defaults.
 */
function begin(input: Partial<BeginPersonalRunInput> = {}) {
  return beginPersonalRun({
    mode: "update",
    actor,
    holder: holderA,
    ...input,
  });
}

/**
 * Begins a run that must be active.
 */
async function beginActive(
  input: Partial<BeginPersonalRunInput> = {},
): Promise<{ run: ActivePersonalRun; view: PersonalBeginView }> {
  const result = await begin(input);
  if (!("run" in result)) throw new Error("expected an active run");
  return result;
}

/**
 * Installs a plan the way plan submission will, for finish tests.
 */
async function installPlan(
  run: ActivePersonalRun,
  jobs: Array<Partial<PersonalPageJob> & Pick<PersonalPageJob, "path">>,
  deletePages: string[] = [],
): Promise<PersonalPageJob[]> {
  const pages = jobs.map((job) => ({
    id: randomUUID(),
    title: job.path,
    purpose: `Maintain ${job.path}`,
    seedEvidence: [],
    relatedPages: [],
    instructions: [],
    status: "pending" as const,
    ...job,
  }));
  const state = {
    ...run.state,
    phase: "generating" as const,
    plan: { pages, deletePages },
  };
  await writePersonalRunState(run.wikiDir, state);
  run.state = state;
  return pages;
}

/**
 * Captures a rejection so its type and fields can be asserted.
 */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}

/**
 * Whether a wiki-relative file exists.
 */
async function exists(relative: string): Promise<boolean> {
  try {
    await stat(path.join(wikiDir, relative));
    return true;
  } catch {
    return false;
  }
}

async function readLastUpdate(): Promise<{ status: string; command: string }> {
  return JSON.parse(
    await readFile(path.join(wikiDir, ".last-update.json"), "utf8"),
  ) as { status: string; command: string };
}

/**
 * Returns the pid of a process on this machine that has exited.
 */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid;
}

describe("evidence frontier (PLC-004, PLC-005)", () => {
  test("takes raw runs after the cursor, or only the newest without one", async () => {
    await connect("google", "slack", "x");
    for (const rawRunId of [RUN_1, RUN_2, RUN_3]) {
      await writeRawRun("google", rawRunId);
      await writeRawRun("slack", rawRunId, {
        "messages.json": {},
        "threads/t1.json": {},
        ".DS_Store": "",
      });
    }
    await writeSynthesisCursor(wikiDir, {
      schemaVersion: 1,
      connectors: {
        google: { synthesizedThrough: RUN_1, at: "t", runId: "r" },
        x: { synthesizedThrough: RUN_3, at: "t", runId: "r" },
      },
    });

    const { view } = await beginActive();

    expect(view.phase).toBe("planning");
    expect(view.frontier).toEqual([
      {
        connectorId: "google",
        rawRunIds: [RUN_2, RUN_3],
        rawFiles: [`${RUN_2}/items.json`, `${RUN_3}/items.json`],
        frozen: true,
      },
      {
        connectorId: "slack",
        rawRunIds: [RUN_3],
        rawFiles: [`${RUN_3}/messages.json`, `${RUN_3}/threads/t1.json`],
        frozen: true,
      },
    ]);
  });

  test("narrows to scope.connectors and ignores unconnected connectors", async () => {
    await connect("google", "slack");
    await writeRawRun("google", RUN_1);
    await writeRawRun("slack", RUN_1);
    await writeRawRun("hackernews", RUN_1);

    const { view } = await beginActive({
      scope: { connectors: ["slack", "hackernews"] },
    });

    expect(view.frontier.map(({ connectorId }) => connectorId)).toEqual([
      "slack",
    ]);
    expect(view.warnings).toEqual([
      expect.stringContaining("hackernews is not connected"),
    ]);
  });

  test("a raw run written after begin is not added to a frozen frontier", async () => {
    await connect("google");
    await writeRawRun("google", RUN_1);
    const { run } = await beginActive();
    await releasePersonalRun(run);

    await writeRawRun("google", RUN_2);
    const { view } = await beginActive();

    expect(view.resumed).toBe(true);
    expect(view.frontier[0]?.rawRunIds).toEqual([RUN_1]);
  });

  test("gathering adds only raw runs written since begin, then freezes", async () => {
    await connect("google", "notion");
    await writeRawRun("google", RUN_1);
    await writeRawRun("notion", RUN_1);
    await writeRawRun("notion", RUN_2);

    const { run, view } = await beginActive({
      now: () => new Date("2026-10-07T06:00:00.000Z"),
    });
    expect(view.phase).toBe("gathering");
    expect(view.frontier).toContainEqual({
      connectorId: "notion",
      rawRunIds: [RUN_2],
      rawFiles: [`${RUN_2}/items.json`],
      frozen: false,
    });

    // Written by proxied MCP calls during gathering, after startedAt.
    const gathered = "2026-10-07T06-02-10-004Z";
    await writeRawRun("notion", gathered, { "mcp-results.json": {} });
    const closed = await closePersonalGathering(run);

    expect(closed.phase).toBe("planning");
    expect(closed.frontier).toContainEqual({
      connectorId: "notion",
      rawRunIds: [RUN_2, gathered],
      rawFiles: [`${RUN_2}/items.json`, `${gathered}/mcp-results.json`],
      frozen: true,
    });
    await expect(closePersonalGathering(run)).rejects.toMatchObject({
      code: "invalid_state",
    });

    await writeRawRun("notion", "2026-10-07T07-00-00-000Z");
    await releasePersonalRun(run);
    const resumed = await beginActive();
    expect(resumed.view.phase).toBe("planning");
    expect(
      resumed.view.frontier.find(({ connectorId }) => connectorId === "notion")
        ?.rawRunIds,
    ).toEqual([RUN_2, gathered]);
  });

  test("an agentic connector with nothing new still needs gathering", async () => {
    await connect("notion");

    const { view } = await beginActive();

    expect(view.phase).toBe("gathering");
    expect(view.frontier).toEqual([
      { connectorId: "notion", rawRunIds: [], rawFiles: [], frozen: false },
    ]);
  });

  test("drops raw runs the user deleted, with a warning", async () => {
    await connect("google");
    await writeRawRun("google", RUN_1);
    await writeRawRun("google", RUN_2);
    await writeSynthesisCursor(wikiDir, {
      schemaVersion: 1,
      connectors: {
        google: {
          synthesizedThrough: "2026-10-01T00-00-00-000Z",
          at: "t",
          runId: "r",
        },
      },
    });
    const { run } = await beginActive();
    await releasePersonalRun(run);

    await rm(path.join(home, "connectors", "google", "raw", RUN_1), {
      recursive: true,
    });
    const { view } = await beginActive();

    expect(view.frontier[0]).toMatchObject({
      rawRunIds: [RUN_2],
      rawFiles: [`${RUN_2}/items.json`],
    });
    expect(view.warnings).toEqual([
      `Raw run google/${RUN_1} was deleted; its evidence was dropped from this run.`,
    ]);
  });

  test("a corrupt cursor fails begin with invalid_state and writes nothing", async () => {
    await connect("google");
    await writeRawRun("google", RUN_1);
    await writeFile(path.join(wikiDir, ".synthesis-cursor.json"), "{ nope");

    const error = await rejection(begin());

    expect(error).toBeInstanceOf(RepositoryRunError);
    expect(error).toMatchObject({ code: "invalid_state" });
    expect((error as Error).message).toContain(".synthesis-cursor.json");
    expect(await exists(".run.json")).toBe(false);
    expect(await exists(".run.lock")).toBe(false);
  });

  test("tolerates unknown fields in the cursor", async () => {
    await writeFile(
      path.join(wikiDir, ".synthesis-cursor.json"),
      JSON.stringify({
        schemaVersion: 1,
        extra: true,
        connectors: {
          google: { synthesizedThrough: RUN_1, at: "t", runId: "r", note: 1 },
        },
      }),
    );

    expect((await readSynthesisCursor(wikiDir)).connectors.google).toEqual({
      synthesizedThrough: RUN_1,
      at: "t",
      runId: "r",
    });
  });
});

describe("raw:// evidence refs", () => {
  test("parses a ref with an RFC 6901 fragment", () => {
    expect(
      parseRawEvidenceRef(
        `raw://google/${RUN_1}/gmail-messages.json#/messages/3`,
      ),
    ).toEqual({
      connectorId: "google",
      rawRunId: RUN_1,
      file: "gmail-messages.json",
      rawFile: `${RUN_1}/gmail-messages.json`,
      pointer: "/messages/3",
    });
    expect(
      parseRawEvidenceRef(`raw://slack/${RUN_1}/threads/t1.json#/a~1b/c%20d`)
        .pointer,
    ).toBe("/a~1b/c d");
  });

  test.each([
    "https://google/x.json",
    `raw://Google/${RUN_1}/x.json`,
    "raw://google/latest/x.json",
    `raw://google/${RUN_1}`,
    `raw://google/${RUN_1}/../x.json`,
    `raw://google/${RUN_1}/a//x.json`,
    `raw://google/${RUN_1}/x.json#messages`,
    `raw://google/${RUN_1}/x.json#/a~2`,
  ])("rejects malformed ref %s", (ref) => {
    expect(() => parseRawEvidenceRef(ref)).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  test("rejects refs outside the frontier", () => {
    const frontier = [
      {
        connectorId: "google",
        rawRunIds: [RUN_2],
        rawFiles: [`${RUN_2}/items.json`],
        frozen: true,
      },
    ];

    expect(
      requireFrontierEvidence(frontier, `raw://google/${RUN_2}/items.json#/0`)
        .rawFile,
    ).toBe(`${RUN_2}/items.json`);
    for (const ref of [
      `raw://google/${RUN_1}/items.json`,
      `raw://google/${RUN_2}/other.json`,
      `raw://slack/${RUN_2}/items.json`,
    ]) {
      expect(() => requireFrontierEvidence(frontier, ref)).toThrow(
        expect.objectContaining({ code: "invalid_input" }),
      );
    }
  });
});

describe("state files", () => {
  test("are excluded from the content snapshot (PLC-006)", async () => {
    await writePage("topics/a.md", "# A\n");
    const before = await createOpenWikiContentSnapshot(wikiDir, "local-wiki");

    for (const name of [
      ".run.json",
      ".run.lock",
      ".synthesis-cursor.json",
      ".run.lock.123.abc.tmp",
      ".run.lock.123.abc.stale",
      ".synthesis-cursor.json.123.abc.tmp",
    ]) {
      await writeFile(path.join(wikiDir, name), "{}");
    }

    expect(await createOpenWikiContentSnapshot(wikiDir, "local-wiki")).toBe(
      before,
    );
    await writePage("topics/a.md", "# A changed\n");
    expect(await createOpenWikiContentSnapshot(wikiDir, "local-wiki")).not.toBe(
      before,
    );
  });

  test("code-mode and personal readers reject each other's checkpoint", async () => {
    await connect("google");
    await writeRawRun("google", RUN_1);
    await beginActive();
    const repositoryRoot = path.join(home, "repo");
    await mkdir(path.join(repositoryRoot, "openwiki"), { recursive: true });
    await writeFile(
      path.join(repositoryRoot, "openwiki", ".run.json"),
      await readFile(path.join(wikiDir, ".run.json")),
    );

    await expect(readRepositoryRunState(repositoryRoot)).rejects.toMatchObject({
      code: "invalid_state",
    });

    const personal = JSON.parse(
      await readFile(path.join(wikiDir, ".run.json"), "utf8"),
    ) as Record<string, unknown>;
    delete personal.kind;
    await writeFile(path.join(wikiDir, ".run.json"), JSON.stringify(personal));
    await expect(readPersonalRunState(wikiDir)).rejects.toMatchObject({
      code: "invalid_state",
    });
  });
});

describe("beginPersonalRun", () => {
  test("an update with no evidence, request, or rewrites is a no-op (PLC-010)", async () => {
    await connect("google");

    const result = await begin();

    expect(result.view).toEqual({
      status: "noop",
      mode: "update",
      language: "en",
      warnings: [],
    });
    expect(await exists(".run.json")).toBe(false);
    expect(await exists(".run.lock")).toBe(false);
    expect(await readLastUpdate()).toMatchObject({ status: "complete" });
  });

  test("an instruction makes an empty update a run", async () => {
    await connect("google");

    const { view } = await beginActive({ instruction: "  Tidy themes.  " });

    expect(view).toMatchObject({
      phase: "planning",
      instruction: "Tidy themes.",
      frontier: [],
    });
  });

  test("writes state, interrupted metadata, and the lock", async () => {
    await connect("google");
    await writeRawRun("google", RUN_1);
    await writePage("topics/a.md", "# A\n\nBody.\n");
    await writePage("index.md", "# Index\n");

    const { run, view } = await beginActive({ mode: "init" });

    expect(view).toMatchObject({
      status: "active",
      mode: "init",
      phase: "planning",
      language: "en",
      resumed: false,
      completedPages: 0,
    });
    const state = await readPersonalRunState(wikiDir);
    expect(state).toMatchObject({
      kind: "personal",
      runId: view.runId,
      initialPages: ["/topics/a.md"],
      requiredRewritePages: [],
    });
    expect(await readLastUpdate()).toMatchObject({
      status: "interrupted",
      command: "init",
    });
    expect(await readPersonalRunLock(wikiDir)).toMatchObject({
      holder: holderA,
      runId: run.state.runId,
    });
  });

  test("a language change on update requires rewriting every page", async () => {
    await connect("google");
    await writePage("topics/a.md", "# A\n");
    await writeFile(
      path.join(wikiDir, ".last-update.json"),
      JSON.stringify({
        updatedAt: "2026-10-01T00:00:00.000Z",
        command: "update",
        model: "m",
        status: "complete",
        language: "en",
      }),
    );

    const { view, run } = await beginActive({ language: "fr" });

    expect(view).toMatchObject({ language: "fr", languageChanged: true });
    expect(run.state.requiredRewritePages).toEqual(["/topics/a.md"]);
  });

  test("an unrecognized language fails before anything is written", async () => {
    await connect("google");
    await writeRawRun("google", RUN_1);

    await expect(begin({ language: "klingonese" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(await readdir(wikiDir)).toEqual([]);
  });

  test("resume rejects a different mode or language, and releases the lock", async () => {
    await connect("google");
    await writeRawRun("google", RUN_1);
    const { run } = await beginActive();
    await releasePersonalRun(run);

    await expect(begin({ mode: "init" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(begin({ language: "de" })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await exists(".run.lock")).toBe(false);
    expect(await exists(".run.json")).toBe(true);
  });

  test("rejects a malformed holder or scope", async () => {
    await expect(begin({ holder: "native" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      begin({ scope: { pages: ["/topics/../x.md"] } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      begin({ scope: { connectors: ["Google"] } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("single-writer lock (PLC-013, PLC-019)", () => {
  async function seedRun(): Promise<ActivePersonalRun> {
    await connect("google");
    await writeRawRun("google", RUN_1);
    return (await beginActive()).run;
  }

  async function writeLock(lock: {
    holder: string;
    runId: string;
    renewedAt: string;
  }): Promise<void> {
    await writeFile(
      path.join(wikiDir, ".run.lock"),
      JSON.stringify({ ...lock, acquiredAt: lock.renewedAt }),
    );
  }

  test("begin while a fresh lock exists returns conflict with the holder and age", async () => {
    const run = await seedRun();

    const error = await rejection(begin({ holder: holderB, takeover: true }));

    expect(error).toBeInstanceOf(PersonalRunLockConflictError);
    expect(error).toMatchObject({
      code: "conflict",
      holder: holderA,
      expired: false,
    });
    expect(
      (error as PersonalRunLockConflictError).ageMs,
    ).toBeGreaterThanOrEqual(0);
    expect(await readPersonalRunLock(wikiDir)).toMatchObject({
      holder: holderA,
      runId: run.state.runId,
    });
  });

  test("a failed begin by the current holder keeps its run's lock", async () => {
    const run = await seedRun();

    await expect(begin({ mode: "init" })).rejects.toMatchObject({
      code: "conflict",
    });

    expect(await readPersonalRunLock(wikiDir)).toMatchObject({
      holder: holderA,
      runId: run.state.runId,
    });
    await expect(closePersonalGathering(run)).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  test("an expired lock is taken over only with takeover", async () => {
    const run = await seedRun();
    await writeLock({
      holder: "native:other-host:4711",
      runId: run.state.runId,
      renewedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(begin({ holder: holderB })).rejects.toMatchObject({
      code: "conflict",
      expired: true,
    });

    const { view } = await beginActive({ holder: holderB, takeover: true });
    expect(view).toMatchObject({ resumed: true, runId: run.state.runId });
    expect(await readPersonalRunLock(wikiDir)).toMatchObject({
      holder: holderB,
      runId: run.state.runId,
    });
  });

  test("two simultaneous takeovers yield exactly one holder", async () => {
    const run = await seedRun();
    await writeLock({
      holder: "native:other-host:4711",
      runId: run.state.runId,
      renewedAt: "2026-01-01T00:00:00.000Z",
    });

    const results = await Promise.allSettled([
      begin({ holder: holderA, takeover: true }),
      begin({ holder: holderB, takeover: true }),
    ]);

    const winners = results.filter(({ status }) => status === "fulfilled");
    const losers = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.reason).toMatchObject({ code: "conflict" });
    const winner = results[0]?.status === "fulfilled" ? holderA : holderB;
    expect((await readPersonalRunLock(wikiDir))?.holder).toBe(winner);
    expect(
      (await readdir(wikiDir)).filter((name) => name.startsWith(".run.lock.")),
    ).toEqual([]);
  });

  test("a taker never removes a lock that another taker just acquired", async () => {
    const lockFile = path.join(wikiDir, ".run.lock");
    const fresh = JSON.stringify({
      holder: holderB,
      runId: "run-b",
      acquiredAt: new Date().toISOString(),
      renewedAt: new Date().toISOString(),
    });
    await writeLock({
      holder: `native:${os.hostname()}:4711`,
      runId: "run-a",
      renewedAt: new Date().toISOString(),
    });

    const error = await rejection(
      acquirePersonalRunLock(wikiDir, {
        holder: holderA,
        runId: "run-a",
        takeover: true,
        // Judges the stale lock expired, then lets another taker win before
        // this one moves the lock aside.
        isPidAlive: () => {
          writeFileSync(lockFile, fresh);
          return false;
        },
      }),
    );

    expect(error).toMatchObject({ code: "conflict", holder: holderB });
    expect(await readFile(lockFile, "utf8")).toBe(fresh);
    expect(
      (await readdir(wikiDir)).filter((name) => name.startsWith(".run.lock.")),
    ).toEqual([]);
  });

  test("a same-host lock with a dead pid is expired at once", async () => {
    const run = await seedRun();
    // Simulates a native driver that crashed without releasing the lock.
    await writeLock({
      holder: `native:${os.hostname()}:${deadPid()}`,
      runId: run.state.runId,
      renewedAt: new Date().toISOString(),
    });

    await expect(begin({ holder: holderB })).rejects.toMatchObject({
      code: "conflict",
      expired: true,
    });
    const { view } = await beginActive({ holder: holderB, takeover: true });
    expect(view.runId).toBe(run.state.runId);
  });

  test("operations other than begin fail once the lock is lost", async () => {
    await connect("notion");
    const { run } = await beginActive();
    await writeLock({
      holder: holderB,
      runId: run.state.runId,
      renewedAt: new Date().toISOString(),
    });

    await expect(closePersonalGathering(run)).rejects.toMatchObject({
      code: "conflict",
    });
    await rm(path.join(wikiDir, ".run.lock"));
    await expect(closePersonalGathering(run)).rejects.toMatchObject({
      code: "conflict",
    });
    await installPlan(run, [{ path: "/quickstart.md" }]);
    await expect(finishPersonalRun(run)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await exists(".run.json")).toBe(true);
  });

  test("a released run is resumed and finished by another driver", async () => {
    const run = await seedRun();
    const [job] = await installPlan(run, [
      {
        path: "/sources/google.md",
        seedEvidence: [`raw://google/${RUN_1}/items.json`],
        status: "skipped",
      },
    ]);
    await releasePersonalRun(run);
    expect(await exists(".run.lock")).toBe(false);

    const resumed = await beginActive({ holder: holderB });

    expect(resumed.view).toMatchObject({
      resumed: true,
      runId: run.state.runId,
    });
    expect(resumed.run.state.plan?.pages[0]).toMatchObject({
      id: job?.id,
      status: "pending",
    });
    await writePage("sources/google.md", "# Google\n\nSynthesized.\n");
    await installPlan(resumed.run, [
      { ...job, status: "complete", completedBy: "host-agent/claude" },
    ]);

    await expect(finishPersonalRun(resumed.run)).resolves.toMatchObject({
      status: "complete",
      advancedConnectors: ["google"],
    });
    expect(await exists(".run.lock")).toBe(false);
  });
});

describe("finishPersonalRun", () => {
  test("finalizes, advances cursors, and removes state then lock", async () => {
    await connect("google");
    await writeRawRun("google", RUN_1);
    await writeRawRun("google", RUN_2);
    await writeSynthesisCursor(wikiDir, {
      schemaVersion: 1,
      connectors: {
        google: {
          synthesizedThrough: "2026-10-01T00-00-00-000Z",
          at: "t",
          runId: "r",
        },
      },
    });
    const { run } = await beginActive();
    await writePage("sources/google.md", "# Google\n\nTwo pulls.\n");
    await writePage("quickstart.md", "# Quickstart\n\nStart here.\n");
    await installPlan(run, [
      {
        path: "/sources/google.md",
        seedEvidence: [`raw://google/${RUN_1}/items.json`],
        status: "complete",
        completedBy: "openwiki/test",
      },
      {
        path: "/quickstart.md",
        status: "complete",
        completedBy: "openwiki/test",
      },
    ]);

    const result = await finishPersonalRun(run, {
      now: () => new Date("2026-10-08T00:00:00.000Z"),
    });

    expect(result).toEqual({
      status: "complete",
      lastUpdateStatus: "complete",
      advancedConnectors: ["google"],
      heldConnectors: [],
    });
    expect((await readSynthesisCursor(wikiDir)).connectors.google).toEqual({
      synthesizedThrough: RUN_2,
      at: "2026-10-08T00:00:00.000Z",
      runId: run.state.runId,
    });
    expect(await readLastUpdate()).toMatchObject({ status: "complete" });
    expect(await exists("index.md")).toBe(true);
    expect(await exists(".run.json")).toBe(false);
    expect(await exists(".run.lock")).toBe(false);
  });

  test("holds the cursor of a connector with a skipped seeded job (PLC-012)", async () => {
    await connect("google", "slack");
    await writeRawRun("google", RUN_1);
    await writeRawRun("slack", RUN_1);
    await writePage("people/dana.md", "# Dana\n\nOriginal.\n");
    const { run } = await beginActive();
    const original = await readFile(
      path.join(wikiDir, "people/dana.md"),
      "utf8",
    );
    const [dana] = await installPlan(run, [
      {
        path: "/people/dana.md",
        seedEvidence: [`raw://google/${RUN_1}/items.json#/items/0`],
        status: "skipped",
      },
      {
        path: "/sources/google.md",
        seedEvidence: [`raw://google/${RUN_1}/items.json`],
        status: "complete",
      },
      {
        path: "/sources/slack.md",
        seedEvidence: [`raw://slack/${RUN_1}/items.json`],
        status: "complete",
      },
    ]);
    await writePage("sources/google.md", "# Google\n");
    await writePage("sources/slack.md", "# Slack\n");
    await writePage(
      "people/dana.md",
      "# Dana\n\nHalf-written by a failed worker.\n",
    );

    await expect(finishPersonalRun(run)).rejects.toMatchObject({
      code: "invalid_state",
    });
    const result = await finishPersonalRun(run, {
      skippedPageSnapshots: [
        { jobId: dana.id, path: "/people/dana.md", markdown: original },
      ],
    });

    expect(result).toMatchObject({
      lastUpdateStatus: "interrupted",
      advancedConnectors: ["slack"],
      heldConnectors: ["google"],
    });
    const cursor = await readSynthesisCursor(wikiDir);
    expect(cursor.connectors.google).toBeUndefined();
    expect(cursor.connectors.slack?.synthesizedThrough).toBe(RUN_1);
    expect(await readFile(path.join(wikiDir, "people/dana.md"), "utf8")).toBe(
      original,
    );
    expect(await readLastUpdate()).toMatchObject({ status: "interrupted" });
  });

  test("init never deletes existing pages (PLC-014)", async () => {
    await connect("google");
    await writePage("topics/kept.md", "# Kept\n\nUser knowledge.\n");
    const { run } = await beginActive({ mode: "init" });
    await writePage("quickstart.md", "# Quickstart\n");
    await installPlan(
      run,
      [{ path: "/quickstart.md", status: "complete" }],
      ["/topics/kept.md"],
    );

    await expect(finishPersonalRun(run)).rejects.toMatchObject({
      code: "invalid_state",
    });
    expect(await exists("topics/kept.md")).toBe(true);

    await installPlan(run, [{ path: "/quickstart.md", status: "complete" }]);
    await finishPersonalRun(run);
    expect(
      await readFile(path.join(wikiDir, "topics/kept.md"), "utf8"),
    ).toContain("User knowledge.");
  });

  test("update applies deletePages", async () => {
    await connect("google");
    await writePage("topics/old.md", "# Old\n");
    const { run } = await beginActive({ instruction: "Remove the old page." });
    await installPlan(run, [], ["/topics/old.md"]);

    await finishPersonalRun(run);

    expect(await exists("topics/old.md")).toBe(false);
  });

  test("refuses pending jobs and a missing plan", async () => {
    await connect("google");
    const { run } = await beginActive({ instruction: "Anything." });

    await expect(finishPersonalRun(run)).rejects.toMatchObject({
      code: "invalid_state",
    });
    await installPlan(run, [{ path: "/quickstart.md" }]);
    await expect(finishPersonalRun(run)).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  test("runs again after a crash before .run.json is removed", async () => {
    await connect("google");
    await writeRawRun("google", RUN_1);
    const { run } = await beginActive();
    await writePage("sources/google.md", "# Google\n");
    await installPlan(run, [
      {
        path: "/sources/google.md",
        seedEvidence: [`raw://google/${RUN_1}/items.json`],
        status: "complete",
      },
    ]);

    failureHarness.metadataWrites = 1;
    await expect(finishPersonalRun(run)).rejects.toThrow(
      "injected metadata failure",
    );
    expect(
      (await readSynthesisCursor(wikiDir)).connectors.google,
    ).toBeDefined();
    expect(await exists(".run.json")).toBe(true);
    expect(await exists(".run.lock")).toBe(true);

    const resumed = await beginActive();
    expect(resumed.view).toMatchObject({
      resumed: true,
      completedPages: 1,
      totalPages: 1,
    });
    await expect(finishPersonalRun(resumed.run)).resolves.toMatchObject({
      status: "complete",
      lastUpdateStatus: "complete",
    });
    expect(
      (await readSynthesisCursor(wikiDir)).connectors.google
        ?.synthesizedThrough,
    ).toBe(RUN_1);
    expect(await exists(".run.json")).toBe(false);
  });
});

describe("plan and page operations", () => {
  const GMAIL = `raw://google/${RUN_1}/items.json`;

  /**
   * Begins an update with one Gmail pull and an existing open-questions page.
   */
  async function seedPlanningRun(): Promise<ActivePersonalRun> {
    await connect("google");
    await writeRawRun("google", RUN_1);
    await writePage(
      "open-questions.md",
      "# Open Questions\n\n## Active\n\n### gym: Where is the class?\n\n## Answered\n",
    );
    return (await beginActive()).run;
  }

  /**
   * Returns the next job, which must be pending.
   */
  async function nextJob(run: ActivePersonalRun): Promise<PersonalPageJobView> {
    const next = await nextPersonalPage(run);
    if (next.status !== "pending") throw new Error("expected a pending job");
    return next.job;
  }

  function sha256(markdown: string): string {
    return `sha256:${createHash("sha256").update(markdown, "utf8").digest("hex")}`;
  }

  test("submitPersonalPlan installs the ordered queue and moves to generating", async () => {
    const run = await seedPlanningRun();

    const result = await submitPersonalPlan(run, {
      pages: [
        {
          path: "/people/dana.md",
          title: "Dana",
          purpose: "New collaborator",
          seedEvidence: [`${GMAIL}#/items/0`],
        },
      ],
    });

    expect(result).toEqual({
      status: "accepted",
      totalPages: 4,
      pages: [
        "/people/dana.md",
        "/sources/google.md",
        "/open-questions.md",
        "/quickstart.md",
      ],
    });
    const persisted = await readPersonalRunState(wikiDir);
    expect(persisted?.phase).toBe("generating");
    expect(persisted?.plan?.pages.map(({ path: page }) => page)).toEqual(
      result.pages,
    );
  });

  test("a rejected plan writes nothing, and the driver can resubmit", async () => {
    const run = await seedPlanningRun();
    const before = await readFile(path.join(wikiDir, ".run.json"), "utf8");

    await expect(
      submitPersonalPlan(run, {
        pages: [
          {
            path: "/a.md",
            title: "A",
            purpose: "A",
            seedEvidence: [`raw://google/${RUN_2}/items.json`],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(await readFile(path.join(wikiDir, ".run.json"), "utf8")).toBe(
      before,
    );
    expect(run.state.phase).toBe("planning");
    await expect(submitPersonalPlan(run, { pages: [] })).resolves.toMatchObject(
      { status: "accepted" },
    );
  });

  test("resubmitting the same plan is accepted; a different one is not", async () => {
    const run = await seedPlanningRun();
    const proposal = {
      pages: [{ path: "/a.md", title: "A", purpose: "A" }],
    };
    const first = await submitPersonalPlan(run, proposal);

    await expect(submitPersonalPlan(run, proposal)).resolves.toEqual(first);
    await expect(submitPersonalPlan(run, { pages: [] })).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  test("a plan is refused while gathering", async () => {
    await connect("notion");
    const { run } = await beginActive();

    await expect(submitPersonalPlan(run, { pages: [] })).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  test("nextPersonalPage returns page versions, honors exclude, then completes", async () => {
    const run = await seedPlanningRun();
    await submitPersonalPlan(run, { pages: [] });

    const first = await nextJob(run);
    expect(first).toMatchObject({
      path: "/sources/google.md",
      mode: "update",
      existing: false,
      pageVersion: "absent",
      seedEvidence: [GMAIL],
    });
    expect(first).not.toHaveProperty("activeEntries");

    const second = await nextPersonalPage(run, {
      exclude: new Set([first.id]),
    });
    expect(second).toMatchObject({
      status: "pending",
      job: { path: "/open-questions.md" },
    });

    for (const job of run.state.plan?.pages ?? []) {
      await writePage(job.path.slice(1), `# ${job.title}\n`);
      await submitPersonalPage(run, { jobId: job.id });
    }
    await expect(nextPersonalPage(run)).resolves.toEqual({
      status: "complete",
    });
  });

  test("a maintenance job carries Active entries and the pages changed so far", async () => {
    const run = await seedPlanningRun();
    await submitPersonalPlan(run, { pages: [] });
    const source = await nextJob(run);
    await writePage("sources/google.md", "# Google\n");
    await submitPersonalPage(run, { jobId: source.id });

    const maintenance = await nextJob(run);

    const markdown = await readFile(
      path.join(wikiDir, "open-questions.md"),
      "utf8",
    );
    expect(maintenance).toMatchObject({
      path: "/open-questions.md",
      maintenance: true,
      seedEvidence: [],
      existing: true,
      pageVersion: sha256(markdown),
      activeEntries: "### gym: Where is the class?",
      changedPages: ["/sources/google.md"],
    });
    await expect(readPersonalOpenQuestions(wikiDir)).resolves.toBe(
      "### gym: Where is the class?",
    );
  });

  test("page writes check baseVersion and report the new version (PLC-017)", async () => {
    const run = await seedPlanningRun();
    await submitPersonalPlan(run, { pages: [] });
    const job = await nextJob(run);

    const written = await writePersonalPage(run, {
      jobId: job.id,
      baseVersion: job.pageVersion,
      content: "# Google\n\nFirst pull.\n",
    });
    const onDisk = await readFile(
      path.join(wikiDir, "sources/google.md"),
      "utf8",
    );
    expect(written).toEqual({
      page: "/sources/google.md",
      bytes: Buffer.byteLength(onDisk),
      version: sha256(onDisk),
      frontmatter: { valid: true, repaired: true, issues: [] },
    });
    expect(onDisk).toMatch(/^---\n/u);

    // A write based on the version before the last write is stale.
    await expect(
      writePersonalPage(run, {
        jobId: job.id,
        baseVersion: job.pageVersion,
        content: "# Overwritten\n",
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    // The user edits the page in an editor while the job runs.
    const userEdit = `${onDisk}\nUser note.\n`;
    await writeFile(path.join(wikiDir, "sources/google.md"), userEdit);
    await expect(
      editPersonalPage(run, {
        jobId: job.id,
        baseVersion: written.version,
        oldString: "First pull.",
        newString: "Second pull.",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      await readFile(path.join(wikiDir, "sources/google.md"), "utf8"),
    ).toBe(userEdit);

    // Re-read, re-apply, and write with the new version.
    const current = await readPersonalPageVersion(run, job.id);
    expect(current).toBe(sha256(userEdit));
    const edited = await editPersonalPage(run, {
      jobId: job.id,
      baseVersion: current,
      oldString: "First pull.",
      newString: "Second pull.",
    });
    const final = await readFile(
      path.join(wikiDir, "sources/google.md"),
      "utf8",
    );
    expect(final).toContain("Second pull.");
    expect(final).toContain("User note.");
    expect(edited.version).toBe(sha256(final));
  });

  test("a write based on absent fails once the page exists", async () => {
    const run = await seedPlanningRun();
    await submitPersonalPlan(run, { pages: [] });
    const job = await nextJob(run);
    await writePage("sources/google.md", "# Created elsewhere\n");

    await expect(
      writePersonalPage(run, {
        jobId: job.id,
        baseVersion: "absent",
        content: "# Google\n",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      await readFile(path.join(wikiDir, "sources/google.md"), "utf8"),
    ).toBe("# Created elsewhere\n");
  });

  test("page writes and submits require a pending job of this run", async () => {
    const run = await seedPlanningRun();
    await expect(
      writePersonalPage(run, {
        jobId: randomUUID(),
        baseVersion: "absent",
        content: "x",
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });

    await submitPersonalPlan(run, { pages: [] });
    await expect(
      writePersonalPage(run, {
        jobId: randomUUID(),
        baseVersion: "absent",
        content: "x",
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await expect(
      submitPersonalPage(run, { jobId: randomUUID() }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const job = await nextJob(run);
    await writePage("sources/google.md", "# Google\n");
    await submitPersonalPage(run, { jobId: job.id });
    await expect(
      writePersonalPage(run, {
        jobId: job.id,
        baseVersion: await sha256Of("sources/google.md"),
        content: "# Late\n",
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  async function sha256Of(relative: string): Promise<string> {
    return sha256(await readFile(path.join(wikiDir, relative), "utf8"));
  }

  test("submitPersonalPage requires the page, repairs it, and is idempotent", async () => {
    const run = await seedPlanningRun();
    await submitPersonalPlan(run, { pages: [] });
    const job = await nextJob(run);

    await expect(
      submitPersonalPage(run, { jobId: job.id }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await writePage("sources/google.md", "# Google\n");
    const first = await submitPersonalPage(run, { jobId: job.id });
    expect(first).toEqual({
      status: "complete",
      page: "/sources/google.md",
      remaining: 2,
    });
    expect(
      await readFile(path.join(wikiDir, "sources/google.md"), "utf8"),
    ).toMatch(/^---\n/u);
    await expect(submitPersonalPage(run, { jobId: job.id })).resolves.toEqual(
      first,
    );
    expect((await readPersonalRunState(wikiDir))?.plan?.pages[0]).toMatchObject(
      { status: "complete", completedBy: actor.producerActor },
    );
  });

  test("restore keeps the job pending; skip restores and resume re-queues it", async () => {
    const run = await seedPlanningRun();
    await submitPersonalPlan(run, { pages: [] });
    await nextJob(run);
    const maintenance = run.state.plan!.pages[1];
    const original = await readFile(
      path.join(wikiDir, "open-questions.md"),
      "utf8",
    );
    const snapshot = await capturePersonalPageSnapshot(run, maintenance.id);

    await writePage("open-questions.md", "# Broken attempt\n");
    await restorePersonalPage(run, snapshot);
    expect(
      await readFile(path.join(wikiDir, "open-questions.md"), "utf8"),
    ).toBe(original);
    expect(run.state.plan!.pages[1].status).toBe("pending");

    await writePage("open-questions.md", "# Second broken attempt\n");
    await skipPersonalPage(run, snapshot);
    expect(
      await readFile(path.join(wikiDir, "open-questions.md"), "utf8"),
    ).toBe(original);
    expect((await readPersonalRunState(wikiDir))?.plan?.pages[1]).toMatchObject(
      { id: maintenance.id, status: "skipped" },
    );
    await expect(skipPersonalPage(run, snapshot)).rejects.toMatchObject({
      code: "invalid_state",
    });

    const resumed = await beginActive();
    expect(resumed.run.state.plan!.pages[1]).toMatchObject({
      id: maintenance.id,
      status: "pending",
    });
  });

  test("page operations fail once the lock is lost", async () => {
    const run = await seedPlanningRun();
    await submitPersonalPlan(run, { pages: [] });
    const job = await nextJob(run);
    await releasePersonalRun(run);

    for (const operation of [
      () => nextPersonalPage(run),
      () => capturePersonalPageSnapshot(run, job.id),
      () =>
        writePersonalPage(run, {
          jobId: job.id,
          baseVersion: "absent",
          content: "# x\n",
        }),
      () => submitPersonalPage(run, { jobId: job.id }),
      () => submitPersonalPlan(run, { pages: [] }),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "conflict" });
    }
    expect(await exists("sources/google.md")).toBe(false);
  });
});

describe("resume after a crash (PLC-011)", () => {
  const PLAN = {
    pages: [
      {
        path: "/people/dana.md",
        title: "Dana",
        purpose: "New collaborator",
        seedEvidence: [`raw://google/${RUN_2}/items.json#/items/0`],
      },
    ],
  };

  /**
   * Drives a run from wherever it stopped to finish, as any driver would.
   */
  async function drive(
    run: ActivePersonalRun,
    stopAfter: number = Number.POSITIVE_INFINITY,
  ): Promise<number> {
    let steps = 0;
    const step = async (operation: () => Promise<unknown>) => {
      if (steps >= stopAfter) throw new Error("crash");
      await operation();
      steps += 1;
    };
    if (run.state.phase === "planning") {
      await step(() => submitPersonalPlan(run, PLAN));
    }
    for (;;) {
      const next = await nextPersonalPage(run);
      if (next.status === "complete") break;
      const { job } = next;
      await step(() =>
        writePersonalPage(run, {
          jobId: job.id,
          baseVersion: job.pageVersion,
          content: `# ${job.title}\n\nFrom ${job.seedEvidence.length} seed(s).\n`,
        }),
      );
      await step(() => submitPersonalPage(run, { jobId: job.id }));
    }
    await step(() => finishPersonalRun(run));
    return steps;
  }

  async function seed(): Promise<void> {
    await connect("google");
    await writeRawRun("google", RUN_2);
    await writePage("quickstart.md", "# Quickstart\n");
  }

  test("a run crashed after any step is resumed and finished", async () => {
    await seed();
    const total = await drive((await beginActive()).run);
    expect(total).toBe(1 + 3 * 2 + 1);

    for (let crashAt = 0; crashAt < total; crashAt += 1) {
      for (const entry of await readdir(home)) {
        await rm(path.join(home, entry), { recursive: true, force: true });
      }
      await mkdir(wikiDir, { recursive: true });
      await seed();

      await expect(drive((await beginActive()).run, crashAt)).rejects.toThrow(
        "crash",
      );
      expect(await exists(".run.json")).toBe(true);

      // The crashed process left its lock; the restarted driver holds the
      // same holder ID and resumes.
      const resumed = await beginActive();
      expect(resumed.view.resumed).toBe(true);
      await drive(resumed.run);

      expect(await exists(".run.json")).toBe(false);
      expect(await exists(".run.lock")).toBe(false);
      expect(await exists("people/dana.md")).toBe(true);
      expect(await exists("sources/google.md")).toBe(true);
      expect(await readLastUpdate()).toMatchObject({ status: "complete" });
      expect(
        (await readSynthesisCursor(wikiDir)).connectors.google
          ?.synthesizedThrough,
      ).toBe(RUN_2);
    }
  });

  test("a crash inside finish is finished by the next begin", async () => {
    await seed();
    const { run } = await beginActive();
    await submitPersonalPlan(run, PLAN);
    for (;;) {
      const next = await nextPersonalPage(run);
      if (next.status === "complete") break;
      await writePersonalPage(run, {
        jobId: next.job.id,
        baseVersion: next.job.pageVersion,
        content: `# ${next.job.title}\n`,
      });
      await submitPersonalPage(run, { jobId: next.job.id });
    }
    // finish fails after finalizing and advancing the cursor.
    failureHarness.metadataWrites = 1;
    await expect(finishPersonalRun(run)).rejects.toThrow(
      "injected metadata failure",
    );
    expect(await exists(".run.json")).toBe(true);

    const resumed = await beginActive();
    await expect(nextPersonalPage(resumed.run)).resolves.toEqual({
      status: "complete",
    });
    await expect(finishPersonalRun(resumed.run)).resolves.toMatchObject({
      lastUpdateStatus: "complete",
    });
    expect(await exists(".run.json")).toBe(false);
  });
});
