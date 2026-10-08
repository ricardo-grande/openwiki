import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

// PLC-001: the personal lifecycle core stays model-free, so a host with its own
// model can drive it. It may reuse the deterministic building blocks that live
// under src/agent/, but never model, agent-runtime, prompt, or connector
// ingestion code, and it never calls the code-mode core.

const GENERATION_DIR = path.resolve(
  import.meta.dirname,
  "../../src/generation",
);

const PERSONAL_CORE_MODULES = readdirSync(GENERATION_DIR)
  .filter((name) => /^personal-run(?:-[a-z]+)?\.ts$/u.test(name))
  .sort();

/**
 * Deterministic building blocks the core reuses (core spec §3.1).
 */
const ALLOWED_AGENT_MODULES = new Set([
  "../agent/docs-only-backend.js",
  "../agent/types.js",
  "../agent/utils.js",
  "../agent/wiki-finalizer.js",
]);

/**
 * Lists every static and dynamic import specifier in a module.
 */
async function readImports(file: string): Promise<string[]> {
  const source = await readFile(file, "utf8");
  return [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu),
    ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gmu),
  ].map((match) => match[1]);
}

describe("personal lifecycle core import boundary (PLC-001)", () => {
  test("covers every personal core module", () => {
    expect(PERSONAL_CORE_MODULES).toEqual([
      "personal-run-lock.ts",
      "personal-run-plan.ts",
      "personal-run-state.ts",
      "personal-run.ts",
    ]);
  });

  test.each(PERSONAL_CORE_MODULES)(
    "%s imports no model, agent, prompt, or ingestion code",
    async (module) => {
      const imports = await readImports(path.join(GENERATION_DIR, module));

      const violations = imports.filter((specifier) => {
        if (specifier.startsWith("node:") || specifier === "zod") return false;
        if (!specifier.startsWith(".")) return true;
        if (specifier.startsWith("../agent/")) {
          return !ALLOWED_AGENT_MODULES.has(specifier);
        }
        return (
          /prompt/iu.test(specifier) ||
          specifier.startsWith("../ingestion/") ||
          specifier.startsWith("../connectors/") ||
          specifier.startsWith("../integrations/") ||
          specifier === "./repository-run.js" ||
          specifier === "./run-state.js" ||
          specifier === "./page-jobs.js" ||
          specifier === "./page-manifest.js"
        );
      });

      expect(imports.length).toBeGreaterThan(0);
      expect(violations).toEqual([]);
    },
  );

  test("the code-mode core never imports the personal core", async () => {
    for (const module of ["repository-run.ts", "run-state.ts"]) {
      const imports = await readImports(path.join(GENERATION_DIR, module));
      expect(
        imports.filter((specifier) => /personal/u.test(specifier)),
      ).toEqual([]);
    }
  });
});
