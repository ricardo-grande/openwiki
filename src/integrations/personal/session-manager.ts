import os from "node:os";
import path from "node:path";
import { createConnectorSynthesisGuidance } from "../../agent/prompts/personal-guidance.js";
import { getConnectorRawDir } from "../../config/openwiki-home.js";
import {
  callMcpConnectorTool,
  discoverMcpConnectorTools,
  McpToolCallRefusedError,
  type McpConnectorId,
} from "../../connectors/mcp-runtime.js";
import {
  createConnectorRegistry,
  isConnectorId,
} from "../../connectors/registry.js";
import type {
  ConnectorId,
  ConnectorIngestResult,
} from "../../connectors/types.js";
import {
  beginPersonalRun,
  closePersonalGathering,
  editPersonalPage,
  finishPersonalRun,
  nextPersonalPage,
  readPersonalOpenQuestions,
  releasePersonalRun,
  renewPersonalRun,
  submitPersonalPage,
  submitPersonalPlan,
  writePersonalPage,
  type ActivePersonalRun,
  type PersonalBeginView,
  type PersonalNoopView,
} from "../../generation/personal-run.js";
import type { PersonalFrontierEntry } from "../../generation/personal-run-state.js";
import { readOpenWikiOnboardingConfig } from "../../setup/onboarding.js";
import { HostIntegrationError } from "../core/errors.js";
import { OperationGuard } from "../core/operation-guard.js";
import type { ProtocolTool } from "../core/protocol.js";
import {
  getHostAgentIdentity,
  mapRepositoryRunError,
  validateHostIdentity,
} from "../core/session-manager.js";
import { loadScopedConnectorEnv } from "./connector-env.js";
import {
  createPersonalLifecycleTools,
  PERSONAL_INGEST_WINDOW_HOURS,
  PERSONAL_PAGE_MAX_BYTES,
  type PersonalBeginRequest,
  type PersonalIngestRequest,
  type PersonalLifecycleOperations,
} from "./lifecycle-tools.js";
import { createPersonalRetrievalTools } from "./retrieval-tools.js";
import { collectSecretValues, redactSecretValues } from "./secret-redaction.js";

/**
 * Characters of one MCP result returned to the host. The complete result is
 * in its raw run.
 */
const MCP_RESULT_MAX_CHARACTERS = 100_000;

/**
 * Host identity for the personal MCP adapter.
 */
export interface PersonalSessionManagerOptions {
  /**
   * Stable lowercase host identity.
   */
  host: string;

  /**
   * Provenance actor, defaulting to the host identity when omitted.
   */
  producerActor?: string;

  /**
   * Loads the scoped connector environment on the first fetching call, and
   * returns the values it read so tool results can be kept free of them.
   *
   * @default loadScopedConnectorEnv
   */
  loadConnectorEnv?: () => Promise<Readonly<Record<string, string>> | void>;
}

/**
 * Run identity a personal host session supplies to the lifecycle core.
 */
export interface PersonalRunActor {
  /**
   * Producer stamped on host-authored pages.
   */
  producerActor: string;

  /**
   * Metadata model recorded in `.last-update.json`.
   */
  metadataModel: string;
}

/**
 * `openwiki_personal_begin` result for a run that needs host work: the core
 * view plus the guidance the host plans with (host §3.5).
 */
export interface PersonalHostBeginView extends PersonalBeginView {
  /**
   * Synthesis guidance per frontier connector, with the user's instructions
   * for that source.
   */
  briefs: Record<string, string>;

  /**
   * Body of the Active section of `/open-questions.md`, or `null`.
   */
  openQuestions: string | null;
}

/**
 * The personal server's session: at most one active personal run (host
 * §3.2), serialized lifecycle operations, and the connector environment
 * loaded on first use.
 */
export class PersonalSessionManager implements PersonalLifecycleOperations {
  /**
   * Run identity supplied to core operations.
   */
  readonly actor: PersonalRunActor;

  /**
   * Single-writer lock holder, `host-<hostId>:<hostname>:<pid>`.
   */
  readonly holder: string;

  /**
   * Process-local runtime of the run this session began or resumed.
   */
  private active: ActivePersonalRun | null = null;

