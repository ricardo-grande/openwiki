import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

const transport = vi.hoisted(() => ({
  starts: vi.fn(() => Promise.resolve()),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: unknown) => void;

    async start(): Promise<void> {
      await transport.starts();
    }

    async close(): Promise<void> {}

    async send(): Promise<void> {}
  },
}));

import {
  runOpenWikiMcp,
  runOpenWikiPersonalMcp,
} from "../../src/integrations/mcp/stdio.ts";
import { PersonalSessionManager } from "../../src/integrations/personal/session-manager.ts";

afterEach(() => {
  vi.restoreAllMocks();
  transport.starts.mockClear();
});

describe("OpenWiki MCP stdio entry point", () => {
  test("starts the transport without printing a banner", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runOpenWikiMcp({ host: "codex" });

    expect(transport.starts).toHaveBeenCalledOnce();
    expect(stdout).not.toHaveBeenCalled();
  });

  test("starts the personal transport without printing a banner", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runOpenWikiPersonalMcp({ host: "claude" }, new PassThrough());

    expect(transport.starts).toHaveBeenCalledOnce();
    expect(stdout).not.toHaveBeenCalled();
  });

  test("ends the personal session once when stdin closes", async () => {
    const close = vi
      .spyOn(PersonalSessionManager.prototype, "close")
      .mockResolvedValue();
    const stdin = new PassThrough();

    await runOpenWikiPersonalMcp({ host: "claude" }, stdin);
    expect(close).not.toHaveBeenCalled();

    stdin.end();
    stdin.resume();
    await new Promise((resolve) => stdin.once("close", resolve));

    expect(close).toHaveBeenCalledOnce();
  });
});
