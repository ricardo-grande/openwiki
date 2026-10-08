import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ConnectorId,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../../src/connectors/types.ts";
import type {
  OnboardingSourceInstanceConfig,
  OpenWikiOnboardingConfig,
} from "../../src/setup/onboarding.ts";

// Lifecycle-core ingestion (core §3.5, C5) through the real chain:
// runOpenWikiIngestion → runOpenWikiAgent → runNativePersonalGeneration →
// beginPersonalRun. Only begin itself, the connectors, and the side-effecting
// home, env, skills, and telemetry helpers are replaced, so the test proves
// what the core receives: one begin per ingest, after every pull.

const harness = vi.hoisted(() => ({
  calls: [] as string[],
  beginPersonalRun: vi.fn(),
}));

vi.mock("../../src/generation/personal-run.ts", async (importActual) => ({
  ...(await importActual<
    typeof import("../../src/generation/personal-run.ts")
  >()),
  beginPersonalRun: harness.beginPersonalRun,
}));

vi.mock("../../src/config/env.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../src/config/env.ts")>()),
  loadOpenWikiEnv: vi.fn(() => Promise.resolve({})),
}));

vi.mock("../../src/config/openwiki-home.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../src/config/openwiki-home.ts")>()),
  ensureOpenWikiHome: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/setup/onboarding.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../src/setup/onboarding.ts")>()),
  readOpenWikiOnboardingConfig: vi.fn(),
}));

vi.mock("../../src/agent/skills.ts", () => ({
  syncBundledSkills: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/telemetry/index.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../src/telemetry/index.ts")>()),
  withRunTelemetry: vi.fn(
    (
      _command: unknown,
      _options: unknown,
      _context: unknown,
      run: () => Promise<unknown>,
    ) => run(),
  ),
}));

import { PersonalRunLockConflictError } from "../../src/generation/personal-run-lock.ts";
import { readOpenWikiOnboardingConfig } from "../../src/setup/onboarding.ts";
import { runOpenWikiIngestion } from "../../src/ingestion/ingestion.ts";

const savedEnv = { ...process.env };

/**
 * A connector that records its pull in the shared call log.
 */
function makeConnector(
  id: ConnectorId,
  options: { agentic?: boolean; fail?: boolean } = {},
): ConnectorRuntime {
  return {
    backend: "direct-api",
    description: `${id} test connector`,
    displayName: id,
    id,
    mode: "personal",
    requiredEnv: [],
    supportsAgenticDiscovery: options.agentic ?? false,
    ingest: vi.fn(() => {
      harness.calls.push(`pull:${id}`);
      if (options.fail) {
        return Promise.reject(new Error(`${id} token expired`));
      }
      return Promise.resolve<ConnectorIngestResult>({
        connectorId: id,
        message: `${id} pulled`,
        rawFiles: [`/home/.openwiki/connectors/${id}/raw/run/data.json`],
        runId: "2026-10-08T06-00-00-000Z",
        statePath: `/home/.openwiki/connectors/${id}/state.json`,
        status: "success",
        warnings: [],
      });
    }),
  };
}

function makeSource(
  connectorId: ConnectorId,
  id: string = connectorId,
): OnboardingSourceInstanceConfig {
  return { connectorId, id, connectedAt: "2026-07-01T00:00:00.000Z" };
}

function primeConfig(
  sourceInstances: OnboardingSourceInstanceConfig[],
  overrides: Partial<OpenWikiOnboardingConfig> = {},
): void {
  vi.mocked(readOpenWikiOnboardingConfig).mockResolvedValue({
    sourceInstances,
    sources: {},
    version: 1,
    ...overrides,
  });
}

function makeRegistry(
  ...connectors: ConnectorRuntime[]
): Record<ConnectorId, ConnectorRuntime> {
  return Object.fromEntries(
    connectors.map((connector) => [connector.id, connector]),
  ) as Record<ConnectorId, ConnectorRuntime>;
}

const NOOP_BEGIN = {
  view: { status: "noop", mode: "update", language: "en", warnings: [] },
};

