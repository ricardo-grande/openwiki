import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProtocolTool } from "../../src/integrations/core/protocol.ts";

const SECRETS = {
  OPENWIKI_GMAIL_REFRESH_TOKEN: "google-refresh-secret-value",
  OPENWIKI_SLACK_USER_TOKEN: "xoxp-slack-secret-value",
  ANTHROPIC_API_KEY: "sk-ant-model-secret-value",
} as const;
const TOUCHED_KEYS = [...Object.keys(SECRETS), "OPENWIKI_CONFIG_DIR"];
const RAW_RUN = "2026-10-07T06-00-01-120Z";
const OLDER_RAW_RUN = "2026-10-06T06-00-00-000Z";

let home: string;
let wiki: string;
let outside: string;
let savedEnv: Record<string, string | undefined>;

/**
 * Writes one file, creating its parent directories.
 *
 * @param file - Absolute file path.
 * @param content - File content.
 */
async function put(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

/**
 * Loads the personal tools against the temporary home.
 *
 * @returns The tools keyed by name, in registration order.
 */
async function loadTools(): Promise<Map<string, ProtocolTool>> {
  const { PersonalSessionManager } =
    await import("../../src/integrations/personal/session-manager.ts");
  const manager = PersonalSessionManager.create({ host: "claude" });
  return new Map(manager.tools().map((tool) => [tool.name, tool]));
}

/**
 * Calls one personal tool by name.
 *
 * @param name - Tool name.
 * @param input - Tool input.
 * @returns The tool result.
 */
async function call(name: string, input: unknown = {}): Promise<unknown> {
  const tool = (await loadTools()).get(name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.handle(input);
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(
    TOUCHED_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of TOUCHED_KEYS) delete process.env[key];

  home = await mkdtemp(path.join(os.tmpdir(), "openwiki-personal-tools-"));
  outside = await mkdtemp(path.join(os.tmpdir(), "openwiki-personal-out-"));
  wiki = path.join(home, "wiki");
  process.env.OPENWIKI_CONFIG_DIR = home;

  await put(
    path.join(home, ".env"),
    Object.entries(SECRETS)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );
  await put(
    path.join(home, "onboarding.json"),
    JSON.stringify({
      version: 1,
      sources: {},
      sourceInstances: [
        {
          id: "google-1",
          connectorId: "google",
          name: "Work mail",
          connectedAt: "2026-10-01T00:00:00.000Z",
          ingestionGoal: "Track commitments",
        },
      ],
    }),
  );
  await put(path.join(home, "INSTRUCTIONS.md"), "Keep my commitments.\n");
  await put(path.join(home, "connectors", "google", "config.json"), "{}");

  await put(
    path.join(wiki, "commitments.md"),
    [
      "---",
      "type: Commitments",
      "title: Commitments",
      "description: What the user promised and to whom.",
      "---",
      "",
      "# Commitments",
      "",
      "## Active",
      "",
      "- Send Dana the Q4 review draft by Friday.",
      "",
      "## Done",
      "",
      "- Booked the offsite venue.",
      "",
    ].join("\n"),
  );
  await put(
    path.join(wiki, "people", "dana-ruiz.md"),
    [
      "---",
      "type: Person",
      "title: Dana Ruiz",
      "description: Engineering manager.",
      "resource: https://linear.app/acme/issue/ZX-4471",
      "---",
      "",
      "# Dana Ruiz",
      "",
      "Leads the platform team.",
      "",
    ].join("\n"),
  );
  await put(path.join(wiki, "index.md"), "# Index\n\nDana commitments\n");
  await put(path.join(wiki, "log.md"), "# Log\n\nDana commitments\n");
  await put(
    path.join(wiki, ".last-update.json"),
    JSON.stringify({
      updatedAt: "2026-10-07T07:00:00.000Z",
      command: "update",
      model: "anthropic:claude-opus-5-5",
      status: "complete",
    }),
  );

  const raw = path.join(home, "connectors", "google", "raw");
  await put(
    path.join(raw, RAW_RUN, "gmail-messages.json"),
    JSON.stringify({ messages: [{ subject: "Q4 review" }] }),
  );
  await put(path.join(raw, OLDER_RAW_RUN, "gmail-messages.json"), "{}");

  vi.resetModules();
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  await rm(home, { force: true, recursive: true });
  await rm(outside, { force: true, recursive: true });
});

describe("personal retrieval tools", () => {
  test("registers the stage-H2 tools in host §3.2 order (PHM-005)", async () => {
    expect([...(await loadTools()).keys()]).toEqual([
      "openwiki_personal_search",
      "openwiki_personal_read",
      "openwiki_personal_list_pages",
      "openwiki_personal_status",
      "openwiki_personal_list_raw_items",
      "openwiki_personal_read_raw_item",
    ]);
  });

  test("rejects unknown input fields", async () => {
    for (const [name, input] of [
      ["openwiki_personal_search", { query: "Dana", root: "/" }],
      ["openwiki_personal_read", { page: "commitments.md", wiki: "x" }],
      ["openwiki_personal_status", { verbose: true }],
    ] as const) {
      const tool = (await loadTools()).get(name);
      expect(tool?.schema.safeParse(input).success).toBe(false);
    }
  });

  test("searches a non-Git home with relative refs (PHM-007)", async () => {
    const result = await call("openwiki_personal_search", {
      query: "Dana Q4 review",
    });

    expect(result).toMatchObject({ wiki: "personal" });
    expect(
      (result as { results: { kind: string }[] }).results.every(
        (item) => item.kind === "section",
      ),
    ).toBe(true);
    const refs = (result as { results: { ref: string[] }[] }).results.flatMap(
      (item) => item.ref,
    );
    expect(refs).toContain("commitments.md#active");
    expect(refs.every((ref) => !ref.startsWith("openwiki/"))).toBe(true);
    expect(refs.some((ref) => /^(index|log)\.md#/u.test(ref))).toBe(false);
  });

  test("searches front-matter resource values", async () => {
    await expect(
      call("openwiki_personal_search", { query: "ZX-4471" }),
    ).resolves.toMatchObject({
      results: [{ ref: ["people/dana-ruiz.md#dana-ruiz"] }],
    });
  });

  test("reads named sections, accepting x.md and /x.md", async () => {
    for (const page of ["commitments.md", "/commitments.md"]) {
      await expect(
        call("openwiki_personal_read", { page, sections: ["active"] }),
      ).resolves.toEqual({
        page: "commitments.md",
        sections: [
          {
            section: "active",
            content: "## Active\n\n- Send Dana the Q4 review draft by Friday.",
          },
        ],
      });
    }
  });

  test("reads a whole page with its byte version", async () => {
    const result = (await call("openwiki_personal_read", {
      page: "people/dana-ruiz.md",
    })) as { page: string; content: string; version: string };

    expect(result.page).toBe("people/dana-ruiz.md");
    expect(result.content).toMatch(/^---\ntype: Person\n/u);
    expect(result.version).toBe(
      `sha256:${createHash("sha256").update(result.content).digest("hex")}`,
    );
  });

  test.each([
    "../commitments.md",
    "./commitments.md",
    "people/../commitments.md",
    ".hidden/page.md",
    "openwiki/commitments.md",
    "/openwiki/commitments.md",
    "index.md",
    "log.md",
  ])("rejects page %s with invalid_input", async (page) => {
    await expect(
      call("openwiki_personal_read", { page }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("reports a missing page as invalid_input", async () => {
    await expect(
      call("openwiki_personal_read", { page: "nowhere.md" }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "The requested personal wiki page does not exist.",
    });
  });

  test("lists concept pages, optionally under a directory", async () => {
    await expect(call("openwiki_personal_list_pages")).resolves.toEqual({
      pages: [
        {
          path: "/commitments.md",
          type: "Commitments",
          title: "Commitments",
          description: "What the user promised and to whom.",
        },
        {
          path: "/people/dana-ruiz.md",
          type: "Person",
          title: "Dana Ruiz",
          description: "Engineering manager.",
        },
      ],
    });
    for (const dir of ["/people", "people/", "/people/"]) {
      await expect(
        call("openwiki_personal_list_pages", { dir }),
      ).resolves.toMatchObject({ pages: [{ path: "/people/dana-ruiz.md" }] });
    }
    await expect(
      call("openwiki_personal_list_pages", { dir: "../connectors" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("returns no results when the wiki directory is missing", async () => {
    await rm(wiki, { force: true, recursive: true });

    await expect(
      call("openwiki_personal_search", { query: "Dana" }),
    ).resolves.toEqual({ wiki: "personal", results: [] });
    await expect(call("openwiki_personal_list_pages")).resolves.toEqual({
      pages: [],
    });
    await expect(
      call("openwiki_personal_read", { page: "commitments.md" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("refuses a symlinked page and skips it in search (PHM-008)", async () => {
    await put(path.join(outside, "secret.md"), "# Secret\n\nDana outside\n");
    await symlink(
      path.join(outside, "secret.md"),
      path.join(wiki, "linked.md"),
    );

    await expect(
      call("openwiki_personal_read", { page: "linked.md" }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    const result = (await call("openwiki_personal_search", {
      query: "outside",
    })) as { results: unknown[] };
    expect(result.results).toEqual([]);
  });

  test("refuses a symlinked wiki directory (PHM-008)", async () => {
    await rm(wiki, { force: true, recursive: true });
    await put(path.join(outside, "commitments.md"), "# Commitments\n\nDana\n");
    await symlink(outside, wiki);

    for (const [name, input] of [
      ["openwiki_personal_search", { query: "Dana" }],
      ["openwiki_personal_read", { page: "commitments.md" }],
      ["openwiki_personal_list_pages", {}],
    ] as const) {
      await expect(call(name, input)).rejects.toMatchObject({
        code: "invalid_state",
      });
    }
  });

  test("reports status without loading the connector environment", async () => {
    const { connectors, ...status } = (await call(
      "openwiki_personal_status",
    )) as {
      connectors: {
        id: string;
        configExists: boolean;
        requiredEnv: { key: string; set: boolean }[];
      }[];
    };

    expect(status).toEqual({
      wikiDir: wiki,
      lastUpdate: {
        updatedAt: "2026-10-07T07:00:00.000Z",
        command: "update",
        model: "anthropic:claude-opus-5-5",
        status: "complete",
        language: null,
      },
      wikiGoal: "Keep my commitments.",
      sourceInstances: [
        {
          id: "google-1",
          connectorId: "google",
          name: "Work mail",
          connectedAt: "2026-10-01T00:00:00.000Z",
          ingestionGoal: "Track commitments",
        },
      ],
      synthesisCursor: null,
      pending: null,
      activeRun: null,
    });
    const google = connectors.find((connector) => connector.id === "google");
    expect(google?.configExists).toBe(true);
    expect(google?.requiredEnv).toContainEqual({
      key: "OPENWIKI_GMAIL_REFRESH_TOKEN",
      set: true,
    });
    expect(connectors.map((connector) => connector.id)).not.toContain(
      "langsmith",
    );
    for (const key of Object.keys(SECRETS)) {
      expect(process.env[key]).toBeUndefined();
    }
  });

  test("lists raw items newest run first", async () => {
    await expect(
      call("openwiki_personal_list_raw_items", { connectorId: "google" }),
    ).resolves.toEqual({
      connectorId: "google",
      files: [
        `${RAW_RUN}/gmail-messages.json`,
        `${OLDER_RAW_RUN}/gmail-messages.json`,
      ],
      latestFiles: [`${RAW_RUN}/gmail-messages.json`],
      latestRunId: RAW_RUN,
    });
    await expect(
      call("openwiki_personal_list_raw_items", { connectorId: "slack" }),
    ).resolves.toMatchObject({ files: [], latestRunId: null });
  });

  test("wraps raw content in the untrusted envelope (PHM-012)", async () => {
    await expect(
      call("openwiki_personal_read_raw_item", {
        connectorId: "google",
        path: `${RAW_RUN}/gmail-messages.json`,
        maxBytes: 10,
      }),
    ).resolves.toEqual({
      untrusted: true,
      source: "google",
      content: '{"messages',
      truncated: true,
    });
  });

  test("keeps the raw read cap and refuses escapes and symlinks", async () => {
    const tool = (await loadTools()).get("openwiki_personal_read_raw_item");
    expect(
      tool?.schema.safeParse({
        connectorId: "google",
        path: `${RAW_RUN}/gmail-messages.json`,
        maxBytes: 500_001,
      }).success,
    ).toBe(false);
    expect(
      tool?.schema.safeParse({ connectorId: "langsmith", path: "x.json" })
        .success,
    ).toBe(false);

    await put(path.join(outside, "leak.json"), "{}");
    await symlink(
      path.join(outside, "leak.json"),
      path.join(home, "connectors", "google", "raw", RAW_RUN, "leak.json"),
    );
    for (const rawPath of [
      "../config.json",
      "../../../.env",
      `${RAW_RUN}/leak.json`,
      `${RAW_RUN}/missing.json`,
      RAW_RUN,
    ]) {
      await expect(
        call("openwiki_personal_read_raw_item", {
          connectorId: "google",
          path: rawPath,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  test("returns no secret value from any tool (PHM-009)", async () => {
    Object.assign(process.env, SECRETS);
    const results = [
      await call("openwiki_personal_search", { query: "Dana" }),
      await call("openwiki_personal_read", { page: "commitments.md" }),
      await call("openwiki_personal_list_pages"),
      await call("openwiki_personal_status"),
      await call("openwiki_personal_list_raw_items", { connectorId: "google" }),
      await call("openwiki_personal_read_raw_item", {
        connectorId: "google",
        path: `${RAW_RUN}/gmail-messages.json`,
      }),
    ];

    const serialized = JSON.stringify(results);
    for (const value of Object.values(SECRETS)) {
      expect(serialized).not.toContain(value);
    }
  });
});
