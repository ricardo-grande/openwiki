import { readFile } from "node:fs/promises";
import { HostIntegrationError } from "../core/errors.js";
import { writeTextAtomic } from "./atomic-file.js";
import type { HostIntegrationStatus, HostMcpServerCommand } from "./types.js";

/**
 * Marker pair that delimits one server's managed block.
 */
interface BlockMarkers {
  /**
   * Line that opens the managed block.
   */
  start: string;

  /**
   * Line that closes the managed block.
   */
  end: string;
}

/**
 * Derives the marker pair for one server, for example `# OPENWIKI:MCP:START`
 * for `openwiki` and `# OPENWIKI-PERSONAL:MCP:START` for `openwiki-personal`.
 *
 * @param serverName - `mcp_servers` table key that owns the block.
 * @returns The server's marker pair.
 */
function markersFor(serverName: string): BlockMarkers {
  const prefix = `# ${serverName.toUpperCase()}:MCP`;
  return { start: `${prefix}:START`, end: `${prefix}:END` };
}

/**
 * Byte range occupied by one complete managed TOML block.
 */
interface MarkerRange {
  /**
   * Inclusive block start offset.
   */
  start: number;

  /**
   * Exclusive block end offset.
   */
  end: number;
}

/**
 * Installs an exact managed OpenWiki TOML block.
 *
 * @param filePath - Absolute Codex TOML config path.
 * @param entry - Exact executable invocation to install.
 * @param replaceableEntry - Exact prior invocation that may be replaced.
 * @param serverName - `mcp_servers` table key that owns the block.
 * @returns Whether the config changed.
 */
export async function installCodexMcpBlock(
  filePath: string,
  entry: HostMcpServerCommand,
  replaceableEntry?: HostMcpServerCommand,
  serverName = "openwiki",
): Promise<boolean> {
  const current = await readOptional(filePath);
  const block = renderBlock(entry, serverName);
  const range = markerRange(current, serverName);
  if (range) {
    const existing = current.slice(range.start, range.end);
    if (hasUnmanagedOpenWikiTable(current, serverName, range)) {
      throw new HostIntegrationError(
        "conflict",
        `Refusing to replace a modified OpenWiki MCP block in ${filePath}.`,
      );
    }
    if (existing === block) return false;
    if (
      !replaceableEntry ||
      existing !== renderBlock(replaceableEntry, serverName)
    ) {
      throw new HostIntegrationError(
        "conflict",
        `Refusing to replace a modified OpenWiki MCP block in ${filePath}.`,
      );
    }
    await writeTextAtomic(
      filePath,
      `${current.slice(0, range.start)}${block}${current.slice(range.end)}`,
    );
    return true;
  }
  if (hasUnmanagedOpenWikiTable(current, serverName)) {
    throw new HostIntegrationError(
      "conflict",
      `An unmanaged ${serverName} MCP table already exists in ${filePath}.`,
    );
  }

  const separator =
    current.length === 0 || current.endsWith("\n\n") ? "" : "\n";
  await writeTextAtomic(filePath, `${current}${separator}${block}`);
  return true;
}

/**
 * Removes only the exact managed OpenWiki TOML block.
 *
 * @param filePath - Absolute Codex TOML config path.
 * @param entry - Exact executable invocation owned by OpenWiki.
 * @param serverName - `mcp_servers` table key that owns the block.
 * @returns Whether the config changed.
 */
export async function uninstallCodexMcpBlock(
  filePath: string,
  entry: HostMcpServerCommand,
  serverName = "openwiki",
): Promise<boolean> {
  const current = await readOptional(filePath);
  const range = markerRange(current, serverName);
  if (!range) return false;
  if (
    current.slice(range.start, range.end) !== renderBlock(entry, serverName) ||
    hasUnmanagedOpenWikiTable(current, serverName, range)
  ) {
    throw new HostIntegrationError(
      "conflict",
      `Refusing to remove a modified OpenWiki MCP block from ${filePath}.`,
    );
  }

  await writeTextAtomic(
    filePath,
    `${current.slice(0, range.start)}${current.slice(range.end)}`,
  );
  return true;
}

