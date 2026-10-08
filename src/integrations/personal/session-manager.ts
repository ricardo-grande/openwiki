import os from "node:os";
import { OperationGuard } from "../core/operation-guard.js";
import type { ProtocolTool } from "../core/protocol.js";
import {
  getHostAgentIdentity,
  validateHostIdentity,
} from "../core/session-manager.js";
import { loadScopedConnectorEnv } from "./connector-env.js";

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
   * Loads the scoped connector environment on the first fetching call.
   *
   * @default loadScopedConnectorEnv
   */
  loadConnectorEnv?: () => Promise<void>;
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
 * The personal server's session: at most one active personal run (host §3.2),
 * serialized operations, and the connector environment loaded on first use.
 *
 * This stage registers no tools. The retrieval tools arrive in H2 and the
 * lifecycle tools in H3.
 */
export class PersonalSessionManager {
  /**
   * Run identity supplied to core operations.
   */
  readonly actor: PersonalRunActor;

  /**
   * Single-writer lock holder, `host-<hostId>:<hostname>:<pid>`.
   */
  readonly holder: string;

  /**
   * Single-operation guard shared by every personal operation.
   */
  private readonly guard = new OperationGuard();

  /**
   * Loader for the scoped connector environment.
   */
  private readonly loadConnectorEnv: () => Promise<void>;

  /**
   * The first connector environment load, shared by later callers.
   */
  private connectorEnv: Promise<void> | undefined;

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
    loadConnectorEnv: () => Promise<void>,
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
   * Returns the personal tools of the shipped stage, in host §3.2 order.
   *
   * @returns Ordered transport-neutral tool definitions.
   */
  tools(): readonly ProtocolTool[] {
    return [];
  }

  /**
   * Loads the scoped connector environment once. Fetching tools call this
   * before their first fetch; retrieval and status tools never do.
   */
  async loadConnectorEnvironment(): Promise<void> {
    this.connectorEnv ??= this.loadConnectorEnv().catch((error: unknown) => {
      this.connectorEnv = undefined;
      throw error;
    });
    await this.connectorEnv;
  }

  /**
   * Runs one personal operation under the single-operation guard.
   *
   * @param task - Operation that requires exclusive adapter access.
   * @returns The operation result.
   */
  async runOperation<T>(task: () => Promise<T>): Promise<T> {
    return this.guard.run(task);
  }
}
