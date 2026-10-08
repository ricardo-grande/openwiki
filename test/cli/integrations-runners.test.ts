import os from "node:os";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";

vi.mock("../../src/integrations/install/installer.ts", () => ({
  getHostIntegrationStatus: vi.fn(),
  installHostIntegration: vi.fn(),
  uninstallHostIntegration: vi.fn(),
}));
vi.mock("../../src/integrations/mcp/stdio.ts", () => ({
  runOpenWikiMcp: vi.fn(),
  runOpenWikiPersonalMcp: vi.fn(),
}));

import {
  getHostIntegrationStatus,
  installHostIntegration,
  uninstallHostIntegration,
} from "../../src/integrations/install/installer.ts";
import {
  runOpenWikiMcp,
  runOpenWikiPersonalMcp,
} from "../../src/integrations/mcp/stdio.ts";
import {
  runIntegrationsCommand,
  runMcpCommand,
} from "../../src/cli/integrations.ts";

let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;
let stdout: string[];
let stderr: string[];
let savedExitCode: typeof process.exitCode;

beforeEach(() => {
  vi.clearAllMocks();
  stdout = [];
  stderr = [];
  savedExitCode = process.exitCode;
  stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  process.exitCode = savedExitCode;
});

describe("runIntegrationsCommand", () => {
  test("lists every registry host and component with a stable tabular status", async () => {
    vi.mocked(getHostIntegrationStatus).mockResolvedValue("not-installed");
    vi.mocked(getHostIntegrationStatus)
      .mockResolvedValueOnce("installed")
      .mockResolvedValueOnce("not-installed")
      .mockResolvedValueOnce("modified")
      .mockResolvedValueOnce("installed");

    await runIntegrationsCommand({
      kind: "integrations",
      action: "list",
      exitCode: 0,
      target: null,
      scope: "user",
      projectRoot: null,
      force: false,
      component: "code",
    });

    expect(stdout.join("")).toBe(
      "bob\tcode\tinstalled\tIBM Bob\n" +
        "bob\tpersonal\tnot-installed\tIBM Bob\n" +
        "codex\tcode\tmodified\tCodex\n" +
        "codex\tpersonal\tinstalled\tCodex\n" +
        "claude\tcode\tnot-installed\tClaude Code\n" +
        "claude\tpersonal\tnot-installed\tClaude Code\n" +
        "opencode\tcode\tnot-installed\tOpenCode\n" +
        "opencode\tpersonal\tnot-installed\tOpenCode\n" +
        "cursor\tcode\tnot-installed\tCursor\n" +
        "cursor\tpersonal\tnot-installed\tCursor\n" +
        "kiro\tcode\tnot-installed\tKiro\n" +
        "kiro\tpersonal\tnot-installed\tKiro\n" +
        "omp\tcode\tnot-installed\tOh My Pi\n" +
        "omp\tpersonal\tnot-installed\tOh My Pi\n" +
        "antigravity\tcode\tnot-installed\tAntigravity CLI\n" +
        "antigravity\tpersonal\tnot-installed\tAntigravity CLI\n" +
        "copilot\tcode\tnot-installed\tGitHub Copilot CLI\n" +
        "copilot\tpersonal\tnot-installed\tGitHub Copilot CLI\n",
    );
    expect(getHostIntegrationStatus).toHaveBeenCalledTimes(18);
    expect(getHostIntegrationStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: "codex" }),
      { scope: "user", root: os.homedir(), component: "code" },
    );
    expect(getHostIntegrationStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: "codex" }),
      { scope: "user", root: os.homedir(), component: "personal" },
    );
    expect(process.exitCode).toBe(0);
    expect(stderr.join("")).toBe("");
  });

  test("installs with force and prints registry-derived next steps", async () => {
    vi.mocked(installHostIntegration).mockResolvedValue({
      target: "codex",
      scope: "project",
      skillDirectory: "/repo/.agents/skills/openwiki",
      mcpConfig: "/repo/.codex/config.toml",
      changed: true,
      component: "code",
    });

    await runIntegrationsCommand({
      kind: "integrations",
      action: "install",
      exitCode: 0,
      target: "codex",
      scope: "project",
      projectRoot: "/repo",
      force: true,
      component: "code",
    });

    expect(installHostIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ id: "codex", displayName: "Codex" }),
      { scope: "project", root: "/repo", force: true, component: "code" },
    );
    expect(stdout.join("")).toBe(
      "install Codex\n" +
        "skill: /repo/.agents/skills/openwiki\n" +
        "mcp: /repo/.codex/config.toml\n" +
        "\nOpenWiki is ready for Codex.\n\n" +
        "Next:\n" +
        "  1. Restart Codex in this repository.\n" +
        "  2. Confirm the openwiki MCP server is available.\n" +
        "  3. Ask: “Initialize OpenWiki for this repository.”\n",
    );
    expect(stdout.join("")).not.toMatch(/API key/iu);
    expect(process.exitCode).toBe(0);
  });

  test("prints retained backups and stable unchanged output", async () => {
    vi.mocked(installHostIntegration).mockResolvedValue({
      target: "claude",
      scope: "user",
      skillDirectory: "/repo/.claude/skills/openwiki",
      mcpConfig: "/repo/.mcp.json",
      changed: false,
      component: "code",
      backupPath: "/repo/.claude/skills/openwiki.backup",
    });

    await runIntegrationsCommand({
      kind: "integrations",
      action: "install",
      exitCode: 0,
      target: "claude",
      scope: "user",
      projectRoot: null,
      force: false,
      component: "code",
    });

    expect(installHostIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ id: "claude" }),
      { scope: "user", root: os.homedir(), force: false, component: "code" },
    );
    expect(stdout.join("")).toContain("unchanged Claude Code\n");
    expect(stdout.join("")).toContain(
      "backup: /repo/.claude/skills/openwiki.backup\n",
    );
    expect(stdout.join("")).toContain(
      "Restart Claude Code, then open any Git repository.",
    );
  });

  test("uninstalls without printing install next steps", async () => {
    vi.mocked(uninstallHostIntegration).mockResolvedValue({
      target: "claude",
      scope: "project",
      skillDirectory: "/repo/.claude/skills/openwiki",
      mcpConfig: "/repo/.mcp.json",
      changed: true,
      component: "code",
    });

    await runIntegrationsCommand({
      kind: "integrations",
      action: "uninstall",
      exitCode: 0,
      target: "claude",
      scope: "project",
      projectRoot: "/repo",
      force: false,
      component: "code",
    });

    expect(stdout.join("")).toContain("uninstall Claude Code\n");
    expect(stdout.join("")).not.toContain("Next:");
    expect(uninstallHostIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ id: "claude" }),
      { scope: "project", root: "/repo", component: "code" },
    );
  });

  test("installs the personal component with its own next steps", async () => {
    vi.mocked(installHostIntegration).mockResolvedValue({
      target: "claude",
      scope: "user",
      component: "personal",
      skillDirectory: "/home/.claude/skills/openwiki-personal",
      mcpConfig: "/home/.claude.json",
      changed: true,
    });

    await runIntegrationsCommand({
      kind: "integrations",
      action: "install",
      exitCode: 0,
      target: "claude",
      scope: "user",
      projectRoot: null,
      force: false,
      component: "personal",
    });

    expect(installHostIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ id: "claude" }),
      {
        scope: "user",
        root: os.homedir(),
        force: false,
        component: "personal",
      },
    );
    expect(stdout.join("")).toBe(
      "install Claude Code\n" +
        "skill: /home/.claude/skills/openwiki-personal\n" +
        "mcp: /home/.claude.json\n" +
        "\nOpenWiki personal is ready for Claude Code.\n\n" +
        "Next:\n" +
        "  1. Restart Claude Code.\n" +
        "  2. Confirm the openwiki-personal MCP server is available.\n",
    );
  });

  test("writes safe failures to stderr and sets exit code one", async () => {
    vi.mocked(installHostIntegration).mockRejectedValue(
      new Error("installation conflict"),
    );

    await runIntegrationsCommand({
      kind: "integrations",
      action: "install",
      exitCode: 0,
      target: "codex",
      scope: "project",
      projectRoot: "/repo",
      force: false,
      component: "code",
    });

    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toBe("installation conflict\n");
    expect(process.exitCode).toBe(1);
  });
});

describe("runMcpCommand", () => {
  test.each([
    ["claude", "claude-code"],
    ["opencode", "opencode"],
    ["antigravity", "antigravity"],
    ["custom-host", "custom-host"],
  ])(
    "starts a rootless %s MCP server with producer %s",
    async (host, actor) => {
      vi.mocked(runOpenWikiMcp).mockResolvedValue(undefined);

      await runMcpCommand({
        kind: "mcp",
        exitCode: 0,
        host,
        server: "code",
      });

      expect(runOpenWikiMcp).toHaveBeenCalledWith({
        host,
        producerActor: actor,
      });
      expect(runOpenWikiPersonalMcp).not.toHaveBeenCalled();
    },
  );

  test("starts the personal server for mcp personal", async () => {
    vi.mocked(runOpenWikiPersonalMcp).mockResolvedValue(undefined);

    await runMcpCommand({
      kind: "mcp",
      exitCode: 0,
      host: "claude",
      server: "personal",
    });

    expect(runOpenWikiPersonalMcp).toHaveBeenCalledWith({
      host: "claude",
      producerActor: "claude-code",
    });
    expect(runOpenWikiMcp).not.toHaveBeenCalled();
  });
});