/**
 * Reports whether the exact managed Codex block is absent, intact, or modified.
 *
 * @param filePath - Absolute Codex TOML config path.
 * @param entry - Exact executable invocation expected in the managed block.
 * @param serverName - `mcp_servers` table key that owns the block.
 * @returns Current managed-block state.
 */
export async function getCodexMcpBlockStatus(
  filePath: string,
  entry: HostMcpServerCommand,
  serverName = "openwiki",
): Promise<HostIntegrationStatus> {
  try {
    const current = await readOptional(filePath);
    const range = markerRange(current, serverName);
    if (!range) {
      return hasUnmanagedOpenWikiTable(current, serverName)
        ? "modified"
        : "not-installed";
    }
    return current.slice(range.start, range.end) ===
      renderBlock(entry, serverName) &&
      !hasUnmanagedOpenWikiTable(current, serverName, range)
      ? "installed"
      : "modified";
  } catch {
    return "modified";
  }
}

/**
 * Detects an OpenWiki MCP table outside the one managed marker range.
 *
 * @param content - Complete TOML config content.
 * @param serverName - `mcp_servers` table key that owns the block.
 * @param managed - Expected managed block range, when present.
 * @returns Whether any matching table is outside the managed block.
 */
function hasUnmanagedOpenWikiTable(
  content: string,
  serverName: string,
  managed?: MarkerRange,
): boolean {
  const table = new RegExp(
    `^\\s*\\[mcp_servers\\.${escapeRegExp(serverName)}\\]\\s*$`,
    "gmu",
  );
  for (const match of content.matchAll(table)) {
    const index = match.index;
    if (!managed || index < managed.start || index >= managed.end) return true;
  }
  return false;
}

/**
 * Renders the canonical managed TOML block.
 *
 * @param entry - Exact executable invocation to render.
 * @param serverName - `mcp_servers` table key that owns the block.
 * @returns Complete marker-delimited TOML block.
 */
function renderBlock(entry: HostMcpServerCommand, serverName: string): string {
  const markers = markersFor(serverName);
  return `${markers.start}
[mcp_servers.${serverName}]
command = ${JSON.stringify(entry.command)}
args = [${entry.args.map((argument) => JSON.stringify(argument)).join(", ")}]
${markers.end}
`;
}

/**
 * Escapes one literal for use inside a regular expression.
 *
 * @param value - Literal text.
 * @returns Pattern that matches exactly the literal.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Locates and validates the managed TOML marker pair.
 *
 * @param content - Complete TOML config content.
 * @param serverName - `mcp_servers` table key that owns the block.
 * @returns Managed byte range, or `null` when both markers are absent.
 */
function markerRange(content: string, serverName: string): MarkerRange | null {
  const markers = markersFor(serverName);
  const start = content.indexOf(markers.start);
  const endMarker = content.indexOf(markers.end);
  if (start === -1 && endMarker === -1) return null;
  if (start === -1 || endMarker === -1 || endMarker < start) {
    throw new HostIntegrationError(
      "invalid_input",
      "OpenWiki MCP markers are incomplete or out of order.",
    );
  }
  if (
    content.indexOf(markers.start, start + markers.start.length) !== -1 ||
    content.indexOf(markers.end, endMarker + markers.end.length) !== -1
  ) {
    throw new HostIntegrationError(
      "invalid_input",
      "OpenWiki MCP markers appear more than once.",
    );
  }

  let end = endMarker + markers.end.length;
  if (content[end] === "\r") end += 1;
  if (content[end] === "\n") end += 1;
  return { start, end };
}

/**
 * Reads an optional UTF-8 config file.
 *
 * @param filePath - Absolute config path.
 * @returns File content, or an empty string when absent.
 */
async function readOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
