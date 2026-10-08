import { describe, expect, test } from "vitest";
import {
  createPersonalPlan,
  extractActiveSection,
  samePersonalPlan,
  type PersonalPlanContext,
  type ProposedPersonalPlan,
} from "../../src/generation/personal-run-plan.ts";

const RUN_1 = "2026-10-06T06-00-00-000Z";
const RUN_2 = "2026-10-07T06-00-01-120Z";
const GMAIL = `raw://google/${RUN_2}/gmail-messages.json`;
const SLACK = `raw://slack/${RUN_1}/my-recent-messages.json`;

/**
 * An update with one Gmail pull and one Slack pull in its frontier.
 */
function context(
  overrides: Partial<PersonalPlanContext> = {},
): PersonalPlanContext {
  return {
    mode: "update",
    frontier: [
      {
        connectorId: "google",
        rawRunIds: [RUN_2],
        rawFiles: [`${RUN_2}/gmail-messages.json`, `${RUN_2}/summary.json`],
        frozen: true,
      },
      {
        connectorId: "slack",
        rawRunIds: [RUN_1],
        rawFiles: [`${RUN_1}/my-recent-messages.json`],
        frozen: true,
      },
    ],
    initialPages: [
      "/commitments.md",
      "/open-questions.md",
      "/quickstart.md",
      "/sources/google.md",
    ],
    languageChanged: false,
    requiredRewritePages: [],
    ...overrides,
  };
}

function page(path: string, seedEvidence: string[] = []) {
  return { path, title: path, purpose: `Write ${path}`, seedEvidence };
}

function plan(
  pages: ProposedPersonalPlan["pages"],
  deletePages?: string[],
): ProposedPersonalPlan {
  return { pages, ...(deletePages ? { deletePages } : {}) };
}

function paths(result: ReturnType<typeof createPersonalPlan>): string[] {
  return result.pages.map(({ path }) => path);
}

function job(result: ReturnType<typeof createPersonalPlan>, path: string) {
  const found = result.pages.find((candidate) => candidate.path === path);
  if (!found) throw new Error(`no job for ${path}`);
  return found;
}

