import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  createDeepAgent: vi.fn(),
  resolveTranslationPlan: vi.fn(),
  runNativePersonalGeneration: vi.fn(),
  runNativeRepositoryGeneration: vi.fn(),
}));

vi.mock("deepagents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("deepagents")>()),
  createDeepAgent: harness.createDeepAgent,
}));

vi.mock("../../src/agent/repository-runner.js", () => ({
  runNativeRepositoryGeneration: harness.runNativeRepositoryGeneration,
}));

vi.mock("../../src/agent/personal-runner.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/agent/personal-runner.js")
  >()),
  runNativePersonalGeneration: harness.runNativePersonalGeneration,
}));

vi.mock("../../src/agent/translation-middleware.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/agent/translation-middleware.js")
    >();
  harness.resolveTranslationPlan.mockImplementation(
    actual.resolveTranslationPlan,
  );
  return { ...actual, resolveTranslationPlan: harness.resolveTranslationPlan };
});

vi.mock("../../src/agent/skills.js", () => ({
  syncBundledSkills: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/config/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/env.js")>()),
  loadOpenWikiEnv: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/setup/onboarding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/setup/onboarding.js")>()),
  readOpenWikiOnboardingConfig: vi.fn(() =>
    Promise.resolve({ sourceInstances: [], sources: {}, version: 1 }),
  ),
  readRepositoryWikiInstructions: vi.fn(() => Promise.resolve(undefined)),
}));

import { runOpenWikiAgent } from "../../src/agent/index.ts";
import {
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
} from "../../src/config/constants.ts";

const temporaryDirectories: string[] = [];
const originalProvider = process.env[OPENWIKI_PROVIDER_ENV_KEY];
const originalApiKey = process.env[OPENROUTER_API_KEY_ENV_KEY];
const originalPersonalCore = process.env.OPENWIKI_PERSONAL_CORE;

/**
 * Creates an empty async stream accepted by the shared graph runner.
 *
 * @returns Stream containing no model-facing output.
 */
function createEmptyAgentStream(): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield* [];
    },
  };
}

beforeEach(() => {
  process.env[OPENWIKI_PROVIDER_ENV_KEY] = "openrouter";
  process.env[OPENROUTER_API_KEY_ENV_KEY] = "test-key";
  delete process.env.OPENWIKI_PERSONAL_CORE;
  harness.createDeepAgent.mockReset();
  harness.resolveTranslationPlan.mockClear();
  harness.runNativePersonalGeneration.mockReset();
  harness.runNativePersonalGeneration.mockResolvedValue({ skipped: false });
  harness.runNativeRepositoryGeneration.mockReset();
  harness.runNativeRepositoryGeneration.mockResolvedValue({ skipped: false });
  harness.createDeepAgent.mockReturnValue({
    stream: vi.fn(() => Promise.resolve(createEmptyAgentStream())),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalProvider === undefined) {
    delete process.env[OPENWIKI_PROVIDER_ENV_KEY];
  } else {
    process.env[OPENWIKI_PROVIDER_ENV_KEY] = originalProvider;
  }
  if (originalPersonalCore === undefined) {
    delete process.env.OPENWIKI_PERSONAL_CORE;
  } else {
    process.env.OPENWIKI_PERSONAL_CORE = originalPersonalCore;
  }
  if (originalApiKey === undefined) {
    delete process.env[OPENROUTER_API_KEY_ENV_KEY];
  } else {
    process.env[OPENROUTER_API_KEY_ENV_KEY] = originalApiKey;
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("runOpenWikiAgent repository routing", () => {
  test("routes repository init and update only through the page-job runner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-routing-"));
    temporaryDirectories.push(root);

    for (const command of ["init", "update"] as const) {
      const result = await runOpenWikiAgent(command, root, {
        outputMode: "repository",
        userMessage: "Honor the repository-specific documentation scope.",
      });
      expect(result.command).toBe(command);
      expect(typeof result.model).toBe("string");
    }

    expect(harness.runNativeRepositoryGeneration).toHaveBeenCalledTimes(2);
    expect(harness.runNativeRepositoryGeneration).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        root,
        mode: "init",
        force: true,
        planningContext: "Honor the repository-specific documentation scope.",
      }),
    );
    expect(harness.runNativeRepositoryGeneration).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ root, mode: "update" }),
    );
    expect(harness.createDeepAgent).not.toHaveBeenCalled();
  });

  test("retains personal init on the shared graph path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-routing-"));
    temporaryDirectories.push(root);

    const result = await runOpenWikiAgent("init", root, {
      outputMode: "local-wiki",
    });
    expect(result.command).toBe("init");
    expect(typeof result.model).toBe("string");

    expect(harness.runNativeRepositoryGeneration).not.toHaveBeenCalled();
    expect(harness.runNativePersonalGeneration).not.toHaveBeenCalled();
    expect(harness.resolveTranslationPlan).toHaveBeenCalled();
    expect(harness.createDeepAgent).toHaveBeenCalledTimes(1);
  });
});

