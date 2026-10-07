import { createFilesystemMiddleware } from "deepagents";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createModel } from "../../src/agent/index.ts";
import { createOpenWikiConnectorTools } from "../../src/connectors/tools.ts";

// Gemini's function-declaration API rejects JSON Schema keywords outside its
// own subset with a 400 before the model runs. DeepAgents' grep tool declares
// `max_count` as a positive integer, which serializes to `exclusiveMinimum`, so
// every Gemini run with filesystem tools failed until @langchain/google began
// sanitizing tool schemas to Gemini's allowlist. These tests send OpenWiki's
// real personal-mode tool set through the real ChatGoogle client with fetch
// stubbed, and inspect the request it would have sent.

/** JSON Schema keywords Gemini's function declarations reject. */
const UNSUPPORTED_KEYWORDS = [
  "exclusiveMinimum",
  "exclusiveMaximum",
  "additionalProperties",
  "$schema",
  "$ref",
];

/** Every key used anywhere in a parsed JSON value. */
function keysIn(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => keysIn(item, keys));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      keysIn(child, keys);
    }
  }
  return keys;
}

describe("Gemini tool schemas", () => {
  const savedKey = process.env.GEMINI_API_KEY;
  let requests: Array<Record<string, unknown>>;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    requests = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const body =
          input instanceof Request
            ? await input.clone().text()
            : typeof init?.body === "string"
              ? init.body
              : "{}";
        requests.push(JSON.parse(body) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: { role: "model", parts: [{ text: "ok" }] },
                finishReason: "STOP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = savedKey;
    }
  });

  test("personal-mode tools reach Gemini without unsupported schema keywords", async () => {
    const filesystem = createFilesystemMiddleware({
      tools: ["ls", "read_file", "glob", "grep", "write_file", "edit_file"],
    });
    const tools = [
      ...(filesystem.tools ?? []),
      ...createOpenWikiConnectorTools("local-wiki"),
    ];
    const model = createModel("gemini", "gemini-test-model", 0);

    if (model.bindTools === undefined) {
      throw new Error("ChatGoogle must support tool binding.");
    }
    await model.bindTools(tools).invoke("hi");

    expect(requests).toHaveLength(1);
    const declarations = (
      requests[0].tools as Array<{
        functionDeclarations?: Array<{ name: string }>;
      }>
    ).flatMap((tool) => tool.functionDeclarations ?? []);
    expect(declarations.map((declaration) => declaration.name)).toContain(
      "grep",
    );
    const used = keysIn(requests[0].tools);
    expect(UNSUPPORTED_KEYWORDS.filter((keyword) => used.has(keyword))).toEqual(
      [],
    );
  });
});
