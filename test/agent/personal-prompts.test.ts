import { describe, expect, test } from "vitest";
import {
  createPersonalGatherPrompt,
  createPersonalPagePrompt,
  createPersonalPlannerPrompt,
} from "../../src/agent/personal-prompts.ts";
import { resolveJsonPointer } from "../../src/agent/personal-worker-tools.ts";
import { PERSONAL_SYSTEM_PROMPTS } from "../../src/agent/prompts/personal.ts";
import * as guidance from "../../src/agent/prompts/personal-guidance.ts";
import { RepositoryRunError } from "../../src/generation/errors.ts";
import type {
  PersonalBeginView,
  PersonalPageJobView,
} from "../../src/generation/personal-run.ts";

const RAW_1 = "2026-10-07T06-00-00-000Z";

const view: PersonalBeginView = {
  status: "active",
  runId: "00000000-0000-4000-8000-000000000001",
  mode: "update",
  phase: "planning",
  language: "en",
  languageChanged: false,
  resumed: false,
  lastUpdate: null,
  frontier: [
    {
      connectorId: "google",
      rawRunIds: [RAW_1],
      rawFiles: [`${RAW_1}/gmail-messages.json`],
      frozen: true,
    },
  ],
  warnings: [],
  completedPages: 0,
};

function job(overrides: Partial<PersonalPageJobView>): PersonalPageJobView {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    path: "/commitments.md",
    title: "Commitments",
    purpose: "Add the follow-up.",
    seedEvidence: [`raw://google/${RAW_1}/gmail-messages.json#/messages/0`],
    relatedPages: [],
    instructions: [],
    status: "pending",
    mode: "update",
    existing: true,
    pageVersion: "sha256:0",
    ...overrides,
  };
}

const guidancePieces = Object.entries(guidance)
  .filter(([name]) => name.endsWith("_GUIDANCE"))
  .map(([, value]) => value as string);

describe("personal guidance", () => {
  test("the legacy init and update prompts are assembled from it", () => {
    expect(guidancePieces.length).toBeGreaterThan(10);
    for (const piece of guidancePieces) {
      expect(PERSONAL_SYSTEM_PROMPTS.init).toContain(piece);
      expect(PERSONAL_SYSTEM_PROMPTS.update).toContain(piece);
    }
  });
});

describe("native personal prompts", () => {
  const prompts = [
    createPersonalGatherPrompt(view, ["notion"], []),
    createPersonalPlannerPrompt(view, {
      existingPages: ["/commitments.md"],
      openQuestions: null,
      sources: [],
    }),
    createPersonalPagePrompt(job({}), view, [], []),
    createPersonalPagePrompt(
      job({
        path: "/open-questions.md",
        seedEvidence: [],
        maintenance: true,
        activeEntries: "### q4: Who owns it?",
        changedPages: ["/commitments.md"],
      }),
      view,
      [],
      [],
    ),
    createPersonalPagePrompt(
      job({ path: "/quickstart.md", seedEvidence: [] }),
      view,
      [],
      ["/commitments.md"],
    ),
  ];

  test.each(prompts.map((prompt, index) => [index, prompt]))(
    "prompt %i restates no rule the core enforces",
    (_index, prompt) => {
      expect(prompt).not.toMatch(/\.last-update\.json/u);
      expect(prompt).not.toMatch(/index\.md/u);
      expect(prompt).not.toMatch(
        /read \/open-questions\.md (if it exists|first)/iu,
      );
      expect(prompt).not.toMatch(/quickstart\.md (must be|first|last)/iu);
      expect(prompt).not.toMatch(/translat(ed|ion) pass|already brought/iu);
    },
  );

  test("the page prompt carries the seeds, confidence rules, and connector guidance", () => {
    const prompt = prompts[2];
    expect(prompt).toContain("You own exactly /commitments.md.");
    expect(prompt).toContain(
      `- raw://google/${RAW_1}/gmail-messages.json#/messages/0`,
    );
    expect(prompt).toContain(guidance.PERSONAL_CONTESTED_GUIDANCE);
    expect(prompt).toContain(
      guidance.createConnectorSynthesisGuidance({ id: "google" }).trim(),
    );
  });

  test("the maintenance prompt carries Active entries and changed pages, not seeds", () => {
    const prompt = prompts[3];
    expect(prompt).toContain("maintenance job");
    expect(prompt).toContain("### q4: Who owns it?");
    expect(prompt).toContain(guidance.PERSONAL_OPEN_QUESTIONS_FORMAT_GUIDANCE);
    expect(prompt).toContain("Seed evidence:\n- (none)");
  });

  test("the planner prompt limits a page-scoped run to its pages", () => {
    const scoped = createPersonalPlannerPrompt(
      { ...view, scope: { pages: ["/commitments.md"] } },
      { existingPages: [], openQuestions: null, sources: [] },
    );
    expect(scoped).toContain(
      "This run may plan only these pages:\n- /commitments.md",
    );
  });
});

describe("resolveJsonPointer", () => {
  const document = { messages: [{ id: "m1" }], "a/b": { "~c": 1 } };

  test("resolves object members, array indexes, and escapes", () => {
    expect(resolveJsonPointer(document, "")).toBe(document);
    expect(resolveJsonPointer(document, "/messages/0/id")).toBe("m1");
    expect(resolveJsonPointer(document, "/a~1b/~0c")).toBe(1);
  });

  test.each(["/messages/1", "/messages/01", "/missing", "/messages/0/id/x"])(
    "rejects %s",
    (pointer) => {
      expect(() => resolveJsonPointer(document, pointer)).toThrow(
        RepositoryRunError,
      );
    },
  );
});
