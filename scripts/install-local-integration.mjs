import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { installHostIntegration } from "../dist/integrations/install/installer.js";
import {
  getHostTarget,
  HOST_INTEGRATION_COMPONENTS,
} from "../dist/integrations/install/registry.js";
import { getErrorMessage } from "../dist/platform/diagnostics.js";

/**
 * Installs one host integration backed by this source checkout.
 *
 * @returns {Promise<void>} Completion after the skill and MCP config are installed.
 */
async function main() {
  const [hostId, ...options] = process.argv.slice(2);
  const target = hostId ? getHostTarget(hostId) : undefined;
  const personal = options.length === 1 && options[0] === "--personal";
  if (!target || (options.length > 0 && !personal)) {
    throw new Error(
      "Usage: pnpm integrations:dev <bob|codex|claude|opencode|cursor|kiro|omp|antigravity|copilot> [--personal]",
    );
  }
  if (personal && !target.user) {
    throw new Error(
      `${target.displayName} has no user scope; the personal integration is user-scoped only.`,
    );
  }
  const component = personal ? "personal" : "code";

  const repositoryRoot = await realpath(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const mcpServerCommand = {
    command: await realpath(process.execPath),
    args: [
      await realpath(path.join(repositoryRoot, "dist", "cli", "cli.js")),
      ...HOST_INTEGRATION_COMPONENTS[component].serverArgs,
      "--host",
      target.id,
    ],
  };
  const result = await installHostIntegration(target, {
    scope: target.user ? "user" : "project",
    root: target.user ? os.homedir() : repositoryRoot,
    mcpServerCommand,
    component,
  });

  process.stdout.write(
    `${result.changed ? "installed" : "unchanged"} ${target.displayName} local development integration\n` +
      `skill: ${result.skillDirectory}\n` +
      `mcp: ${result.mcpConfig}\n` +
      `server: ${mcpServerCommand.command} ${mcpServerCommand.args.join(" ")}\n` +
      `\nRestart ${target.displayName}${target.user ? "" : " in this repository"} to use this checkout.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${getErrorMessage(error)}\n`);
  process.exitCode = 1;
});