  /**
   * Single-operation guard shared by every lifecycle operation.
   */
  private readonly guard = new OperationGuard();

  /**
   * The operation currently holding the guard, awaited by `close`.
   */
  private current: Promise<unknown> | undefined;

  /**
   * Loader for the scoped connector environment.
   */
  private readonly loadConnectorEnv: () => Promise<Readonly<
    Record<string, string>
  > | void>;

  /**
   * The first connector environment load, shared by later callers.
   */
  private connectorEnv: Promise<void> | undefined;

  /**
   * Values the connector environment load read, never returned to the host.
   */
  private readonly loadedSecrets = new Set<string>();

  /**
   * Stores the validated identity and dependencies for one adapter.
   *
   * @param host - Validated host identity.
   * @param producerActor - Validated producer identity.
   * @param loadConnectorEnv - Scoped connector environment loader.
   */
  private constructor(
    host: string,
    producerActor: string,
    loadConnectorEnv: PersonalSessionManager["loadConnectorEnv"],
  ) {
    this.actor = {
      producerActor,
      metadataModel: getHostAgentIdentity(host),
    };
    this.holder = `host-${host}:${os.hostname()}:${process.pid}`;
    this.loadConnectorEnv = loadConnectorEnv;
  }

  /**
   * Validates host identity and creates an idle personal adapter.
   *
   * @param options - Host identity and optional producer.
   * @returns A validated personal session manager.
   */
  static create(
    options: PersonalSessionManagerOptions,
  ): PersonalSessionManager {
    const producerActor = validateHostIdentity(
      options.host,
      options.producerActor,
    );
    return new PersonalSessionManager(
      options.host,
      producerActor,
      options.loadConnectorEnv ?? loadScopedConnectorEnv,
    );
  }

  /**
   * Returns every personal tool in host §3.2 order. No result or error
   * message carries a secret value.
   *
   * @returns Ordered transport-neutral tool definitions.
   */
  tools(): readonly ProtocolTool[] {
    return [
      ...createPersonalRetrievalTools(),
      ...createPersonalLifecycleTools(this),
    ].map((tool) => ({
      ...tool,
      handle: async (input: unknown) => {
        try {
          return this.redact(await tool.handle(input));
        } catch (error) {
          if (error instanceof HostIntegrationError) {
            throw new HostIntegrationError(
              error.code,
              this.redact(error.message),
            );
          }
          throw error;
        }
      },
    }));
  }

  /**
   * Loads the scoped connector environment once. Fetching tools call this
   * before their first fetch; retrieval and status tools never do.
   */
  async loadConnectorEnvironment(): Promise<void> {
    this.connectorEnv ??= this.loadConnectorEnv().then(
      (loaded) => {
        for (const value of Object.values(loaded ?? {})) {
          this.loadedSecrets.add(value);
        }
      },
      (error: unknown) => {
        this.connectorEnv = undefined;
        throw error;
      },
    );
    await this.connectorEnv;
  }

