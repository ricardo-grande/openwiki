import os from "node:os";
import {
  getHostIntegrationStatus,
  installHostIntegration,
  uninstallHostIntegration,
} from "../integrations/install/installer.js";
import {
  getHostTarget,
  HOST_INTEGRATION_COMPONENTS,
  listHostIntegrationComponents,
  listHostTargets,
} from "../integrations/install/registry.js";
import {
  runOpenWikiMcp,
  runOpenWikiPersonalMcp,
} from "../integrations/mcp/stdio.js";
import { getErrorMessage } from "../platform/diagnostics.js";
import type { CliCommand } from "./commands.js";

/**
 * Executes a registry-driven integration list, install, or uninstall command.
 * List reports one row per host and component.
 *
 * @param command - Parsed integration command.
 */
export async function runIntegrationsCommand(
  command: Extract<CliCommand, { kind: "integrations" }>,
): Promise<void> {
  try {
    const root =
      command.scope === "user" ? os.homedir() : (command.projectRoot ?? ".");
    if (command.action === "list") {
      const components = listHostIntegrationComponents();
      const rows = await Promise.all(
        listHostTargets().flatMap((target) =>
          components.map(async (component) => {
            const status = await getHostIntegrationStatus(target, {
              scope: command.scope,
              root,
              component: component.id,
            });
            return `${target.id}\t${component.id}\t${status}\t${target.displayName}`;
          }),
        ),
      );
      process.stdout.write(`${rows.join("\n")}\n`);
      process.exitCode = 0;
      return;
    }

    const target = command.target ? getHostTarget(command.target) : undefined;
    if (!target) throw new Error("Integration target is required.");
    const component = command.component;
    const result =
      command.action === "install"
        ? await installHostIntegration(target, {
            scope: command.scope,
            root,
            force: command.force,
            component,
          })
        : await uninstallHostIntegration(target, {
            scope: command.scope,
            root,
            component,
          });

    process.stdout.write(
      `${result.changed ? command.action : "unchanged"} ${target.displayName}\n` +
        `skill: ${result.skillDirectory}\n` +
        `mcp: ${result.mcpConfig}\n` +
        (result.backupPath ? `backup: ${result.backupPath}\n` : ""),
    );

    if (command.action === "install" && component === "personal") {
      process.stdout.write(
        `\nOpenWiki personal is ready for ${target.displayName}.\n\n` +
          "Next:\n" +
          `  1. Restart ${target.displayName}.\n` +
          `  2. Confirm the ${HOST_INTEGRATION_COMPONENTS.personal.serverName} MCP server is available.\n`,
      );
    } else if (command.action === "install") {
      const restartGuidance =
        command.scope === "user"
          ? `Restart ${target.displayName}, then open any Git repository.`
          : `Restart ${target.displayName} in this repository.`;
      process.stdout.write(
        `\nOpenWiki is ready for ${target.displayName}.\n\n` +
          "Next:\n" +
          `  1. ${restartGuidance}\n` +
          "  2. Confirm the openwiki MCP server is available.\n" +
          "  3. Ask: “Initialize OpenWiki for this repository.”\n",
      );
    }
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Starts the local stdio MCP server for a parsed CLI command: the repository
 * server, or the personal server for `openwiki mcp personal`.
 *
 * @param command - Parsed MCP server command.
 */
export async function runMcpCommand(
  command: Extract<CliCommand, { kind: "mcp" }>,
): Promise<void> {
  const target = getHostTarget(command.host);
  const options = {
    host: command.host,
    producerActor: target?.producerActor ?? command.host,
  };
  if (command.server === "personal") {
    await runOpenWikiPersonalMcp(options);
  } else {
    await runOpenWikiMcp(options);
  }
}
