import { expect, test } from "vitest";
import type { LedgerRunResult } from "../core/types.js";
import { formatReport } from "./report.js";

test("reports current claim state, forgetting, and the auditable score", () => {
  const result: LedgerRunResult = {
    metadata: {
      benchmarkName: "taskflow",
      difficulty: "medium",
      startedAt: "2026-01-01T00:00:00.000Z",
      system: { provider: "anthropic", modelId: "system" },
      evaluatorModelId: "judge",
    },
    checkpoints: [
      {
        checkpointId: "T1",
        claims: {
          supported: 82,
          stale: 10,
          invented: 2,
          unverified: 6,
          total: 100,
          supportedRate: 0.82,
          stalenessRate: 0.1,
          hallucinationRate: 0.02,
          unverifiedRate: 0.06,
        },
        evaluationCompleteness: {
          judged: 106,
          indeterminate: 0,
          total: 106,
          rate: 1,
        },
        efficiency: { durationMs: 4200, churnedLines: 12, skipped: false },
        evaluations: {
          precisionEvaluations: [],
          forgettingEvaluations: [
            {
              factId: "x",
              factVersionId: "x@1",
              verdict: "forgotten",
              evidence: [],
              rationale: "gone",
            },
          ],
        },
      },
    ],
    score: {
      value: 0.82,
      claimHealth: 0.82,
    },
    diagnostics: {
      staleKnowledge: {
        records: [
          { factVersionId: "x@1", lingeredCheckpoints: 1, resolved: true },
        ],
        meanResolvedLifetime: 1,
        unresolvedCount: 0,
      },
    },
  };
  const report = formatReport(result);
  expect(report).toContain(
    "| T1 | 100 | 82.0% | 10.0% (10) | 2.0% (2) | 6.0% (6)",
  );
  expect(report).toContain("API forgetting");
  expect(report).toContain("LEDGER score: 82.0%");
  expect(report).toContain("Claim health: 82.0%");
  expect(report).not.toContain("Forgetting score");
  expect(report).not.toContain("Coverage");
});

test("labels personal runs and reports structural checks", () => {
  const checkpoint = (
    checkpointId: string,
    passed: boolean,
  ): LedgerRunResult["checkpoints"][number] => ({
    checkpointId,
    claims: {
      supported: 1,
      stale: 0,
      invented: 0,
      unverified: 0,
      total: 1,
      supportedRate: 1,
      stalenessRate: 0,
      hallucinationRate: 0,
      unverifiedRate: 0,
    },
    evaluationCompleteness: { judged: 1, indeterminate: 0, total: 1, rate: 1 },
    efficiency: { durationMs: 1, churnedLines: 0, skipped: false },
    structuralChecks: [
      {
        id: "quickstart",
        label: "Quickstart exists",
        passed: true,
        details: [],
      },
      {
        id: "canaries",
        label: "No canary reaches the wiki",
        passed,
        details: passed ? [] : ['/commitments.md contains "CANARY"'],
      },
    ],
  });
  const result: LedgerRunResult = {
    metadata: {
      benchmarkName: "inbox-week",
      difficulty: "medium",
      benchmarkKind: "personal",
      startedAt: "2026-01-01T00:00:00.000Z",
      system: { provider: "anthropic", modelId: "system" },
      evaluatorModelId: "judge",
    },
    checkpoints: [checkpoint("T0", true), checkpoint("T1", false)],
    score: { value: 1, claimHealth: 1 },
    diagnostics: {
      staleKnowledge: {
        records: [],
        meanResolvedLifetime: undefined,
        unresolvedCount: 0,
      },
    },
  };

  const report = formatReport(result);

  expect(report).toContain("Fact forgetting");
  expect(report).not.toContain("API forgetting");
  expect(report).toContain("Obsolete trap facts still unresolved: 0");
  expect(report).toContain("## Structural checks");
  expect(report).toContain("| Checkpoint | quickstart | canaries |");
  expect(report).toContain("| T0 | pass | pass |");
  expect(report).toContain("| T1 | pass | FAIL |");
  expect(report).toContain('  - /commitments.md contains "CANARY"');
});
