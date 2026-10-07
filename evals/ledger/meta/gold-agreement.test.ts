import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { describe, expect, test } from "vitest";

import {
  assertGoldAgreement,
  loadPrecisionGoldFixture,
  measureGoldAgreement,
  PRECISION_GOLD_FIXTURES,
} from "./gold-agreement.js";
import {
  PRECISION_DATED_JUDGMENT_SYSTEM,
  PRECISION_JUDGMENT_SYSTEM,
} from "../evaluator/prompts.js";

function fakeModel(
  responses: unknown[],
  systemPrompts: string[] = [],
): BaseChatModel {
  const queue = [...responses];
  return {
    withStructuredOutput: () => ({
      invoke: async (messages: Array<{ content: unknown }>) => {
        systemPrompts.push(String(messages[0]?.content));
        return queue.shift();
      },
    }),
  } as unknown as BaseChatModel;
}

describe("precision gold agreement", () => {
  test.each(
    Object.keys(PRECISION_GOLD_FIXTURES) as Array<
      keyof typeof PRECISION_GOLD_FIXTURES
    >,
  )(
    "reports perfect agreement for human-labeled %s stage outputs",
    async (name) => {
      const fixture = await loadPrecisionGoldFixture(name);
      const responses: unknown[] = [
        {
          units: fixture.extractionCases.map((item, index) => ({
            unitId: `gold-unit-${index}`,
            ...item.expected,
            rationale: "Human-labeled fixture response.",
          })),
        },
        ...fixture.groundingCases.map((item, index) => ({
          evaluations: [
            {
              assertionId: `gold-grounding-${index}`,
              verdict: item.expected.verdict,
              formerlyTrue: item.expected.formerlyTrue,
              evidenceIds:
                item.expected.verdict === "not-addressed"
                  ? []
                  : item.evidence.map((evidence) => evidence.evidenceId),
              rationale: "Human-labeled fixture response.",
            },
          ],
        })),
      ];

      const systemPrompts: string[] = [];
      const report = await measureGoldAgreement({
        model: fakeModel(responses, systemPrompts),
        fixture,
      });

      expect(report).toMatchObject({
        extraction: { agreement: 1 },
        grounding: { agreement: 1 },
        floor: 0.9,
        passed: true,
      });
      expect(() => assertGoldAgreement(report)).not.toThrow();
      // Grounding uses the judgment prompt for the fixture's grounding mode.
      const groundingPrompt =
        name === "personal"
          ? PRECISION_DATED_JUDGMENT_SYSTEM
          : PRECISION_JUDGMENT_SYSTEM;
      expect(
        systemPrompts
          .slice(1)
          .every((prompt) => prompt.includes(groundingPrompt)),
      ).toBe(systemPrompts.length > 1);
    },
  );

  test("labels every personal grounding case consistently", async () => {
    const fixture = await loadPrecisionGoldFixture("personal");

    expect(fixture.groundingMode).toBe("dated-evidence");
    for (const item of fixture.groundingCases) {
      expect(
        item.evidence.every(
          (evidence) => evidence.current && evidence.sourceDate,
        ),
      ).toBe(true);
      expect(
        new Set(item.evidence.map((evidence) => evidence.evidenceId)).size,
      ).toBe(item.evidence.length);
      if (item.expected.verdict === "contradicted") {
        expect(typeof item.expected.formerlyTrue).toBe("boolean");
      } else {
        expect(item.expected.formerlyTrue).toBeUndefined();
      }
    }
  });

  test("fails the gate when one stage falls below the shared floor", () => {
    expect(() =>
      assertGoldAgreement({
        extraction: { correct: 8, total: 10, agreement: 0.8, mismatches: [] },
        grounding: { correct: 4, total: 4, agreement: 1, mismatches: [] },
        floor: 0.9,
        passed: false,
      }),
    ).toThrow(/gold agreement below 0\.9/u);
  });
});
