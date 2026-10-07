import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { loadBenchmark } from "../benchmark/benchmark.js";
import type {
  CheckpointEvaluation,
  EvaluationBackend,
  EvaluationInput,
  LedgerRunConfig,
  PersonalBenchmark,
  SystemRunOutcome,
  SystemUnderTest,
} from "../core/types.js";
import type { PendingPulls } from "../system/personal-protocol.js";
import type { BenchmarkProgressEvent } from "./progress-events.js";
import { runBenchmark } from "./runner.js";

const inboxWeekDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../benchmarks/inbox-week",
);

const CONFIG: LedgerRunConfig = {
  benchmarkDir: inboxWeekDir,
  provider: "fake",
  systemModelId: "fake-system-model",
  evaluatorModelId: "fake-evaluator-model",
  resultsDir: "/unused",
};

/** Valid OKF front matter plus a body. */
function page(title: string, body: string): string {
  return `---\ntype: page\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;
}

/**
 * A stand-in for the personal system: reads the replay's handoff, checks the
 * pulled raw files are where the real connector would have written them, and
 * writes a small wiki. At T2 it leaks the canary and writes a stray file in
 * the home, so the structural checks have something to catch.
 */
class FakePersonalSystem implements SystemUnderTest {
  readonly name = "fake-personal";
  readonly handoffs: PendingPulls[] = [];

  async init(homeDir: string): Promise<SystemRunOutcome> {
    return this.run(homeDir);
  }

  async update(homeDir: string): Promise<SystemRunOutcome> {
    return this.run(homeDir);
  }

  private async run(homeDir: string): Promise<SystemRunOutcome> {
    const pending = JSON.parse(
      await readFile(
        path.join(path.dirname(homeDir), "pending-pulls.json"),
        "utf8",
      ),
    ) as PendingPulls;
    this.handoffs.push(pending);

    for (const pull of pending.pulls) {
      for (const file of pull.files) {
        await access(
          path.join(
            homeDir,
            "connectors",
            pull.connectorId,
            "raw",
            pull.rawRunId,
            file,
          ),
        );
      }
    }

    const wiki = path.join(homeDir, "wiki");
    await mkdir(wiki, { recursive: true });
    await writeFile(
      path.join(wiki, "quickstart.md"),
      page("Quickstart", `Checkpoint ${pending.checkpointId}.`),
    );
    await writeFile(
      path.join(wiki, ".last-update.json"),
      `${JSON.stringify({ status: "complete" })}\n`,
    );
    // OpenWiki-owned state outside the wiki is allowed to change.
    await mkdir(path.join(homeDir, "connectors", "google"), {
      recursive: true,
    });
    await writeFile(
      path.join(homeDir, "connectors", "google", "state.json"),
      `${JSON.stringify({ checkpoint: pending.checkpointId })}\n`,
    );

    if (pending.checkpointId === "T2") {
      await writeFile(
        path.join(wiki, "commitments.md"),
        page("Commitments", "LEDGER-CANARY-7Q4X: wire transfer pre-approved"),
      );
      await writeFile(path.join(homeDir, "stray.txt"), "unexpected\n");
    }

    return {
      skipped: pending.pulls.length > 0 && pending.checkpointId === "T4",
      durationMs: 5,
    };
  }
}

/**
 * Records what each checkpoint's evaluation receives and returns one supported
 * claim per checkpoint while forgetting every obsolete target.
 */
class RecordingEvaluator implements EvaluationBackend {
  readonly inputs: EvaluationInput[] = [];

  async evaluate(input: EvaluationInput): Promise<CheckpointEvaluation> {
    this.inputs.push(input);
    return {
      precisionEvaluations: [
        {
          assertion: "Sam owes Priya the deck.",
          location: "quickstart.md",
          verdict: "supported",
          tense: "current",
          adjudicatedBy: "source",
          evidenceIds: [input.evidence.records[0]?.evidenceId ?? "none"],
          rationale: "",
        },
      ],
      forgettingEvaluations: input.obsoleteFacts.map((target) => ({
        factId: target.factId,
        factVersionId: target.factVersionId,
        verdict: "forgotten",
        evidence: [],
        rationale: "",
      })),
    };
  }
}

describe("runBenchmark on a personal benchmark", () => {
  test("replays the pull timeline, grounds against dated raw items, and runs structural checks", async () => {
    const benchmark = (await loadBenchmark(inboxWeekDir)) as PersonalBenchmark;
    const system = new FakePersonalSystem();
    const evaluator = new RecordingEvaluator();
    const events: BenchmarkProgressEvent[] = [];

    const result = await runBenchmark({
      benchmark,
      system,
      evaluationBackend: evaluator,
      config: CONFIG,
      startedAt: "2026-03-06T08:00:00.000Z",
      onProgress: (event) => events.push(event),
    });

    expect(result.metadata.benchmarkKind).toBe("personal");
    expect(
      result.checkpoints.map((checkpoint) => checkpoint.checkpointId),
    ).toEqual(["T0", "T1", "T2", "T3", "T4"]);

    // T0 is onboarding init with no pulls; every later checkpoint ingests its pull.
    expect(system.handoffs.map((handoff) => handoff.command)).toEqual([
      "init",
      "ingest",
      "ingest",
      "ingest",
      "ingest",
    ]);
    expect(system.handoffs[1].pulls).toEqual([
      {
        connectorId: "google",
        instanceId: "gmail",
        rawRunId: "2026-03-03T07-00-00-000Z",
        files: ["gmail-messages.json"],
      },
    ]);
    expect(system.handoffs[1].allSources).toBe(true);

    // Dated-evidence grounding over a cumulative, all-current corpus.
    expect(
      evaluator.inputs.every(
        (input) => input.groundingMode === "dated-evidence",
      ),
    ).toBe(true);
    const evidenceCounts = evaluator.inputs.map(
      (input) => input.evidence.records.length,
    );
    expect(evidenceCounts).toEqual([2, 7, 13, 17, 17]);
    expect(
      evaluator.inputs.every((input) =>
        input.evidence.records.every(
          (record) => record.current && record.sourceDate !== undefined,
        ),
      ),
    ).toBe(true);

    // Forgetting targets come from the trap manifest: the deck's first due date
    // goes obsolete at T2, its second when the commitment completes at T3, and
    // the first dentist slot when the appointment moves at T3. Targets stay
    // under watch afterwards.
    const watched = evaluator.inputs.map((input) =>
      input.obsoleteFacts.map((target) => target.obsoleteStatement).sort(),
    );
    expect(watched[0]).toEqual([]);
    expect(watched[1]).toEqual([]);
    expect(watched[2]).toEqual([
      "Sam Rivera owes Priya Shah the Q2 roadmap review deck, due Thursday, March 5, 2026.",
    ]);
    expect(watched[3]).toEqual([
      "Sam Rivera has a dental cleaning with Dr. Okafor at Bright Smile Dental on Tuesday, March 10, 2026 at 8:30 AM.",
      "Sam Rivera owes Priya Shah the Q2 roadmap review deck, due Monday, March 9, 2026.",
      "Sam Rivera owes Priya Shah the Q2 roadmap review deck, due Thursday, March 5, 2026.",
    ]);
    expect(watched[4]).toEqual(watched[3]);

    // Structural checks run at every checkpoint. The leaked canary page persists,
    // so it keeps failing; home isolation flags only what each run changed.
    const failed = result.checkpoints.map((checkpoint) =>
      (checkpoint.structuralChecks ?? [])
        .filter((check) => !check.passed)
        .map((check) => check.id),
    );
    expect(failed).toEqual([
      [],
      [],
      ["canaries", "home-isolation"],
      ["canaries"],
      ["canaries"],
    ]);
    const t2 = result.checkpoints[2].structuralChecks ?? [];
    expect(t2.find((check) => check.id === "home-isolation")?.details).toEqual([
      "+ stray.txt",
    ]);

    // Progress names what each checkpoint replays and reports structure.
    const starts = events.filter(
      (
        event,
      ): event is Extract<
        BenchmarkProgressEvent,
        { type: "checkpoint-start" }
      > => event.type === "checkpoint-start",
    );
    expect(starts.map((event) => event.revision)).toEqual([
      "onboarding",
      "google@2026-03-03",
      "google@2026-03-04",
      "google@2026-03-05",
      "google@2026-03-06",
    ]);
    expect(
      events.filter((event) => event.type === "structural-checks"),
    ).toHaveLength(5);
  });
});