describe("plan validation", () => {
  test.each([
    ["duplicate paths", plan([page("/a.md"), page("/a.md")]), /Duplicate/u],
    [
      "a page both planned and deleted",
      plan([page("/a.md")], ["/a.md"]),
      /both planned and deleted/u,
    ],
    [
      "deleting /quickstart.md",
      plan([], ["/quickstart.md"]),
      /cannot be deleted/u,
    ],
    [
      "deleting /open-questions.md",
      plan([], ["/open-questions.md"]),
      /cannot be deleted/u,
    ],
    [
      "deleting the source page that receives evidence",
      plan([], ["/sources/google.md"]),
      /routes google evidence/u,
    ],
    ["a dot segment", plan([page("/topics/../x.md")]), /canonical/u],
    ["a hidden segment", plan([page("/.run.md")]), /canonical/u],
    ["a relative path", plan([page("topics/x.md")]), /canonical/u],
    ["a non-Markdown path", plan([page("/x.txt")]), /canonical/u],
    ["the reserved index page", plan([page("/index.md")]), /core owns/u],
    ["a nested log page", plan([page("/topics/log.md")]), /core owns/u],
    [
      "a reserved related page",
      plan([{ ...page("/a.md"), relatedPages: ["/index.md"] }]),
      /core owns/u,
    ],
    ["a blank title", plan([{ ...page("/a.md"), title: " " }]), /title/u],
  ])("rejects %s", (_name, proposed, message) => {
    expect(() => createPersonalPlan(context(), proposed)).toThrow(message);
    expect(() => createPersonalPlan(context(), proposed)).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  test("rejects any deletion in init mode (PLC-014)", () => {
    expect(() =>
      createPersonalPlan(
        context({ mode: "init" }),
        plan([], ["/topics/old.md"]),
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  test("rejects seeds outside the frontier (PLC-007)", () => {
    for (const seed of [
      `raw://google/${RUN_1}/gmail-messages.json`,
      `raw://notion/${RUN_2}/gmail-messages.json`,
      `raw://google/${RUN_2}/other.json`,
      "repo://src/index.ts",
    ]) {
      expect(() =>
        createPersonalPlan(context(), plan([page("/a.md", [seed])])),
      ).toThrow(expect.objectContaining({ code: "invalid_input" }));
    }
  });

  test("accepts frontier seeds with a JSON pointer", () => {
    const result = createPersonalPlan(
      context(),
      plan([page("/people/dana.md", [`${GMAIL}#/messages/3`])]),
    );
    expect(job(result, "/people/dana.md").seedEvidence).toEqual([
      `${GMAIL}#/messages/3`,
    ]);
  });

  test("rejects planned and deleted pages outside scope.pages, but not required jobs", () => {
    const scoped = context({ scope: { pages: ["/people/dana.md"] } });

    expect(() =>
      createPersonalPlan(scoped, plan([page("/themes.md")])),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      createPersonalPlan(scoped, plan([], ["/topics/old.md"])),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));

    const result = createPersonalPlan(scoped, plan([page("/people/dana.md")]));
    expect(paths(result)).toEqual([
      "/people/dana.md",
      "/sources/google.md",
      "/sources/slack.md",
      "/open-questions.md",
      "/quickstart.md",
    ]);
  });

  test("an empty update plan is valid and still gets required jobs", () => {
    expect(paths(createPersonalPlan(context(), plan([])))).toEqual([
      "/sources/google.md",
      "/sources/slack.md",
      "/open-questions.md",
      "/quickstart.md",
    ]);
  });

  test("never rejects a plan for omitting evidence", () => {
    expect(() =>
      createPersonalPlan(context(), plan([page("/commitments.md")])),
    ).not.toThrow();
  });
});

describe("required jobs (PLC-008, PLC-018)", () => {
  test("seeds each connector's source page with every frontier file", () => {
    const result = createPersonalPlan(context(), plan([]));

    expect(job(result, "/sources/google.md").seedEvidence).toEqual([
      GMAIL,
      `raw://google/${RUN_2}/summary.json`,
    ]);
    expect(job(result, "/sources/slack.md").seedEvidence).toEqual([SLACK]);
  });

  test("adds no source page for a connector without frontier files", () => {
    const result = createPersonalPlan(
      context({
        frontier: [
          { connectorId: "notion", rawRunIds: [], rawFiles: [], frozen: true },
        ],
        instruction: "Tidy commitments",
      }),
      plan([page("/commitments.md")]),
    );
    expect(paths(result)).toEqual(["/commitments.md", "/open-questions.md"]);
  });

  test("merges seeds into a planned source page and keeps its purpose", () => {
    const result = createPersonalPlan(
      context(),
      plan([
        {
          ...page("/sources/google.md", [`${GMAIL}#/messages/1`]),
          purpose: "Planner purpose",
        },
      ]),
    );
    expect(job(result, "/sources/google.md")).toMatchObject({
      purpose: "Planner purpose",
      seedEvidence: [
        GMAIL,
        `${GMAIL}#/messages/1`,
        `raw://google/${RUN_2}/summary.json`,
      ],
    });
  });

  test("open-questions is a maintenance job once it exists and the run has evidence", () => {
    const result = createPersonalPlan(context(), plan([]));
    expect(job(result, "/open-questions.md")).toMatchObject({
      maintenance: true,
      seedEvidence: [],
    });
  });

  test("open-questions is required by an instruction alone", () => {
    const result = createPersonalPlan(
      context({ frontier: [], instruction: "Note my new gym" }),
      plan([page("/personal-logistics.md")]),
    );
    expect(paths(result)).toEqual([
      "/personal-logistics.md",
      "/open-questions.md",
      "/quickstart.md",
    ]);
  });

  test("open-questions is not required before it exists (PLC-018)", () => {
    const result = createPersonalPlan(
      context({ initialPages: ["/quickstart.md", "/sources/google.md"] }),
      plan([]),
    );
    expect(paths(result)).not.toContain("/open-questions.md");
  });

  test("a planner that seeds open-questions makes it a regular job", () => {
    const result = createPersonalPlan(
      context(),
      plan([page("/open-questions.md", [GMAIL])]),
    );
    expect(job(result, "/open-questions.md").maintenance).toBeUndefined();
  });

  test("init requires only /quickstart.md (PLC-018)", () => {
    const result = createPersonalPlan(
      context({ mode: "init", frontier: [], initialPages: [] }),
      plan([]),
    );
    expect(paths(result)).toEqual(["/quickstart.md"]);
  });

  test("init on a wiki with open-questions and no evidence adds only quickstart", () => {
    const result = createPersonalPlan(
      context({ mode: "init", frontier: [] }),
      plan([]),
    );
    expect(paths(result)).toEqual(["/quickstart.md"]);
  });

  test("an update requires quickstart only when it adds or deletes a page", () => {
    const existingOnly = createPersonalPlan(
      context({ frontier: [], instruction: "x" }),
      plan([page("/commitments.md")]),
    );
    expect(paths(existingOnly)).not.toContain("/quickstart.md");

    const creates = createPersonalPlan(
      context({ frontier: [], instruction: "x" }),
      plan([page("/people/dana.md")]),
    );
    expect(paths(creates)).toContain("/quickstart.md");

    const deletes = createPersonalPlan(
      context({ frontier: [], instruction: "x" }),
      plan([], ["/topics/old.md"]),
    );
    expect(paths(deletes)).toContain("/quickstart.md");
  });

  test("a new source page requires quickstart", () => {
    const result = createPersonalPlan(context(), plan([]));
    // /sources/slack.md is not among the initial pages.
    expect(paths(result)).toContain("/quickstart.md");
  });

  test("adds a rewrite job for each required page except deleted ones", () => {
    const result = createPersonalPlan(
      context({
        frontier: [],
        languageChanged: true,
        requiredRewritePages: ["/commitments.md", "/topics/old.md"],
      }),
      plan([], ["/topics/old.md"]),
    );
    expect(paths(result)).toEqual(["/commitments.md", "/quickstart.md"]);
  });
});

describe("queue order (PLC-009)", () => {
  test("orders domain, canonical, source, open-questions, then quickstart", () => {
    const result = createPersonalPlan(
      context(),
      plan([
        page("/quickstart.md"),
        page("/themes.md"),
        page("/sources/google.md"),
        page("/people/zed.md"),
        page("/commitments.md"),
        page("/personal-logistics.md"),
        page("/people/ana.md"),
        page("/Projects.md"),
      ]),
    );
    expect(paths(result)).toEqual([
      "/Projects.md",
      "/people/ana.md",
      "/people/zed.md",
      "/commitments.md",
      "/personal-logistics.md",
      "/themes.md",
      "/sources/google.md",
      "/sources/slack.md",
      "/open-questions.md",
      "/quickstart.md",
    ]);
  });

  test("matches the spec example queue", () => {
    const result = createPersonalPlan(
      context({
        frontier: [
          {
            connectorId: "google",
            rawRunIds: [RUN_2],
            rawFiles: [`${RUN_2}/gmail-messages.json`],
            frozen: true,
          },
        ],
      }),
      plan([
        page("/commitments.md", [`${GMAIL}#/messages/3`]),
        {
          ...page("/people/dana-ruiz.md", [`${GMAIL}#/messages/3`]),
          instructions: ["topic key: q4-review"],
        },
      ]),
    );
    expect(paths(result)).toEqual([
      "/people/dana-ruiz.md",
      "/commitments.md",
      "/sources/google.md",
      "/open-questions.md",
      "/quickstart.md",
    ]);
    expect(job(result, "/sources/google.md").seedEvidence).toEqual([GMAIL]);
  });
});

describe("samePersonalPlan", () => {
  test("ignores job IDs and progress, not content", () => {
    const left = createPersonalPlan(context(), plan([page("/a.md")]));
    const right = createPersonalPlan(context(), plan([page("/a.md")]));
    right.pages[0] = { ...right.pages[0], status: "complete" };

    expect(samePersonalPlan(left, right)).toBe(true);
    expect(
      samePersonalPlan(
        left,
        createPersonalPlan(context(), plan([page("/b.md")])),
      ),
    ).toBe(false);
  });
});

describe("extractActiveSection", () => {
  test("returns the Active body up to the next section", () => {
    const markdown = [
      "---",
      "type: Open Questions",
      "---",
      "# Open Questions",
      "",
      "## Active",
      "",
      "### gym: Where is the workout class?",
      "- Seen: 2026-10-01",
      "",
      "## Answered",
      "",
      "### trip: Is the trip on?",
    ].join("\n");
    expect(extractActiveSection(markdown)).toBe(
      "### gym: Where is the workout class?\n- Seen: 2026-10-01",
    );
  });

  test("returns null for a missing or empty section", () => {
    expect(extractActiveSection("# Open Questions\n")).toBeNull();
    expect(extractActiveSection("## Active\n\n## Answered\n- x\n")).toBeNull();
  });
});
