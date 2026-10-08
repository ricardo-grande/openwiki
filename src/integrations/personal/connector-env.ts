import { readFile } from "node:fs/promises";
import { AUTH_PROVIDERS } from "../../auth/providers.js";
import { OPENWIKI_TAVILY_API_KEY_ENV_KEY } from "../../config/constants.js";
import { loadOpenWikiEnv, scopeOpenWikiEnvLoading } from "../../config/env.js";
import { getConnectorConfigPath } from "../../config/openwiki-home.js";
import { isFileNotFoundError } from "../../platform/fs-errors.js";
import { createConnectorRegistry } from "../../connectors/registry.js";
import type { McpConnectorId } from "../../connectors/mcp-runtime.js";

const MCP_CONNECTOR_IDS = [
  "notion",
  "custom-mcp",
] as const satisfies readonly McpConnectorId[];
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const ENV_REFERENCE_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/gu;

/**
 * Lists the `<home>/.env` keys the personal server may load (host §3.1):
 * personal connectors' required keys, the OAuth client and token keys used by
 * `refreshOAuthAccessToken`, the Tavily key, and the variables that MCP
 * connector transports reference. Model-provider keys are removed later by
 * `scopeOpenWikiEnvLoading`, even when a transport references one.
 *
 * @returns The connector environment keys.
 */
export async function resolveScopedConnectorEnvKeys(): Promise<Set<string>> {
  const keys = new Set<string>([OPENWIKI_TAVILY_API_KEY_ENV_KEY]);

  for (const connector of Object.values(createConnectorRegistry())) {
    if (connector.mode !== "personal") continue;
    for (const key of connector.requiredEnv) keys.add(key);
  }

  for (const provider of Object.values(AUTH_PROVIDERS)) {
    for (const key of [
      provider.clientIdEnvKey,
      provider.clientSecretEnvKey,
      ...Object.values(provider.tokenMapping),
    ]) {
      if (key) keys.add(key);
    }
  }

  for (const connectorId of MCP_CONNECTOR_IDS) {
    for (const key of await readTransportEnvReferences(connectorId)) {
      keys.add(key);
    }
  }

  return keys;
}

/**
 * Limits this process's `.env` loads to the connector keys, then loads them
 * into `process.env` without overwriting values already set.
 */
export async function loadScopedConnectorEnv(): Promise<void> {
  scopeOpenWikiEnvLoading(await resolveScopedConnectorEnvKeys());
  await loadOpenWikiEnv();
}

/**
 * Collects the environment variables one MCP connector's transport references:
 * every `${NAME}` in a transport string, and each bare variable name in
 * `transport.env`, which the stdio client also resolves.
 *
 * @param connectorId - MCP connector whose `config.json` is read.
 * @returns Referenced variable names, empty when the config is absent.
 */
async function readTransportEnvReferences(
  connectorId: McpConnectorId,
): Promise<string[]> {
  let config: unknown;
  try {
    config = JSON.parse(
      await readFile(getConnectorConfigPath(connectorId), "utf8"),
    );
  } catch (error) {
    if (isFileNotFoundError(error) || error instanceof SyntaxError) return [];
    throw error;
  }

  const transport = isRecord(config) ? config.transport : undefined;
  if (!isRecord(transport)) return [];

  const names: string[] = [];
  collectReferences(transport, names);
  if (isRecord(transport.env)) {
    for (const value of Object.values(transport.env)) {
      if (typeof value === "string" && ENV_KEY_PATTERN.test(value)) {
        names.push(value);
      }
    }
  }
  return names;
}

/**
 * Appends every `${NAME}` reference found in the strings of a JSON value.
 *
 * @param value - JSON value to walk.
 * @param names - Collected variable names.
 */
function collectReferences(value: unknown, names: string[]): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(ENV_REFERENCE_PATTERN)) {
      names.push(match[1]);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, names);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) collectReferences(item, names);
  }
}

/**
 * Narrows an unknown value to a non-array object.
 *
 * @param value - Unknown parsed JSON value.
 * @returns Whether the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
