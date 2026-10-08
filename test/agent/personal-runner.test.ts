import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { scheduler } from "node:timers/promises";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ToolMessage } from "@langchain/core/messages";
import type { BackendProtocol } from "deepagents";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

// Isolated OpenWiki home: the core resolves the wiki, raw store, and
// onboarding.json from OPENWIKI_CONFIG_DIR when its modules load.
const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const directory = mkdtempSync(
    path.join(tmpdir(), "openwiki-personal-runner-"),
  );
  vi.stubEnv("OPENWIKI_CONFIG_DIR", directory);
  return directory;
});

type FakeTool = {
  name: string;
  invoke(input: unknown): Promise<unknown>;
};

type FakeAgent = {
  name: string;
  tools: FakeTool[];
  backend: BackendProtocol;
  systemPrompt: string;
  subagents: unknown[];
  middleware: unknown[];
};

type Script = (agent: FakeAgent) => Promise<void>;

const harness = vi.hoisted(() => ({
  agents: [] as FakeAgent[],
  filesystemTools: [] as string[][],
  scripts: new Map<"gather" | "planner" | "worker", Script>(),
}));

vi.mock("deepagents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("deepagents")>();
  return {
    ...actual,
    createFilesystemMiddleware(
      options: NonNullable<
        Parameters<typeof actual.createFilesystemMiddleware>[0]
      >,
    ) {
      harness.filesystemTools.push([...(options.tools ?? [])]);
      return actual.createFilesystemMiddleware(options);
    },
    createDeepAgent(agent: FakeAgent) {
      harness.agents.push(agent);
      const script =
        agent.name === "gather agent"
          ? (harness.scripts.get("gather") ?? closeGathering)
          : agent.name === "planning agent"
            ? (harness.scripts.get("planner") ?? submitEmptyPlan)
            : (harness.scripts.get("worker") ?? writeAndSubmit);
      return {
        stream: () =>
          Promise.resolve({
            async *[Symbol.asyncIterator]() {
              await script(agent);
              yield* [];
            },
          }),
      };
    },
  };
});

import { NO_DELEGATION_MIDDLEWARE } from "../../src/agent/page-workers.ts";
import { runNativePersonalGeneration } from "../../src/agent/personal-runner.ts";
import type { OpenWikiRunEvent } from "../../src/agent/types.ts";
import { readPersonalRunLock } from "../../src/generation/personal-run-lock.ts";
import {
  readPersonalRunState,
  readSynthesisCursor,
} from "../../src/generation/personal-run-state.ts";

const wikiDir = path.join(home, "wiki");
const model = {} as BaseChatModel;
const RAW_1 = "2026-10-07T06-00-00-000Z";

let toolCallCount = 0;

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  harness.agents.length = 0;
  harness.filesystemTools.length = 0;
  harness.scripts.clear();
  for (const entry of await readdir(home)) {
    await rm(path.join(home, entry), { recursive: true, force: true });
  }
  await mkdir(wikiDir, { recursive: true });
});

/**
 * Calls one of an agent's tools as the model would, and parses its result.
 */
async function call(
  agent: FakeAgent,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const tool = agent.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${agent.name} has no ${name} tool.`);
  toolCallCount += 1;
  const result = await tool.invoke({
    name,
    args,
    id: `${name}-${toolCallCount}`,
    type: "tool_call",
  });
  const content = result instanceof ToolMessage ? result.content : result;
  if (typeof content !== "string") {
    throw new Error(`${name} returned non-text content.`);
  }
  return JSON.parse(content) as Record<string, unknown>;
}

/**
 * The page a worker owns, from its prompt.
 */
function ownedPage(agent: FakeAgent): string {
  const match = /^You own exactly (.+)\.$/mu.exec(agent.systemPrompt);
  if (!match) throw new Error(`${agent.name} owns no page.`);
  return match[1];
}

function pageMarkdown(title: string, body = `${title} body.`): string {
  return `---\ntype: Note\ntitle: ${title}\ndescription: ${title} summary.\n---\n\n# ${title}\n\n${body}\n`;
}

async function closeGathering(agent: FakeAgent): Promise<void> {
  await call(agent, "close_gathering");
}