  /**
   * Runs one personal operation under the single-operation guard and maps
   * lifecycle errors at its boundary.
   *
   * @param task - Operation that requires exclusive adapter access.
   * @returns The operation result.
   */
  async runOperation<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.guard.run(task);
    this.current ??= operation;
    try {
      return await operation;
    } catch (error) {
      throw mapRepositoryRunError(error);
    } finally {
      if (this.current === operation) this.current = undefined;
    }
  }

  /**
   * Runs one deterministic pull for every connected source instance of a
   * connector, as a scheduled pull would (host §3.4). Starts no run.
   *
   * @param request - Connector and pull options.
   * @returns The pull result, with raw files relative to the raw directory.
   */
  async ingest(request: PersonalIngestRequest): Promise<ConnectorIngestResult> {
    return this.runOperation(async () => {
      const connector = createConnectorRegistry()[request.connectorId];
      if (connector.supportsAgenticDiscovery) {
        throw new HostIntegrationError(
          "invalid_input",
          `${connector.displayName} is not pulled ahead of a run. Its evidence is gathered during a run: call openwiki_personal_begin, then use the gathering tools.`,
        );
      }
      const instances = (
        await readOpenWikiOnboardingConfig()
      ).sourceInstances.filter(
        ({ connectorId, connectedAt }) =>
          connectorId === connector.id && Boolean(connectedAt),
      );
      if (instances.length === 0) {
        throw new HostIntegrationError(
          "invalid_input",
          `${connector.displayName} is not connected. Ask the user to connect it with \`openwiki auth\` or OpenWiki onboarding.`,
        );
      }

      await this.loadConnectorEnvironment();
      const results: ConnectorIngestResult[] = [];
      for (const instance of instances) {
        results.push(
          await connector.ingest({
            connectorConfig: instance.connectorConfig,
            instanceId: instance.id,
            windowHours:
              request.windowHours ?? PERSONAL_INGEST_WINDOW_HOURS.default,
            limit: request.limit,
            streams: request.streams,
          }),
        );
      }
      return mergeIngestResults(connector.id, results);
    });
  }

  /**
   * Lists the live MCP tools of a connector the active run gathers from.
   *
   * @param request - Run and connector.
   * @returns The tool list in the untrusted envelope.
   */
  async listMcpTools(request: {
    runId: string;
    connectorId: McpConnectorId;
  }): Promise<UntrustedMcpResult> {
    return this.runOperation(async () => {
      await this.requireGathering(request);
      const discovery = await discoverMcpConnectorTools(request.connectorId);
      return toUntrustedMcpResult(
        request.connectorId,
        discovery.rawFile,
        discovery.tools,
      );
    });
  }

  /**
   * Calls one discovered read-only MCP tool and records the result as a raw
   * run inside the active run's gathering window (host §3.4).
   *
   * @param request - Run, connector, tool, and arguments.
   * @returns The tool result in the untrusted envelope.
   */
  async callMcpTool(request: {
    runId: string;
    connectorId: McpConnectorId;
    toolName: string;
    args?: Record<string, unknown>;
  }): Promise<UntrustedMcpResult> {
    return this.runOperation(async () => {
      await this.requireGathering(request);
      try {
        const call = await callMcpConnectorTool(
          request.connectorId,
          request.toolName,
          request.args ?? {},
        );
        return toUntrustedMcpResult(
          request.connectorId,
          call.rawFile,
          call.result,
        );
      } catch (error) {
        if (!(error instanceof McpToolCallRefusedError)) throw error;
        throw new HostIntegrationError(
          "invalid_input",
          error.reason === "unknown_tool"
            ? `${request.connectorId} has no MCP tool named ${request.toolName}. Call openwiki_personal_list_mcp_tools and use an exact discovered name.`
            : error.message,
        );
      }
    });
  }

  /**
   * Ends gathering and freezes the frontier.
   *
   * @param request - Exact active run identity.
   * @returns The planning phase and the frozen frontier.
   */
  async closeGathering(request: { runId: string }): Promise<unknown> {
    return this.runOperation(async () =>
      closePersonalGathering(this.requireSession(request.runId)),
    );
  }

  /**
   * Starts or resumes the personal run under this session's lock holder.
   *
   * @param request - Mode, scope, language, request, and takeover.
   * @returns The core view with briefs and open questions, or a no-op.
   */
  async begin(
    request: PersonalBeginRequest,
  ): Promise<PersonalHostBeginView | PersonalNoopView> {
    return this.runOperation(async () => {
      const result = await beginPersonalRun({
        ...request,
        actor: this.actor,
        holder: this.holder,
      });
      if (!("run" in result)) {
        this.active = null;
        return result.view;
      }
      this.active = result.run;
      return {
        ...result.view,
        briefs: await createBriefs(result.run.state.frontier),
        openQuestions: await readPersonalOpenQuestions(result.run.wikiDir),
      };
    });
  }

  /**
   * Validates and persists the active run's plan.
   *
   * @param request - Run identity and proposed plan.
   * @returns The accepted queue.
   */
  async submitPlan(request: {
    runId: string;
    pages: Parameters<typeof submitPersonalPlan>[1]["pages"];
    deletePages?: string[];
  }): Promise<unknown> {
    return this.runOperation(async () =>
      submitPersonalPlan(this.requireSession(request.runId), {
        pages: request.pages,
        deletePages: request.deletePages,
      }),
    );
  }

  /**
   * Returns the active run's first pending page job.
   *
   * @param request - Exact active run identity.
   * @returns The job with its page version, or queue completion.
   */
  async nextPage(request: { runId: string }): Promise<unknown> {
    return this.runOperation(async () =>
      nextPersonalPage(this.requireSession(request.runId)),
    );
  }

  /**
   * Replaces a pending job's page through the core's page change check.
   *
   * @param request - Run, job, base version, and content.
   * @returns The new version and front-matter state.
   */
  async writePage(request: {
    runId: string;
    jobId: string;
    baseVersion: string;
    content: string;
  }): Promise<unknown> {
    return this.runOperation(async () => {
      requireWithinPageLimit("content", request.content);
      return writePersonalPage(this.requireSession(request.runId), request);
    });
  }

  /**
   * Edits a pending job's page through the core's page change check.
   *
   * @param request - Run, job, base version, and replacement.
   * @returns The new version and front-matter state.
   */
  async editPage(request: {
    runId: string;
    jobId: string;
    baseVersion: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  }): Promise<unknown> {
    return this.runOperation(async () => {
      requireWithinPageLimit("oldString", request.oldString);
      requireWithinPageLimit("newString", request.newString);
      return editPersonalPage(this.requireSession(request.runId), request);
    });
  }

  /**
   * Completes a pending page job.
   *
   * @param request - Run and job.
   * @returns The page and the number of jobs still pending.
   */
  async submitPage(request: {
    runId: string;
    jobId: string;
  }): Promise<unknown> {
    return this.runOperation(async () =>
      submitPersonalPage(this.requireSession(request.runId), {
        jobId: request.jobId,
      }),
    );
  }

  /**
   * Finalizes the active run and clears the session's run.
   *
   * @param request - Exact active run identity.
   * @returns The completion result.
   */
  async finish(request: { runId: string }): Promise<unknown> {
    return this.runOperation(async () => {
      const result = await finishPersonalRun(
        this.requireSession(request.runId),
      );
      this.active = null;
      return result;
    });
  }

  /**
   * Ends the host session: waits for the operation in progress, then
   * releases the lock of an unfinished run and keeps `.run.json`, so another
   * driver can resume it (host §3.2, core §3.4).
   */
  async close(): Promise<void> {
    await this.current?.catch(() => undefined);
    const run = this.active;
    this.active = null;
    if (run) await releasePersonalRun(run);
  }

  /**
   * Returns the session's run only when the run ID matches.
   *
   * @param runId - Run identity supplied by the host.
   * @returns The active run.
   */
  private requireSession(runId: string): ActivePersonalRun {
    if (!this.active || this.active.state.runId !== runId) {
      throw new HostIntegrationError(
        "invalid_state",
        "No matching OpenWiki personal run is active. Call openwiki_personal_begin to start or resume it first.",
      );
    }
    return this.active;
  }

  /**
   * Requires the run to be gathering from the connector, confirms this
   * session still holds its lock, and loads the connector environment.
   *
   * @param request - Run and connector.
   */
  private async requireGathering(request: {
    runId: string;
    connectorId: McpConnectorId;
  }): Promise<void> {
    const run = this.requireSession(request.runId);
    if (run.state.phase !== "gathering") {
      throw new HostIntegrationError(
        "invalid_state",
        `The gathering tools work only in the gathering phase, not ${run.state.phase}.`,
      );
    }
    const open = run.state.frontier
      .filter(({ frozen }) => !frozen)
      .map(({ connectorId }) => connectorId);
    if (!open.includes(request.connectorId)) {
      throw new HostIntegrationError(
        "invalid_input",
        `This run gathers only from ${open.join(", ") || "no connector"}, not ${request.connectorId}.`,
      );
    }
    // Gathered evidence enters the frontier only while this session holds
    // the run.
    await renewPersonalRun(run);
    await this.loadConnectorEnvironment();
  }

  /**
   * Removes every loaded or secret-looking environment value.
   */
  private redact<T>(value: T): T {
    return redactSecretValues(value, collectSecretValues(this.loadedSecrets));
  }
}

