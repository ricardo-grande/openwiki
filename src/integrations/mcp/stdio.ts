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
 * When the host session ends (stdin closes), the session releases the lock of
 * an unfinished run and keeps `.run.json`, so another driver can resume it.
 *
 * @param options - Host identifier used for run metadata.
 * @param stdin - Stream whose end marks the end of the host session.
 */
export async function runOpenWikiPersonalMcp(
  options: RunOpenWikiMcpOptions,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<void> {
  scopeOpenWikiEnvLoading([]);
  const manager = PersonalSessionManager.create(options);
  const server = createOpenWikiPersonalMcpServer(manager);
  let closing: Promise<void> | undefined;
  const endSession = () => {
    closing ??= manager.close().catch(() => {
      process.stderr.write("OpenWiki could not release the personal run.\n");
    });
  };
  stdin.once("end", endSession);
  stdin.once("close", endSession);
  await server.connect(new StdioServerTransport());
}
