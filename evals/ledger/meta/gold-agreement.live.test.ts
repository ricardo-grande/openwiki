import { describe, expect, test } from "vitest";

import { createModel } from "../../../src/agent/index.js";
import type { OpenWikiProvider } from "../../../src/config/constants.js";
import {
  assertGoldAgreement,
  loadPrecisionGoldFixture,
  measureGoldAgreement,
  PRECISION_GOLD_FIXTURES,
} from "./gold-agreement.js";

describe.skipIf(!process.env.LEDGER_LIVE)(
  "precision gold agreement (live)",
  () => {
    test.each(
      Object.keys(PRECISION_GOLD_FIXTURES) as Array<
        keyof typeof PRECISION_GOLD_FIXTURES
      >,
    )(
      "meets the per-stage agreement floor on the %s set",
      async (name) => {
        const provider = (process.env.OPENWIKI_PROVIDER ??
          "anthropic") as OpenWikiProvider;
        const modelId =
          process.env.LEDGER_EVALUATOR_MODEL_ID ??
          process.env.OPENWIKI_MODEL_ID ??
          "claude-sonnet-5";
        const report = await measureGoldAgreement({
          model: createModel(provider, modelId, 0),
          fixture: await loadPrecisionGoldFixture(name),
        });

        process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
        expect(() => assertGoldAgreement(report)).not.toThrow();
      },
      300_000,
    );
  },
);
