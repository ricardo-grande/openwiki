import { describe, expect, test } from "vitest";

import {
  resolveJudgments,
  type EvidenceSection,
  type PrecisionJudgmentTarget,
} from "./precision.js";
import {
  FORGETTING_DATED_SYSTEM,
  FORGETTING_SYSTEM,
  forgettingSystemFor,
  PRECISION_DATED_JUDGMENT_SYSTEM,
  PRECISION_JUDGMENT_SYSTEM,
  precisionJudgmentSystemFor,
} from "./prompts.js";

/** One dated, current evidence item. */
function item(id: string, sourceDate: string | undefined): EvidenceSection {
  return {
    id,
    ordinal: 0,
    relativePath: `raw://google/run/gmail-messages.json#/messages/${id}`,
    headingPath: [],
    content: id,
    searchableText: id,
    observedAtCheckpoint: "T2",
    current: true,
    ...(sourceDate !== undefined ? { sourceDate } : {}),
  };
}

/** A current assertion with the given evidence. */
function target(evidence: EvidenceSection[]): PrecisionJudgmentTarget {
  return {
    assertion: {
      id: "a1",
      statement: "The deck is due Thursday, March 5.",
      sourceQuote: "due Thursday, March 5",
      unitId: "u1",
      artifactContext: "The deck is due Thursday, March 5.",
      headingPath: [],
      tense: "current",
      sectionId: "s1",
      relativePath: "commitments.md",
      candidateId: "c1",
    },
    evidence,
  } as PrecisionJudgmentTarget;
}

const OLD = item("old", "2026-03-02T09:12:00.000Z");
const NEW = item("new", "2026-03-03T08:40:00.000Z");

function contradicted(evidenceIds: string[], formerlyTrue: boolean) {
  return {
    evaluations: [
      {
        assertionId: "a1",
        rationale: "The newer email moved the date.",
        evidenceIds,
        verdict: "contradicted" as const,
        formerlyTrue,
      },
    ],
  };
}

describe("dated-evidence precision judgments", () => {
  test("a claim an older item established and a newer item changed is stale", () => {
    const [evaluation] = resolveJudgments(
      [target([OLD, NEW])],
      contradicted(["old", "new"], true),
      "dated-evidence",
    );

    expect(evaluation.verdict).toBe("stale");
    expect(evaluation.evidenceIds).toEqual(["old", "new"]);
  });

  test("former truth must cite items with different dates", () => {
    const sameDay = item("same", "2026-03-03T08:40:00.000Z");

    expect(() =>
      resolveJudgments(
        [target([NEW, sameDay])],
        contradicted(["new", "same"], true),
        "dated-evidence",
      ),
    ).toThrow(/different dates/);
    expect(() =>
      resolveJudgments(
        [target([NEW])],
        contradicted(["new"], true),
        "dated-evidence",
      ),
    ).toThrow(/different dates/);
  });

  test("a contradiction no older item established is invented", () => {
    const [evaluation] = resolveJudgments(
      [target([NEW])],
      contradicted(["new"], false),
      "dated-evidence",
    );

    expect(evaluation.verdict).toBe("invented");
  });

  test("checkpoint mode still requires historical evidence for former truth", () => {
    expect(() =>
      resolveJudgments(
        [target([OLD, NEW])],
        contradicted(["old", "new"], true),
      ),
    ).toThrow(/lacks historical evidence/);
  });
});

describe("grounding-mode prompts", () => {
  test("select the dated variants only for dated evidence", () => {
    expect(precisionJudgmentSystemFor()).toBe(PRECISION_JUDGMENT_SYSTEM);
    expect(precisionJudgmentSystemFor("checkpoint")).toBe(
      PRECISION_JUDGMENT_SYSTEM,
    );
    expect(precisionJudgmentSystemFor("dated-evidence")).toBe(
      PRECISION_DATED_JUDGMENT_SYSTEM,
    );
    expect(forgettingSystemFor()).toBe(FORGETTING_SYSTEM);
    expect(forgettingSystemFor("dated-evidence")).toBe(FORGETTING_DATED_SYSTEM);
  });

  test("the dated judgment prompt lets the newest item decide and handles contested facts", () => {
    expect(PRECISION_DATED_JUDGMENT_SYSTEM).toContain(
      "the newest relevant item decides",
    );
    expect(PRECISION_DATED_JUDGMENT_SYSTEM).toContain("contested");
    expect(FORGETTING_DATED_SYSTEM.startsWith(FORGETTING_SYSTEM)).toBe(true);
  });
});
