import type {
  HostIntegrationComponent,
  HostIntegrationComponentDefinition,
  HostMcpServerCommand,
  HostTarget,
  HostTargetId,
} from "./types.js";

/**
 * The separately installed components. The personal wiki belongs to the user,
 * so the personal component is user-scoped only (host §3.1).
 */
export const HOST_INTEGRATION_COMPONENTS = {
  code: {
    id: "code",
    skillName: "openwiki",
    serverName: "openwiki",
    serverArgs: ["mcp"],
    scopes: ["user", "project"],
  },
  personal: {
    id: "personal",
    skillName: "openwiki-personal",
    serverName: "openwiki-personal",
    serverArgs: ["mcp", "personal"],
    scopes: ["user"],
  },
} as const satisfies Record<
  HostIntegrationComponent,
  HostIntegrationComponentDefinition
>;

/**
 * Complete immutable registry of supported host installation targets.
 */
export const HOST_TARGETS = {
  bob: {
    id: "bob",
    displayName: "IBM Bob",
    producerActor: "bob",
    user: {
      skillsRoot: ".agents/skills",
      mcpConfig: { kind: "json", relativePath: ".bob/settings/mcp.json" },
    },
    project: {
      skillsRoot: ".agents/skills",
      mcpConfig: { kind: "json", relativePath: ".bob/mcp.json" },
    },
    documentationUrl:
      "https://bob.ibm.com/docs/ide/configuration/mcp/understanding-mcp",
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    producerActor: "codex",
    user: {
      skillsRoot: ".agents/skills",
      mcpConfig: {
        kind: "codex-toml",
        relativePath: ".codex/config.toml",
      },
    },
    project: {
      skillsRoot: ".agents/skills",
      mcpConfig: {
        kind: "codex-toml",
        relativePath: ".codex/config.toml",
      },
    },
    documentationUrl: "https://learn.chatgpt.com/docs/extend/mcp",
  },
  claude: {
    id: "claude",
    displayName: "Claude Code",
    producerActor: "claude-code",
    user: {
      skillsRoot: ".claude/skills",
      mcpConfig: { kind: "json", relativePath: ".claude.json" },
    },
    project: {
      skillsRoot: ".claude/skills",
      mcpConfig: { kind: "json", relativePath: ".mcp.json" },
    },
    documentationUrl: "https://docs.anthropic.com/en/docs/claude-code/mcp",
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    producerActor: "opencode",
    user: {
      skillsRoot: ".config/opencode/skills",
      mcpConfig: {
        kind: "opencode-json",
        relativePath: ".config/opencode/opencode.jsonc",
      },
    },
    project: {
      skillsRoot: ".opencode/skills",
      mcpConfig: {
        kind: "opencode-json",
        relativePath: "opencode.jsonc",
      },
    },
    documentationUrl: "https://opencode.ai/docs/mcp-servers/",
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor",
    producerActor: "cursor",
    user: {
      skillsRoot: ".cursor/skills",
      mcpConfig: { kind: "json", relativePath: ".cursor/mcp.json" },
    },
    project: {
      skillsRoot: ".cursor/skills",
      mcpConfig: { kind: "json", relativePath: ".cursor/mcp.json" },
    },
    documentationUrl: "https://cursor.com/docs/mcp",
  },
  kiro: {
    id: "kiro",
    displayName: "Kiro",
    producerActor: "kiro",
    user: {
      skillsRoot: ".kiro/skills",
      mcpConfig: { kind: "json", relativePath: ".kiro/settings/mcp.json" },
    },
    project: {
      skillsRoot: ".kiro/skills",
      mcpConfig: { kind: "json", relativePath: ".kiro/settings/mcp.json" },
    },
    documentationUrl: "https://kiro.dev/docs/mcp/configuration/",
  },
  omp: {
    id: "omp",
    displayName: "Oh My Pi",
    producerActor: "omp",
    // User scope targets omp's default agent dir (~/.omp/agent). Named profiles
    // and PI_CODING_AGENT_DIR overrides use another directory; use --project
    // for those setups.
    user: {
      skillsRoot: ".omp/agent/skills",
      mcpConfig: { kind: "json", relativePath: ".omp/agent/mcp.json" },
    },
    project: {
      skillsRoot: ".omp/skills",
      mcpConfig: { kind: "json", relativePath: ".omp/mcp.json" },
    },
    documentationUrl: "https://omp.sh",
  },
  antigravity: {
    id: "antigravity",
    displayName: "Antigravity CLI",
    producerActor: "antigravity",
    user: {
      skillsRoot: ".gemini/antigravity-cli/skills",
      mcpConfig: {
        kind: "json",
        relativePath: ".gemini/config/mcp_config.json",
      },
    },
    project: {
      skillsRoot: ".agents/skills",
      mcpConfig: { kind: "json", relativePath: ".agents/mcp_config.json" },
    },
    documentationUrl: "https://antigravity.google/docs/mcp?tab=cli",
  },
  copilot: {
    id: "copilot",
    displayName: "GitHub Copilot CLI",
    producerActor: "copilot",
    user: {
      skillsRoot: ".copilot/skills",
      mcpConfig: { kind: "json", relativePath: ".copilot/mcp-config.json" },
    },
    project: {
      skillsRoot: ".github/skills",
      mcpConfig: { kind: "json", relativePath: ".github/mcp.json" },
    },
    documentationUrl:
      "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers",
  },
} as const satisfies Record<HostTargetId, HostTarget>;

/**
 * Resolves a host registry entry from untrusted CLI text.
 *
 * @param id - Candidate host identifier.
 * @returns Matching host target, or `undefined` when unsupported.
 */
export function getHostTarget(id: string): HostTarget | undefined {
  return HOST_TARGETS[id as HostTargetId];
}

/**
 * Lists supported host targets in registry order.
 *
 * @returns Independent array of host registry entries.
 */
export function listHostTargets(): HostTarget[] {
  return Object.values(HOST_TARGETS);
}

/**
 * Lists the installable components in a stable order.
 *
 * @returns Independent array of component definitions.
 */
export function listHostIntegrationComponents(): HostIntegrationComponentDefinition[] {
  return Object.values(HOST_INTEGRATION_COMPONENTS);
}

/**
 * Creates the default managed MCP command for one host and component.
 *
 * @param target - Stable host identifier passed to the MCP process.
 * @param component - Component whose server the command starts.
 * @returns Portable executable invocation used by published installations.
 */
export function defaultMcpServerCommand(
  target: HostTargetId,
  component: HostIntegrationComponent = "code",
): HostMcpServerCommand {
  return {
    command: "openwiki",
    args: [
      ...HOST_INTEGRATION_COMPONENTS[component].serverArgs,
      "--host",
      target,
    ],
  };
}