async function submitEmptyPlan(agent: FakeAgent): Promise<void> {
  await call(agent, "submit_plan", { pages: [] });
}

async function writeAndSubmit(agent: FakeAgent): Promise<void> {
  const page = ownedPage(agent);
  const result = await agent.backend.write(page, pageMarkdown(page));
  if (result.error) throw new Error(result.error);
  await call(agent, "submit_page");
}

async function connect(...connectorIds: string[]): Promise<void> {
  await writeFile(
    path.join(home, "onboarding.json"),
    JSON.stringify({
      version: 1,
      sourceInstances: connectorIds.map((connectorId) => ({
        id: `${connectorId}-1`,
        connectorId,
        name: `${connectorId} 1`,
        connectedAt: "2026-10-01T00:00:00.000Z",
        ingestionGoal: `Keep what matters from ${connectorId}.`,
      })),
    }),
  );
}

async function writeRawRun(
  connectorId: string,
  rawRunId: string,
  files: Record<string, unknown>,
): Promise<void> {
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(
      home,
      "connectors",
      connectorId,
      "raw",
      rawRunId,
      name,
    );
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  }
}

async function writeWikiPage(page: string, markdown: string): Promise<void> {
  const file = path.join(wikiDir, page);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, markdown);
}

async function readWikiPage(page: string): Promise<string | null> {
  try {
    return await readFile(path.join(wikiDir, page), "utf8");
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

const GMAIL = {
  "gmail-messages.json": {
    messages: [
      { id: "m1", subject: "Q4 review follow-up", from: "dana@example.com" },
      { id: "m2", subject: "Weekly newsletter" },
    ],
  },
};

describe("runNativePersonalGeneration", () => {
  test("drives an update from evidence through planning, pages, and finish", async () => {
    await connect("google");
    await writeRawRun("google", RAW_1, GMAIL);
    await writeWikiPage(
      "/open-questions.md",
      pageMarkdown(
        "Open Questions",
        "## Active\n\n### q4: Who owns the Q4 review?\n- Owner: unknown",
      ),
    );
    const seed = `raw://google/${RAW_1}/gmail-messages.json#/messages/0`;
    let listed: Record<string, unknown> = {};
    let read: Record<string, unknown> = {};
    let outside: Record<string, unknown> = {};
    harness.scripts.set("planner", async (agent) => {
      listed = await call(agent, "openwiki_list_raw_items");
      read = await call(agent, "openwiki_read_raw_item", { ref: seed });
      outside = await call(agent, "openwiki_read_raw_item", {
        ref: `raw://slack/${RAW_1}/my-recent-messages.json`,
      });
      await call(agent, "submit_plan", {
        pages: [
          {
            path: "/commitments.md",
            title: "Commitments",
            purpose: "Add the Q4 review follow-up.",
            seedEvidence: [seed],
          },
        ],
      });
    });
    const events: OpenWikiRunEvent[] = [];

    const result = await runNativePersonalGeneration({
      mode: "update",
      modelId: "test-model",
      model,
      onEvent: (event) => events.push(event),
    });

    expect(result).toEqual({ skipped: false, lastUpdateStatus: "complete" });
    expect(listed).toEqual({
      connectors: [
        {
          connectorId: "google",
          rawRunIds: [RAW_1],
          refs: [`raw://google/${RAW_1}/gmail-messages.json`],
        },
      ],
    });
    expect(read).toMatchObject({ untrusted: true, ref: seed });
    expect(JSON.parse(String(read.content))).toEqual(
      GMAIL["gmail-messages.json"].messages[0],
    );
    expect(String(outside.error)).toMatch(/frontier/u);

    expect(harness.agents.map(({ name }) => name)).toEqual([
      "planning agent",
      "worker agent: commitments",
      "worker agent: sources/google",
      "worker agent: open-questions",
      "worker agent: quickstart",
    ]);
    const [planner, , , openQuestions] = harness.agents;
    expect(planner.systemPrompt).toContain(
      `raw://google/${RAW_1}/gmail-messages.json`,
    );
    expect(planner.systemPrompt).toContain("Who owns the Q4 review?");
    expect(planner.systemPrompt).toContain("Keep what matters from google.");
    expect(openQuestions.systemPrompt).toContain("maintenance job");
    expect(openQuestions.systemPrompt).toMatch(
      /Pages changed in this run:\n- \/commitments\.md\n- \/sources\/google\.md/u,
    );

    expect(await readWikiPage("/commitments.md")).toContain(
      "# /commitments.md",
    );
    expect(await readWikiPage("/quickstart.md")).not.toBeNull();
    expect(
      (await readSynthesisCursor(wikiDir)).connectors.google,
    ).toMatchObject({ synthesizedThrough: RAW_1 });
    expect(await readPersonalRunState(wikiDir)).toBeNull();
    expect(await readPersonalRunLock(wikiDir)).toBeNull();
    expect(
      JSON.parse(
        await readFile(path.join(wikiDir, ".last-update.json"), "utf8"),
      ),
    ).toMatchObject({ command: "update", status: "complete" });

    const stages = events.flatMap((event) =>
      event.type === "repository_progress"
        ? [`${event.wiki}:${event.stage}`]
        : [],
    );
    expect(stages[0]).toBe("personal:planning");
    expect(stages).toContain("personal:generating");
    expect(stages.at(-1)).toBe("personal:finalizing");
  });

  test("gives no worker a shell, ingest tools, delegation, or writes outside its page (PLC-016)", async () => {
    await connect("google", "notion");
    await writeRawRun("google", RAW_1, GMAIL);
    const refusals: Record<string, string | undefined> = {};
    let wrongConnector: Record<string, unknown> = {};
    harness.scripts.set("gather", async (agent) => {
      refusals.gather = (await agent.backend.write("/x.md", "x")).error;
      wrongConnector = await call(agent, "openwiki_list_mcp_tools", {
        connectorId: "google",
      });
      await call(agent, "close_gathering");
    });
    harness.scripts.set("planner", async (agent) => {
      refusals.planner = (await agent.backend.write("/x.md", "x")).error;
      await call(agent, "submit_plan", { pages: [] });
    });
    harness.scripts.set("worker", async (agent) => {
      refusals.worker = (await agent.backend.write("/other.md", "x")).error;
      await writeAndSubmit(agent);
    });

    await runNativePersonalGeneration({
      mode: "update",
      modelId: "test-model",
      model,
    });

    const toolNames = (agent: FakeAgent) =>
      agent.tools.map(({ name }) => name).sort();
    const [gather, planner, worker] = harness.agents;
    expect(gather.name).toBe("gather agent");
    expect(toolNames(gather)).toEqual([
      "close_gathering",
      "openwiki_call_mcp_tool",
      "openwiki_list_mcp_tools",
    ]);
    expect(toolNames(planner)).toEqual([
      "openwiki_list_raw_items",
      "openwiki_read_raw_item",
      "submit_plan",
    ]);
    expect(toolNames(worker)).toEqual([
      "openwiki_list_raw_items",
      "openwiki_read_raw_item",
      "submit_page",
    ]);
    expect(harness.filesystemTools).toEqual([
      ["read_file", "ls", "glob", "grep"],
      ["read_file", "ls", "glob", "grep"],
      ...harness.agents
        .slice(2)
        .map(() => [
          "read_file",
          "ls",
          "glob",
          "grep",
          "write_file",
          "edit_file",
        ]),
    ]);
    for (const agent of harness.agents) {
      expect(toolNames(agent).join(" ")).not.toMatch(/ingest|execute|task/u);
      expect(agent.subagents).toEqual([]);
      expect(agent.middleware).toContain(NO_DELEGATION_MIDDLEWARE);
    }
    expect(refusals.gather).toMatch(/may not modify/u);
    expect(refusals.planner).toMatch(/may not modify/u);
    expect(refusals.worker).toMatch(/may not modify/u);
    expect(String(wrongConnector.error)).toMatch(/gathers only from notion/u);
  });

  test("adds raw runs recorded during gathering to the frontier", async () => {
    await connect("notion");
    const gathered = new Date(Date.now() + 60_000)
      .toISOString()
      .replace(/[:.]/gu, "-");
    harness.scripts.set("gather", async () => {
      // An MCP call records its result as a raw run; the worker then ends
      // without close_gathering, so the driver closes gathering itself.
      await writeRawRun("notion", gathered, {
        "mcp-tool-result.json": { result: { title: "Q4 plan" } },
      });
    });
    let listed: Record<string, unknown> = {};
    harness.scripts.set("planner", async (agent) => {
      listed = await call(agent, "openwiki_list_raw_items", {
        connectorId: "notion",
      });
      await call(agent, "submit_plan", { pages: [] });
    });

    const result = await runNativePersonalGeneration({
      mode: "update",
      modelId: "test-model",
      model,
    });

    expect(result.lastUpdateStatus).toBe("complete");
    expect(listed).toEqual({
      connectors: [
        {
          connectorId: "notion",
          rawRunIds: [gathered],
          refs: [`raw://notion/${gathered}/mcp-tool-result.json`],
        },
      ],
    });
    expect(harness.agents[1].systemPrompt).toContain(
      `raw://notion/${gathered}/mcp-tool-result.json`,
    );
    expect(
      (await readSynthesisCursor(wikiDir)).connectors.notion,
    ).toMatchObject({ synthesizedThrough: gathered });
  });

  test("rejects a worker write over a page edited on disk until the worker reads it again (PLC-017)", async () => {
    await connect("google");
    await writeRawRun("google", RAW_1, GMAIL);
    harness.scripts.set("planner", async (agent) => {
      await call(agent, "submit_plan", {
        pages: [
          {
            path: "/commitments.md",
            title: "Commitments",
            purpose: "Add the follow-up.",
          },
        ],
      });
    });
    const results: Record<string, string | undefined> = {};
    let onDiskAfterConflict: string | null = null;
    harness.scripts.set("worker", async (agent) => {
      const page = ownedPage(agent);
      if (page !== "/commitments.md") return writeAndSubmit(agent);

      results.first = (
        await agent.backend.write(page, pageMarkdown("Worker v1"))
      ).error;
      // Its own write moved the base version, so a second write applies.
      results.second = (
        await agent.backend.write(page, pageMarkdown("Worker v2"))
      ).error;
      await writeWikiPage(page, pageMarkdown("User edit"));
      results.staleWrite = (
        await agent.backend.write(page, pageMarkdown("Worker v3"))
      ).error;
      results.staleEdit = (
        await agent.backend.edit(page, "User edit body.", "Worker edit.")
      ).error;
      onDiskAfterConflict = await readWikiPage(page);

      await agent.backend.read(page);
      results.afterRead = (
        await agent.backend.edit(page, "User edit body.", "User edit, kept.")
      ).error;
      await call(agent, "submit_page");
    });

    await runNativePersonalGeneration({
      mode: "update",
      modelId: "test-model",
      model,
    });

    expect(results.first).toBeUndefined();
    expect(results.second).toBeUndefined();
    expect(results.staleWrite).toMatch(/changed since version/u);
    expect(results.staleEdit).toMatch(/changed since version/u);
    expect(onDiskAfterConflict).toBe(pageMarkdown("User edit"));
    expect(results.afterRead).toBeUndefined();
    expect(await readWikiPage("/commitments.md")).toContain("User edit, kept.");
  });

  test("skips a page whose worker never submits, and holds its connector's cursor", async () => {
    await connect("google");
    await writeRawRun("google", RAW_1, GMAIL);
    harness.scripts.set("worker", async (agent) => {
      if (ownedPage(agent) === "/sources/google.md") {
        await agent.backend.write("/sources/google.md", pageMarkdown("Half"));
        return;
      }
      await writeAndSubmit(agent);
    });
    const events: OpenWikiRunEvent[] = [];

    const result = await runNativePersonalGeneration({
      mode: "update",
      modelId: "test-model",
      model,
      onEvent: (event) => events.push(event),
    });

    expect(result).toEqual({ skipped: false, lastUpdateStatus: "interrupted" });
    expect(
      harness.agents.filter(
        ({ name }) => name === "worker agent: sources/google",
      ),
    ).toHaveLength(2);
    expect(await readWikiPage("/sources/google.md")).toBeNull();
    expect((await readSynthesisCursor(wikiDir)).connectors.google).toBe(
      undefined,
    );
    expect(
      events.some(
        (event) =>
          event.type === "text" &&
          event.text.includes("Evidence from google stays pending"),
      ),
    ).toBe(true);
  });

  test("releases the lock and keeps the run resumable when it fails, then another run finishes it (PLC-019)", async () => {
    await connect("google");
    await writeRawRun("google", RAW_1, GMAIL);
    harness.scripts.set("planner", () =>
      Promise.reject(new Error("provider unavailable")),
    );

    await expect(
      runNativePersonalGeneration({
        mode: "update",
        modelId: "test-model",
        model,
      }),
    ).rejects.toThrow("provider unavailable");

    expect(await readPersonalRunLock(wikiDir)).toBeNull();
    expect(await readPersonalRunState(wikiDir)).toMatchObject({
      phase: "planning",
    });

    harness.scripts.set("planner", submitEmptyPlan);
    const events: OpenWikiRunEvent[] = [];
    const result = await runNativePersonalGeneration({
      mode: "update",
      modelId: "test-model",
      model,
      holder: "host-claude:elsewhere:4711",
      onEvent: (event) => events.push(event),
    });

    expect(result.lastUpdateStatus).toBe("complete");
    expect(events[0]).toMatchObject({ stage: "planning", resumed: true });
    expect(await readPersonalRunState(wikiDir)).toBeNull();
    expect(await readPersonalRunLock(wikiDir)).toBeNull();
    expect(
      (await readSynthesisCursor(wikiDir)).connectors.google,
    ).toMatchObject({ synthesizedThrough: RAW_1 });
  });

  test("rewrites every existing page on a language change, without a planner (PLC-015)", async () => {
    await writeWikiPage("/quickstart.md", pageMarkdown("Quickstart"));
    await writeWikiPage("/topics/q4.md", pageMarkdown("Q4"));
    await writeFile(
      path.join(wikiDir, ".last-update.json"),
      JSON.stringify({
        updatedAt: "2026-10-06T06:00:00.000Z",
        command: "update",
        model: "test-model",
        status: "complete",
        language: "en",
      }),
    );

    const result = await runNativePersonalGeneration({
      mode: "update",
      language: "fr",
      modelId: "test-model",
      model,
    });

    expect(result.lastUpdateStatus).toBe("complete");
    expect(harness.agents.map(({ name }) => name)).toEqual([
      "worker agent: topics/q4",
      "worker agent: quickstart",
    ]);
    for (const agent of harness.agents) {
      expect(agent.systemPrompt).toContain("Output language: fr");
      expect(agent.systemPrompt).toContain(
        "Rewrite this existing page in the run's language",
      );
    }
  });

  test("initializes with only the quickstart job when there is no evidence (PLC-018)", async () => {
    const result = await runNativePersonalGeneration({
      mode: "init",
      modelId: "test-model",
      model,
    });

    expect(result).toEqual({ skipped: false, lastUpdateStatus: "complete" });
    expect(harness.agents.map(({ name }) => name)).toEqual([
      "worker agent: quickstart",
    ]);
    expect(await readWikiPage("/quickstart.md")).not.toBeNull();
  });

  test("starts no worker for an update with nothing to do", async () => {
    const events: OpenWikiRunEvent[] = [];

    const result = await runNativePersonalGeneration({
      mode: "update",
      modelId: "test-model",
      model,
      onEvent: (event) => events.push(event),
    });

    expect(result).toEqual({ skipped: true });
    expect(harness.agents).toEqual([]);
    expect(events).toEqual([
      { type: "repository_progress", wiki: "personal", stage: "noop" },
    ]);
    expect(await exists(path.join(wikiDir, ".run.json"))).toBe(false);
  });

  test("renews the lock on a timer while a worker runs", async () => {
    const renewals: string[] = [];
    harness.scripts.set("worker", async (agent) => {
      renewals.push((await readPersonalRunLock(wikiDir))?.renewedAt ?? "");
      await scheduler.wait(40);
      renewals.push((await readPersonalRunLock(wikiDir))?.renewedAt ?? "");
      await writeAndSubmit(agent);
    });

    await runNativePersonalGeneration({
      mode: "init",
      modelId: "test-model",
      model,
      lockRenewalIntervalMs: 5,
    });

    expect(renewals[1] > renewals[0]).toBe(true);
  });
});