describe("runOpenWikiAgent personal core opt-in", () => {
  test("routes personal init and update through the native personal driver, with no translation pass (PLC-015)", async () => {
    process.env.OPENWIKI_PERSONAL_CORE = "1";
    harness.runNativePersonalGeneration
      .mockResolvedValueOnce({ skipped: false, lastUpdateStatus: "complete" })
      .mockResolvedValueOnce({ skipped: true });
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-routing-"));
    temporaryDirectories.push(root);

    const init = await runOpenWikiAgent("init", root, {
      outputMode: "local-wiki",
      language: "fr",
      userMessage: "Track the Q4 review.",
    });
    const update = await runOpenWikiAgent("update", root, {
      outputMode: "local-wiki",
    });

    expect(init.skipped).toBeUndefined();
    expect(update.skipped).toBe(true);
    expect(harness.runNativePersonalGeneration).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        mode: "init",
        language: "fr",
        instruction: "Track the Q4 review.",
      }),
    );
    expect(harness.runNativePersonalGeneration).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mode: "update" }),
    );
    expect(harness.resolveTranslationPlan).not.toHaveBeenCalled();
    expect(harness.createDeepAgent).not.toHaveBeenCalled();
    expect(harness.runNativeRepositoryGeneration).not.toHaveBeenCalled();
  });

  test("passes an ingest's connector scope and the takeover confirmation to the driver", async () => {
    process.env.OPENWIKI_PERSONAL_CORE = "1";
    harness.runNativePersonalGeneration.mockResolvedValueOnce({
      skipped: false,
      lastUpdateStatus: "interrupted",
    });
    const confirmPersonalTakeover = vi.fn(() => Promise.resolve(false));
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-routing-"));
    temporaryDirectories.push(root);

    const result = await runOpenWikiAgent("update", root, {
      outputMode: "local-wiki",
      personalScope: { connectors: ["google", "slack"] },
      confirmPersonalTakeover,
    });

    expect(result.lastUpdateStatus).toBe("interrupted");
    expect(harness.runNativePersonalGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "update",
        scope: { connectors: ["google", "slack"] },
        confirmTakeover: confirmPersonalTakeover,
      }),
    );
  });

  test("makes personal chat read-only, with a one-page edit run for edit requests", async () => {
    process.env.OPENWIKI_PERSONAL_CORE = "1";
    harness.runNativePersonalGeneration.mockResolvedValueOnce({
      skipped: false,
      lastUpdateStatus: "complete",
    });
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-routing-"));
    temporaryDirectories.push(root);

    await runOpenWikiAgent("chat", root, {
      outputMode: "local-wiki",
      isFollowup: true,
      userMessage: "Mark the Q4 review commitment as done.",
    });

    expect(harness.createDeepAgent).toHaveBeenCalledTimes(1);
    const params = harness.createDeepAgent.mock.calls[0]?.[0] as {
      tools: { name: string; invoke: (input: unknown) => Promise<unknown> }[];
      systemPrompt: string;
    };
    expect(params.tools.map(({ name }) => name).sort()).toEqual([
      "openwiki_edit_page",
      "openwiki_list_connectors",
      "openwiki_list_raw_items",
      "openwiki_read_raw_item",
    ]);
    expect(params.systemPrompt).toContain("This chat is read-only.");
    expect(harness.runNativePersonalGeneration).not.toHaveBeenCalled();

    const editPage = params.tools.find(
      ({ name }) => name === "openwiki_edit_page",
    );
    const output = await editPage?.invoke({
      path: "/commitments.md",
      request: "Mark the Q4 review commitment as done.",
    });

    expect(JSON.parse(String(output))).toEqual({ status: "complete" });
    expect(harness.runNativePersonalGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "update",
        instruction: "Mark the Q4 review commitment as done.",
        scope: { connectors: [], pages: ["/commitments.md"] },
      }),
    );
  });

  test("rejects a chat edit of a non-canonical path without starting a run", async () => {
    process.env.OPENWIKI_PERSONAL_CORE = "1";
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-routing-"));
    temporaryDirectories.push(root);

    await runOpenWikiAgent("chat", root, { outputMode: "local-wiki" });
    const params = harness.createDeepAgent.mock.calls[0]?.[0] as {
      tools: { name: string; invoke: (input: unknown) => Promise<unknown> }[];
    };
    const output = await params.tools
      .find(({ name }) => name === "openwiki_edit_page")
      ?.invoke({ path: "/.run.json", request: "Reset the run." });

    expect(JSON.parse(String(output))).toMatchObject({ status: "rejected" });
    expect(harness.runNativePersonalGeneration).not.toHaveBeenCalled();
  });

  test("keeps the legacy chat, with its ingest tools, without the opt-in", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-routing-"));
    temporaryDirectories.push(root);

    await runOpenWikiAgent("chat", root, { outputMode: "local-wiki" });

    const params = harness.createDeepAgent.mock.calls[0]?.[0] as {
      tools: { name: string }[];
    };
    expect(params.tools.map(({ name }) => name)).toContain(
      "openwiki_ingest_connector",
    );
    expect(
      params.tools.map(({ name }) => name).includes("openwiki_edit_page"),
    ).toBe(false);
  });

  test.each(["0", "true", ""])(
    "ignores OPENWIKI_PERSONAL_CORE=%j",
    async (value) => {
      process.env.OPENWIKI_PERSONAL_CORE = value;
      const root = await mkdtemp(path.join(tmpdir(), "openwiki-routing-"));
      temporaryDirectories.push(root);

      await runOpenWikiAgent("init", root, { outputMode: "local-wiki" });

      expect(harness.runNativePersonalGeneration).not.toHaveBeenCalled();
      expect(harness.createDeepAgent).toHaveBeenCalledTimes(1);
    },
  );
});
