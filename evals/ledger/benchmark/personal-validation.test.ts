import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { BenchmarkValidationError } from "../core/errors.js";
import type { PersonalBenchmark, PersonalTrapManifest } from "../core/types.js";
import { loadBenchmark } from "./benchmark.js";
import {
  cumulativePulls,
  onboardingInstant,
  rawRunIdToIso,
  trapSurfaceAt,
} from "./personal.js";
import { diffSurface, obsoleteTargetsFor } from "./surface.js";
import { validateBenchmark } from "./validation.js";

const inboxWeekDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../benchmarks/inbox-week",
);

/** A minimal valid personal benchmark. */
function valid(): PersonalBenchmark {
  return {
    kind: "personal",
    name: "p",
    description: "",
    difficulty: "easy",
    rawRoot: "/nonexistent/raw",
    wikiGoal: "Track my week.",
    connectors: [{ connectorId: "google", instanceId: "gmail" }],
    trace: {
      checkpoints: [
        { id: "T0", pulls: [] },
        {
          id: "T1",
          pulls: [
            { connectorId: "google", rawRunId: "2026-03-03T07-00-00-000Z" },
          ],
        },
        {
          id: "T2",
          pulls: [
            { connectorId: "google", rawRunId: "2026-03-04T07-00-00-000Z" },
          ],
        },
      ],
    },
    traps: {
      facts: [
        {
          id: "f",
          versions: [
            { from: "T1", statement: "one" },
            { from: "T2", statement: "two" },
          ],
        },
      ],
      canaries: ["CANARY"],
      noise: [{ id: "n", terms: ["digest"] }],
    },
  };
}

function expectRejected(benchmark: PersonalBenchmark, pattern: RegExp): void {
  expect(() => validateBenchmark(benchmark)).toThrow(BenchmarkValidationError);
  expect(() => validateBenchmark(benchmark)).toThrow(pattern);
}

describe("validatePersonalBenchmark", () => {
  test("accepts a well-formed benchmark", () => {
    expect(() => validateBenchmark(valid())).not.toThrow();
  });

  test.each<[string, (benchmark: PersonalBenchmark) => void, RegExp]>([
    ["an empty wiki goal", (b) => (b.wikiGoal = " "), /wikiGoal/],
    ["no connectors", (b) => (b.connectors = []), /connectors array/],
    [
      "an unknown connector",
      (b) => (b.connectors[0].connectorId = "fax"),
      /not an OpenWiki connector/,
    ],
    [
      "an agentic connector",
      (b) => (b.connectors[0].connectorId = "notion"),
      /gathers live/,
    ],
    [
      "an unsafe instance id",
      (b) => (b.connectors[0].instanceId = "../x"),
      /instanceId/,
    ],
    [
      "pulls at onboarding",
      (b) => (b.trace.checkpoints[0].pulls = [...b.trace.checkpoints[1].pulls]),
      /onboarding init/,
    ],
    [
      "a later checkpoint without pulls",
      (b) => (b.trace.checkpoints[2].pulls = []),
      /at least one connector/,
    ],
    [
      "an unconnected source",
      (b) => (b.trace.checkpoints[1].pulls[0].connectorId = "slack"),
      /not a connected source/,
    ],
    [
      "a malformed run id",
      (b) => (b.trace.checkpoints[1].pulls[0].rawRunId = "../../etc"),
      /invalid rawRunId/,
    ],
    [
      "a run that is not newer",
      (b) =>
        (b.trace.checkpoints[2].pulls[0].rawRunId = "2026-03-03T07-00-00-000Z"),
      /not newer/,
    ],
    [
      "a trap on an unknown checkpoint",
      (b) => (b.traps.facts[0].versions[1].from = "T9"),
      /unknown checkpoint/,
    ],
    [
      "a trap planted at onboarding",
      (b) => (b.traps.facts[0].versions[0].from = "T0"),
      /after T0 and in trace order/,
    ],
    [
      "a retirement before the last version",
      (b) => (b.traps.facts[0].retiredAt = "T1"),
      /retire after/,
    ],
    ["an empty canary", (b) => (b.traps.canaries = [""]), /canaries/],
    [
      "a placement without pages",
      (b) => (b.traps.placements = [{ id: "p", terms: ["x"], notOnPages: [] }]),
      /placement/,
    ],
  ])("rejects %s", (_label, mutate, pattern) => {
    const benchmark = valid();
    mutate(benchmark);
    expectRejected(benchmark, pattern);
  });
});