/**
 * An MCP result in the untrusted envelope (host §3.4).
 */
export interface UntrustedMcpResult {
  untrusted: true;
  source: McpConnectorId;
  content: string;
  truncated: boolean;

  /**
   * Evidence ref of the raw file that records the result. It joins the
   * frontier when gathering closes.
   */
  ref: string;
}

/**
 * Wraps an MCP result as untrusted third-party content.
 */
function toUntrustedMcpResult(
  connectorId: McpConnectorId,
  rawFile: string,
  value: unknown,
): UntrustedMcpResult {
  const content = JSON.stringify(value, null, 2) ?? "null";
  return {
    untrusted: true,
    source: connectorId,
    content: content.slice(0, MCP_RESULT_MAX_CHARACTERS),
    truncated: content.length > MCP_RESULT_MAX_CHARACTERS,
    ref: `raw://${connectorId}/${toRawRelativePath(connectorId, rawFile)}`,
  };
}

/**
 * Combines the pulls of one connector's source instances into one result.
 *
 * @param connectorId - Connector pulled.
 * @param results - One result per source instance, in order.
 * @returns The single result, or a merged one whose status is `success`
 *   when any pull succeeded, and whose `runId` is the last pull's.
 */
function mergeIngestResults(
  connectorId: ConnectorId,
  results: readonly ConnectorIngestResult[],
): ConnectorIngestResult {
  const relative = (result: ConnectorIngestResult) =>
    result.rawFiles.map((file) => toRawRelativePath(connectorId, file));
  if (results.length === 1) {
    return { ...results[0], rawFiles: relative(results[0]) };
  }
  const statuses = new Set(results.map(({ status }) => status));
  const last = results[results.length - 1];
  return {
    connectorId,
    message: results.map(({ message }) => message).join("\n"),
    rawFiles: results.flatMap(relative),
    runId: last.runId,
    statePath: last.statePath,
    status: statuses.has("success")
      ? "success"
      : statuses.has("error")
        ? "error"
        : "skipped",
    warnings: results.flatMap(({ warnings }) => warnings),
  };
}

