import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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
    path.join(tmpdir(), "openwiki-personal-handoff-"),
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
};

type Script = (agent: FakeAgent) => Promise<void>;

// The native driver's agents run scripts instead of a model.
const harness = vi.hoisted(() => ({
  agents: [] as FakeAgent[],
  scripts: new Map<"planner" | "worker", Script>(),
}));

vi.mock("deepagents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("deepagents")>();
  return {
    ...actual,
    createDeepAgent(agent: FakeAgent) {
      harness.agents.push(agent);
      const script =
        agent.name === "planning agent"
          ? harness.scripts.get("planner")
          : harness.scripts.get("worker");
      return {
        stream: () =>
          Promise.resolve({
            async *[Symbol.asyncIterator]() {
              if (!script) throw new Error(`No script for ${agent.name}.`);
              await script(agent);
              yield* [];
            },
          }),
      };
    },
  };
});

import { runNativePersonalGeneration } from "../../src/agent/personal-runner.ts";
import { readPersonalRunLock } from "../../src/generation/personal-run-lock.ts";
import {
  readPersonalRunState,
  readSynthesisCursor,
} from "../../src/generation/personal-run-state.ts";
import type { ProtocolTool } from "../../src/integrations/core/protocol.ts";
import { PersonalSessionManager } from "../../src/integrations/personal/session-manager.ts";

const wikiDir = path.join(home, "wiki");
const model = {} as BaseChatModel;
const RAW_1 = "2026-10-07T06-00-00-000Z";
const SEED = `raw://google/${RAW_1}/gmail-messages.json#/messages/0`;

/**
 * Tool input, as a host sends it.
 */
type Input = Record<string, unknown>;

/**
 * The fields of personal tool results these tests read.
 */
interface ToolResult {
  [key: string]: unknown;
  runId: string;
  status: string;
  briefs: Record<string, string>;
  job: { id: string; path: string; pageVersion: string };
  version: string;
  bytes: number;
  ref: string;
}

let toolCallCount = 0;

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  harness.agents.length = 0;
  harness.scripts.clear();
  for (const entry of await readdir(home)) {
    await rm(path.join(home, entry), { recursive: true, force: true });
  }
  await mkdir(wikiDir, { recursive: true });
  await writeFile(
    path.join(home, "onboarding.json"),
    JSON.stringify({
      version: 1,
      sourceInstances: [
        {
          id: "google-1",
          connectorId: "google",
          name: "Gmail",
          connectedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    }),
  );
  const raw = path.join(home, "connectors", "google", "raw", RAW_1);
  await mkdir(raw, { recursive: true });
  await writeFile(
    path.join(raw, "gmail-messages.json"),
    JSON.stringify({ messages: [{ id: "m1", subject: "Q4 review" }] }),
  );
});

function pageMarkdown(title: string): string {
  return `---\ntype: Note\ntitle: ${title}\ndescription: ${title} summary.\n---\n\n# ${title}\n\n${title} body.\n`;
}

/**
 * Calls one native agent tool as the model would, and parses its result.
 */
async function callAgentTool(
  agent: FakeAgent,
  name: string,
  args: Input = {},
): Promise<ToolResult> {
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
  return JSON.parse(String(content)) as ToolResult;
}

async function writeAndSubmit(agent: FakeAgent): Promise<void> {
  const match = /^You own exactly (.+)\.$/mu.exec(agent.systemPrompt);
  if (!match) throw new Error(`${agent.name} owns no page.`);
  const result = await agent.backend.write(match[1], pageMarkdown(match[1]));
  if (result.error) throw new Error(result.error);
  await callAgentTool(agent, "submit_page");
}

function createHostSession(): {
  manager: PersonalSessionManager;
  call: (name: string, input?: Input) => Promise<ToolResult>;
} {
  const manager = PersonalSessionManager.create({ host: "claude" });
  const tools = new Map<string, ProtocolTool>(
    manager.tools().map((tool) => [tool.name, tool]),
  );
  return {
    manager,
    call: async (name, input = {}) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`No tool ${name}.`);
      return (await tool.handle(input)) as ToolResult;
    },
  };
}

describe("personal run hand-off between drivers (PHM-014)", () => {
  test("a run begun over MCP is resumed and finished by the native driver", async () => {
    const host = createHostSession();
    const begin = await host.call("openwiki_personal_begin", {
      mode: "update",
    });
    const runId = begin.runId;
    await host.call("openwiki_personal_submit_plan", {
      runId,
      pages: [
        {
          path: "/commitments.md",
          title: "Commitments",
          purpose: "Add the Q4 review.",
          seedEvidence: [SEED],
        },
      ],
    });
    const { job } = await host.call("openwiki_personal_next_page", { runId });
    await host.call("openwiki_personal_write_page", {
      runId,
      jobId: job.id,
      baseVersion: job.pageVersion,
      content: pageMarkdown("Commitments"),
    });
    await host.call("openwiki_personal_submit_page", { runId, jobId: job.id });

    // The host session ends with the run unfinished.
    await host.manager.close();
    expect(await readPersonalRunLock(wikiDir)).toBeNull();

    harness.scripts.set("worker", writeAndSubmit);
    const result = await runNativePersonalGeneration({
      mode: "update",
      modelId: "test-model",
      model,
    });

    expect(result.lastUpdateStatus).toBe("complete");
    expect(harness.agents.map(({ name }) => name)).not.toContain(
      "planning agent",
    );
    expect(harness.agents).toHaveLength(2);
    expect(await readPersonalRunState(wikiDir)).toBeNull();
    expect(await readPersonalRunLock(wikiDir)).toBeNull();
    expect(
      (await readSynthesisCursor(wikiDir)).connectors.google,
    ).toMatchObject({ synthesizedThrough: RAW_1, runId });
  });

  test("a run the native driver leaves unfinished is resumed and finished over MCP", async () => {
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
    const interrupted = await readPersonalRunState(wikiDir);
    expect(interrupted).toMatchObject({ phase: "planning" });
    expect(await readPersonalRunLock(wikiDir)).toBeNull();

    const host = createHostSession();
    const begin = await host.call("openwiki_personal_begin", {
      mode: "update",
    });
    expect(begin).toMatchObject({
      runId: interrupted?.runId,
      resumed: true,
      phase: "planning",
    });
    const runId = begin.runId;
    await host.call("openwiki_personal_submit_plan", { runId, pages: [] });
    for (;;) {
      const next = await host.call("openwiki_personal_next_page", { runId });
      if (next.status === "complete") break;
      await host.call("openwiki_personal_write_page", {
        runId,
        jobId: next.job.id,
        baseVersion: next.job.pageVersion,
        content: pageMarkdown(next.job.path),
      });
      await host.call("openwiki_personal_submit_page", {
        runId,
        jobId: next.job.id,
      });
    }

    await expect(
      host.call("openwiki_personal_finish", { runId }),
    ).resolves.toMatchObject({
      status: "complete",
      lastUpdateStatus: "complete",
      advancedConnectors: ["google"],
    });
    expect(await readPersonalRunState(wikiDir)).toBeNull();
    expect(await readPersonalRunLock(wikiDir)).toBeNull();
  });
});
