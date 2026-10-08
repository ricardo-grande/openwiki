import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MODEL_PROVIDER_ENV_KEYS } from "../../src/config/env.ts";

const CONNECTOR_KEYS = [
  "OPENWIKI_SLACK_USER_TOKEN",
  "OPENWIKI_GMAIL_REFRESH_TOKEN",
  "OPENWIKI_GMAIL_TOKEN_EXPIRES_AT",
  "OPENWIKI_GOOGLE_CLIENT_SECRET",
  "OPENWIKI_NOTION_MCP_CLIENT_ID",
  "TAVILY_API_KEY",
  "OPENWIKI_X_ACCESS_TOKEN",
  "CUSTOM_MCP_TOKEN",
  "CUSTOM_STDIO_KEY",
] as const;
const TOUCHED_KEYS = [
  ...MODEL_PROVIDER_ENV_KEYS,
  ...CONNECTOR_KEYS,
  "UNREFERENCED_KEY",
  "OPENWIKI_CONFIG_DIR",
];

let home: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  savedEnv = Object.fromEntries(
    TOUCHED_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of TOUCHED_KEYS) delete process.env[key];

  home = await mkdtemp(path.join(os.tmpdir(), "openwiki-personal-env-"));
  process.env.OPENWIKI_CONFIG_DIR = home;
  await writeFile(
    path.join(home, ".env"),
    [
      "OPENWIKI_PROVIDER=anthropic",
      "OPENWIKI_MODEL_ID=claude-opus-5-5",
      "ANTHROPIC_API_KEY=sk-ant-model-secret",
      "OPENAI_API_KEY=sk-openai-model-secret",
      ...CONNECTOR_KEYS.map((key) => `${key}=${key.toLowerCase()}-value`),
      "UNREFERENCED_KEY=unreferenced",
      "",
    ].join("\n"),
    "utf8",
  );
  const customMcp = path.join(home, "connectors", "custom-mcp");
  await mkdir(customMcp, { recursive: true });
  await writeFile(
    path.join(customMcp, "config.json"),
    JSON.stringify({
      enabled: true,
      transport: {
        type: "stdio",
        command: "server",
        headers: { Authorization: "Bearer ${CUSTOM_MCP_TOKEN}" },
        env: { STDIO_KEY: "CUSTOM_STDIO_KEY", LEAK: "${OPENAI_API_KEY}" },
      },
    }),
    "utf8",
  );
  vi.resetModules();
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  await rm(home, { force: true, recursive: true });
});

describe("scoped connector environment (PHM-003)", () => {
  test("loads connector keys and never a model-provider key", async () => {
    process.env.OPENWIKI_X_ACCESS_TOKEN = "from-host";
    const { loadScopedConnectorEnv } =
      await import("../../src/integrations/personal/connector-env.ts");
    const { loadOpenWikiEnv } = await import("../../src/config/env.ts");

    await loadScopedConnectorEnv();
    // A later load, such as the one inside an OAuth token refresh, stays scoped.
    await loadOpenWikiEnv();

    for (const key of MODEL_PROVIDER_ENV_KEYS) {
      expect(process.env[key], key).toBeUndefined();
    }
    expect(process.env.UNREFERENCED_KEY).toBeUndefined();
    expect(process.env.OPENWIKI_X_ACCESS_TOKEN).toBe("from-host");
    for (const key of CONNECTOR_KEYS) {
      if (key === "OPENWIKI_X_ACCESS_TOKEN") continue;
      expect(process.env[key], key).toBe(`${key.toLowerCase()}-value`);
    }
  });

  test("an empty scope loads nothing until the connector keys are loaded", async () => {
    const { loadOpenWikiEnv, scopeOpenWikiEnvLoading } =
      await import("../../src/config/env.ts");

    scopeOpenWikiEnvLoading([]);
    await loadOpenWikiEnv();

    for (const key of TOUCHED_KEYS) {
      if (key === "OPENWIKI_CONFIG_DIR") continue;
      expect(process.env[key], key).toBeUndefined();
    }
  });

  test("lists transport references, including bare stdio env names", async () => {
    const { resolveScopedConnectorEnvKeys } =
      await import("../../src/integrations/personal/connector-env.ts");

    const keys = await resolveScopedConnectorEnvKeys();

    expect(keys).toContain("CUSTOM_MCP_TOKEN");
    expect(keys).toContain("CUSTOM_STDIO_KEY");
    expect(keys).toContain("OPENWIKI_NOTION_MCP_ACCESS_TOKEN");
    expect(keys).toContain("OPENWIKI_X_CLIENT_ID");
    expect(keys).not.toContain("LANGSMITH_API_KEY");
  });
});
