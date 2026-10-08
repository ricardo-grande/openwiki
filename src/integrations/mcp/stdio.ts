import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { scopeOpenWikiEnvLoading } from "../../config/env.js";
import { HostSessionManager } from "../core/session-manager.js";
import { PersonalSessionManager } from "../personal/session-manager.js";
import {
  createOpenWikiMcpServer,
  createOpenWikiPersonalMcpServer,
} from "./server.js";

/**
 * Inputs required to start the rootless MCP process.
 */
export interface RunOpenWikiMcpOptions {
  /**
   * Stable host identifier written to run metadata.
   */
  host: string;

  /**
   * Stable OKF producer actor for host-authored page bodies.
   *
   * @default host
   */
  producerActor?: string;
}

/**
 * Starts OpenWiki's local stdio MCP server without writing to stdout.
 *
 * @param options - Host identifier used for run metadata.
 */
export async function runOpenWikiMcp(
  options: RunOpenWikiMcpOptions,
): Promise<void> {
  const manager = HostSessionManager.create(options);
  const server = createOpenWikiMcpServer(manager);
  await server.connect(new StdioServerTransport());
}

/**
 * Starts the personal stdio MCP server without writing to stdout. Until a
 * fetching tool loads the scoped connector environment, no `.env` key loads.
 *
 * @param options - Host identifier used for run metadata.
 */
export async function runOpenWikiPersonalMcp(
  options: RunOpenWikiMcpOptions,
): Promise<void> {
  scopeOpenWikiEnvLoading([]);
  const manager = PersonalSessionManager.create(options);
  const server = createOpenWikiPersonalMcpServer(manager);
  await server.connect(new StdioServerTransport());
}