/**
 * Expresses a raw file relative to its connector's raw directory, with `/`
 * separators, as evidence refs and `read_raw_item` expect.
 */
function toRawRelativePath(connectorId: string, file: string): string {
  const relative = path.isAbsolute(file)
    ? path.relative(getConnectorRawDir(connectorId), file)
    : file;
  return relative.split(path.sep).join("/");
}

/**
 * Builds the brief of every frontier connector: its synthesis guidance and
 * the user's ingestion goals for its sources.
 *
 * @param frontier - The run's evidence frontier.
 * @returns Briefs keyed by connector, omitting connectors with neither.
 */
async function createBriefs(
  frontier: readonly PersonalFrontierEntry[],
): Promise<Record<string, string>> {
  const { sourceInstances } = await readOpenWikiOnboardingConfig();
  const briefs: Record<string, string> = {};
  for (const { connectorId } of frontier) {
    if (!isConnectorId(connectorId)) continue;
    const goals = sourceInstances
      .filter(
        (instance) =>
          instance.connectorId === connectorId &&
          Boolean(instance.connectedAt) &&
          Boolean(instance.ingestionGoal?.trim()),
      )
      .map(
        (instance) =>
          `- ${instance.name ?? instance.id}: ${instance.ingestionGoal?.trim()}`,
      );
    const brief = [
      createConnectorSynthesisGuidance({ id: connectorId }).trim(),
      goals.length > 0
        ? `The user's instructions for this source:\n${goals.join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    if (brief) briefs[connectorId] = brief;
  }
  return briefs;
}

/**
 * Rejects page content over the 512 KB write limit (host §3.5).
 *
 * @param field - Input field named in the error.
 * @param value - Content to measure in UTF-8 bytes.
 */
function requireWithinPageLimit(field: string, value: string): void {
  if (Buffer.byteLength(value, "utf8") > PERSONAL_PAGE_MAX_BYTES) {
    throw new HostIntegrationError(
      "invalid_input",
      `${field} is larger than ${PERSONAL_PAGE_MAX_BYTES / 1024} KB.`,
    );
  }
}