describe("personal benchmark helpers", () => {
  test("converts run ids back to instants", () => {
    expect(rawRunIdToIso("2026-03-03T07-00-00-000Z")).toBe(
      "2026-03-03T07:00:00.000Z",
    );
    expect(rawRunIdToIso("latest")).toBeUndefined();
  });

  test("onboards at the start of the first pull's window", () => {
    expect(onboardingInstant(valid())).toBe("2026-03-02T07:00:00.000Z");
  });

  test("accumulates pulls through a checkpoint", () => {
    expect(
      cumulativePulls(valid(), 2).map((pull) => pull.checkpointId),
    ).toEqual(["T1", "T2"]);
  });

  test("turns changed and retired trap facts into forgetting targets", () => {
    const traps: PersonalTrapManifest = {
      facts: [
        {
          id: "deadline",
          versions: [
            { from: "T1", statement: "Due Thu." },
            { from: "T2", statement: "Due Mon." },
          ],
        },
        {
          id: "trip",
          versions: [{ from: "T1", statement: "Trip to Lisbon." }],
          retiredAt: "T2",
        },
        { id: "later", versions: [{ from: "T2", statement: "New fact." }] },
      ],
      canaries: [],
      noise: [],
    };
    const ids = ["T0", "T1", "T2"];
    const surfaces = ids.map((_, index) => trapSurfaceAt(traps, ids, index));

    expect(surfaces[0]).toEqual([]);
    expect(surfaces[1].map((item) => item.statement)).toEqual([
      "Due Thu.",
      "Trip to Lisbon.",
    ]);
    expect(surfaces[2].map((item) => item.statement)).toEqual([
      "Due Mon.",
      "New fact.",
    ]);
    expect(
      obsoleteTargetsFor(diffSurface(surfaces[1], surfaces[2], "T1", "T2")).map(
        (target) => target.obsoleteStatement,
      ),
    ).toEqual(["Due Thu.", "Trip to Lisbon."]);
  });
});

describe("loadBenchmark for a personal benchmark", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ledger-personal-load-"));
    await cp(inboxWeekDir, dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("loads the manifest, traps, and raw root", async () => {
    const benchmark = await loadBenchmark(dir);

    expect(benchmark.kind).toBe("personal");
    if (benchmark.kind !== "personal") return;
    expect(benchmark.rawRoot).toBe(path.join(dir, "raw"));
    expect(benchmark.traps.canaries).toEqual(["LEDGER-CANARY-7Q4X"]);
    expect(benchmark.trace.checkpoints).toHaveLength(5);
  });

  test("rejects a missing trap manifest", async () => {
    await rm(path.join(dir, "traps.json"));
    await expect(loadBenchmark(dir)).rejects.toThrow(/traps\.json/);
  });

  test("rejects a pull whose fixtures are missing", async () => {
    await rm(path.join(dir, "raw", "google", "2026-03-04T07-00-00-000Z"), {
      recursive: true,
    });
    await expect(loadBenchmark(dir)).rejects.toThrow(
      /fixtures for pull .* are missing/,
    );
  });

  test("rejects a symlinked fixture file", async () => {
    const runDir = path.join(dir, "raw", "google", "2026-03-04T07-00-00-000Z");
    await rm(path.join(runDir, "gmail-messages.json"));
    await symlink("/etc/hosts", path.join(runDir, "gmail-messages.json"));
    await expect(loadBenchmark(dir)).rejects.toThrow(/regular files/);
  });

  test("rejects an unknown kind and a personal sourceRepo", async () => {
    const manifestPath = path.join(dir, "benchmark.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;

    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, kind: "chat" }),
    );
    await expect(loadBenchmark(dir)).rejects.toThrow(/"kind" must be/);

    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, sourceRepo: "./repo" }),
    );
    await expect(loadBenchmark(dir)).rejects.toThrow(
      /must not declare "sourceRepo"/,
    );
  });
});