function expiredLockConflict(): PersonalRunLockConflictError {
  return new PersonalRunLockConflictError(
    {
      holder: "native:other-host:4711",
      runId: "run-1",
      acquiredAt: "2026-10-08T05:00:00.000Z",
      renewedAt: "2026-10-08T05:00:00.000Z",
    },
    45 * 60_000,
    true,
  );
}

beforeEach(() => {
  process.env.OPENWIKI_PERSONAL_CORE = "1";
  process.env.OPENWIKI_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "test-key";
  harness.calls.length = 0;
  harness.beginPersonalRun.mockReset();
  harness.beginPersonalRun.mockImplementation(() => {
    harness.calls.push("begin");
    return Promise.resolve(NOOP_BEGIN);
  });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  vi.clearAllMocks();
});

describe("lifecycle-core ingestion", () => {
  test("runs every pull first, then calls begin exactly once for several sources", async () => {
    primeConfig([
      makeSource("google"),
      makeSource("slack"),
      makeSource("slack", "slack-work"),
      makeSource("notion"),
    ]);

    const result = await runOpenWikiIngestion(undefined, {
      target: "all",
      connectorRegistry: makeRegistry(
        makeConnector("google"),
        makeConnector("slack"),
        makeConnector("notion", { agentic: true }),
      ),
    });

    expect(harness.calls).toEqual([
      "pull:google",
      "pull:slack",
      "pull:slack",
      "begin",
    ]);
    expect(harness.beginPersonalRun).toHaveBeenCalledTimes(1);
    expect(harness.beginPersonalRun).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "update",
        scope: { connectors: ["google", "slack", "notion"] },
      }),
    );
    expect(harness.beginPersonalRun.mock.calls[0]?.[0]).not.toHaveProperty(
      "instruction",
      expect.anything(),
    );
    expect(result.results.map(({ status }) => status)).toEqual([
      "pulled",
      "pulled",
      "pulled",
      "gathered",
    ]);
    expect(result.synthesis).toEqual({ status: "noop" });
  });

  test("scopes the run to the requested connector", async () => {
    primeConfig([makeSource("google"), makeSource("slack")]);

    await runOpenWikiIngestion(undefined, {
      target: "slack",
      connectorRegistry: makeRegistry(
        makeConnector("google"),
        makeConnector("slack"),
      ),
    });

    expect(harness.calls).toEqual(["pull:slack", "begin"]);
    expect(harness.beginPersonalRun).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { connectors: ["slack"] } }),
    );
  });

  test("a failed pull stops neither the other pulls nor the single run", async () => {
    primeConfig([makeSource("x"), makeSource("hackernews")]);

    const result = await runOpenWikiIngestion(undefined, {
      target: "all",
      connectorRegistry: makeRegistry(
        makeConnector("x", { fail: true }),
        makeConnector("hackernews"),
      ),
    });

    expect(harness.calls).toEqual(["pull:x", "pull:hackernews", "begin"]);
    expect(result.results.map(({ status }) => status)).toEqual([
      "error",
      "pulled",
    ]);
    expect(result.synthesis).toEqual({ status: "noop" });
  });

  test("--pull-only pulls deterministic sources and never begins a run", async () => {
    primeConfig([makeSource("google"), makeSource("notion")]);

    const result = await runOpenWikiIngestion(undefined, {
      target: "all",
      pullOnly: true,
      connectorRegistry: makeRegistry(
        makeConnector("google"),
        makeConnector("notion", { agentic: true }),
      ),
    });

    expect(harness.calls).toEqual(["pull:google"]);
    expect(harness.beginPersonalRun).not.toHaveBeenCalled();
    expect(result.results.map(({ status }) => status)).toEqual([
      "pulled",
      "skipped",
    ]);
    expect(result.synthesis).toBeUndefined();
  });

  test("--pull-only is refused without the opt-in, before any pull", async () => {
    delete process.env.OPENWIKI_PERSONAL_CORE;
    primeConfig([makeSource("google")]);
    const google = makeConnector("google");

    await expect(
      runOpenWikiIngestion(undefined, {
        target: "all",
        pullOnly: true,
        connectorRegistry: makeRegistry(google),
      }),
    ).rejects.toThrow("--pull-only requires OPENWIKI_PERSONAL_CORE=1");
    expect(google.ingest).not.toHaveBeenCalled();
  });

  test("a lock conflict keeps the pulls and reports the holder", async () => {
    primeConfig([makeSource("google")]);
    harness.beginPersonalRun.mockImplementation(() => {
      harness.calls.push("begin");
      return Promise.reject(
        new PersonalRunLockConflictError(
          {
            holder: "host-claude:mbp:4711",
            runId: "run-1",
            acquiredAt: "2026-10-08T05:58:00.000Z",
            renewedAt: "2026-10-08T05:58:00.000Z",
          },
          2 * 60_000,
          false,
        ),
      );
    });

    const result = await runOpenWikiIngestion(undefined, {
      target: "google",
      connectorRegistry: makeRegistry(makeConnector("google")),
    });

    expect(result.results[0]).toMatchObject({
      status: "pulled",
      rawFiles: ["/home/.openwiki/connectors/google/raw/run/data.json"],
    });
    expect(result.synthesis).toEqual({
      status: "conflict",
      message:
        "The personal wiki is being updated by host-claude:mbp:4711 (last active 2 min ago).",
    });
  });

  test("scheduled ingestion never takes over an expired lock, even when a confirmation is supplied (PLC-013)", async () => {
    primeConfig([makeSource("google")], {
      ingestionSchedule: {
        description: "daily",
        expression: "0 2 * * *",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    });
    harness.beginPersonalRun.mockRejectedValue(expiredLockConflict());
    const confirmTakeover = vi.fn(() => Promise.resolve(true));

    const result = await runOpenWikiIngestion(undefined, {
      target: "all",
      scheduledOnly: true,
      confirmTakeover,
      connectorRegistry: makeRegistry(makeConnector("google")),
    });

    expect(confirmTakeover).not.toHaveBeenCalled();
    expect(harness.beginPersonalRun).toHaveBeenCalledTimes(1);
    expect(harness.beginPersonalRun.mock.calls[0]?.[0]).not.toHaveProperty(
      "takeover",
    );
    expect(result.synthesis?.status).toBe("conflict");
  });

  test("an interactive ingest takes over an expired lock only after confirmation", async () => {
    primeConfig([makeSource("google")]);
    harness.beginPersonalRun
      .mockRejectedValueOnce(expiredLockConflict())
      .mockResolvedValueOnce(NOOP_BEGIN);
    const confirmTakeover = vi.fn(() => Promise.resolve(true));

    const result = await runOpenWikiIngestion(undefined, {
      target: "all",
      confirmTakeover,
      connectorRegistry: makeRegistry(makeConnector("google")),
    });

    expect(confirmTakeover).toHaveBeenCalledWith({
      holder: "native:other-host:4711",
      ageMs: 45 * 60_000,
    });
    expect(harness.beginPersonalRun).toHaveBeenCalledTimes(2);
    expect(harness.beginPersonalRun.mock.calls[1]?.[0]).toMatchObject({
      takeover: true,
    });
    expect(result.synthesis).toEqual({ status: "noop" });
  });

  test("a declined takeover leaves the expired lock and reports the conflict", async () => {
    primeConfig([makeSource("google")]);
    harness.beginPersonalRun.mockRejectedValue(expiredLockConflict());
    const confirmTakeover = vi.fn(() => Promise.resolve(false));

    const result = await runOpenWikiIngestion(undefined, {
      target: "all",
      confirmTakeover,
      connectorRegistry: makeRegistry(makeConnector("google")),
    });

    expect(confirmTakeover).toHaveBeenCalledTimes(1);
    expect(harness.beginPersonalRun).toHaveBeenCalledTimes(1);
    expect(result.synthesis?.status).toBe("conflict");
  });

  test("no matching scheduled source means no pull and no run", async () => {
    primeConfig([makeSource("google")]);

    const result = await runOpenWikiIngestion(undefined, {
      target: "all",
      scheduledOnly: true,
      connectorRegistry: makeRegistry(makeConnector("google")),
    });

    expect(harness.calls).toEqual([]);
    expect(result).toEqual({ results: [] });
  });
});
