import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { loadBenchmark } from "../benchmark/benchmark.js";
import { WorktreeSafetyError } from "../core/errors.js";
import type { PersonalBenchmark } from "../core/types.js";
import type { PendingPulls } from "../system/personal-protocol.js";
import { isOpenWikiOwnedHomePath, PersonalReplay } from "./personal-replay.js";

const benchmarksDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../benchmarks",
);

describe("PersonalReplay", () => {
  let parent: string;
  let benchmark: PersonalBenchmark;

  beforeEach(async () => {
    parent = await mkdtemp(path.join(tmpdir(), "ledger-personal-replay-"));
    benchmark = (await loadBenchmark(
      path.join(benchmarksDir, "cross-source"),
    )) as PersonalBenchmark;
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  async function pending(replay: PersonalReplay): Promise<PendingPulls> {
    return JSON.parse(
      await readFile(replay.pendingPullsPath, "utf8"),
    ) as PendingPulls;
  }

  test("creates a home with onboarding config and the wiki brief", async () => {
    const replay = await PersonalReplay.create(benchmark, parent);
    const onboarding = JSON.parse(
      await readFile(path.join(replay.rootDir, "onboarding.json"), "utf8"),
    ) as {
      completedAt: string;
      sourceInstances: Array<{
        connectorId: string;
        id: string;
        connectedAt: string;
      }>;
    };

    expect(path.dirname(replay.rootDir)).toBe(
      path.dirname(replay.pendingPullsPath),
    );
    expect(replay.wikiDir).toBe(path.join(replay.rootDir, "wiki"));
    expect(
      await readFile(path.join(replay.rootDir, "INSTRUCTIONS.md"), "utf8"),
    ).toBe(`${benchmark.wikiGoal}\n`);
    // Connected at the start of the first pull's 24-hour window.
    expect(onboarding.completedAt).toBe("2026-03-09T07:00:00.000Z");
    expect(
      onboarding.sourceInstances.map(({ connectorId, id, connectedAt }) => [
        connectorId,
        id,
        connectedAt,
      ]),
    ).toEqual([
      ["google", "gmail", "2026-03-09T07:00:00.000Z"],
      ["slack", "slack", "2026-03-09T07:00:00.000Z"],
    ]);
  });

  test("makes each checkpoint's pulls available and names them in the handoff", async () => {
    const replay = await PersonalReplay.create(benchmark, parent);

    await replay.advanceTo(0);
    expect(await pending(replay)).toEqual({
      checkpointId: "T0",
      command: "init",
      pulls: [],
      allSources: false,
    });

    await replay.advanceTo(1);
    const t1 = await pending(replay);
    expect(t1.allSources).toBe(true);
    expect(t1.pulls.map((pull) => pull.connectorId)).toEqual([
      "google",
      "slack",
    ]);
    expect(
      await readdir(
        path.join(
          replay.rootDir,
          "connectors",
          "slack",
          "raw",
          "2026-03-10T07-00-00-000Z",
        ),
      ),
    ).toEqual(t1.pulls[1].files);
    expect(
      await readFile(
        path.join(
          replay.rootDir,
          "connectors",
          "google",
          "raw",
          "2026-03-10T07-00-00-000Z",
          "gmail-messages.json",
        ),
        "utf8",
      ),
    ).toBe(
      await readFile(
        path.join(
          benchmark.rawRoot,
          "google",
          "2026-03-10T07-00-00-000Z",
          "gmail-messages.json",
        ),
        "utf8",
      ),
    );

    // T2 pulls Slack alone, so it is ingested as one source, not `all`.
    await replay.advanceTo(2);
    const t2 = await pending(replay);
    expect(t2.allSources).toBe(false);
    expect(t2.pulls).toEqual([
      expect.objectContaining({ connectorId: "slack", instanceId: "slack" }),
    ]);
  });

  test("refuses to copy a pull through a symlink the system planted", async () => {
    const replay = await PersonalReplay.create(benchmark, parent);
    const outside = await mkdtemp(path.join(tmpdir(), "ledger-outside-"));

    try {
      await mkdir(path.join(replay.rootDir, "connectors"), { recursive: true });
      await symlink(outside, path.join(replay.rootDir, "connectors", "google"));

      await expect(replay.advanceTo(1)).rejects.toThrow(WorktreeSafetyError);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("flags home changes outside OpenWiki-owned paths", async () => {
    const replay = await PersonalReplay.create(benchmark, parent);
    await replay.advanceTo(1);

    await mkdir(path.join(replay.wikiDir), { recursive: true });
    await writeFile(
      path.join(replay.wikiDir, "quickstart.md"),
      "---\ntype: page\n---\n",
    );
    await writeFile(path.join(replay.rootDir, "onboarding.json"), "{}\n");
    await writeFile(path.join(replay.rootDir, "notes.txt"), "x\n");

    const isolation = (await replay.structuralChecks(1)).find(
      (check) => check.id === "home-isolation",
    );
    expect(isolation?.passed).toBe(false);
    expect(isolation?.details).toEqual(["+ notes.txt", "~ onboarding.json"]);
  });
});

describe("isOpenWikiOwnedHomePath", () => {
  test.each([
    ["wiki/quickstart.md", true],
    ["skills/x/SKILL.md", true],
    ["conversation_history/a.json", true],
    ["logs/ingest.log", true],
    ["openwiki.sqlite", true],
    ["openwiki.sqlite-wal", true],
    ["install-id", true],
    ["connectors/google/raw/run/file.json", true],
    ["connectors/google/state.json", true],
    ["connectors/google/logs/a.log", true],
    ["connectors/google/config.json", false],
    ["connectors/google/raw.json", false],
    ["onboarding.json", false],
    ["INSTRUCTIONS.md", false],
    [".env", false],
  ])("%s → %s", (relativePath, owned) => {
    expect(isOpenWikiOwnedHomePath(relativePath)).toBe(owned);
  });
});
