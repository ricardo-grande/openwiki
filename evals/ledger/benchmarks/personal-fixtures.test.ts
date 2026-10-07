import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import { rawRunIdToIso } from "../benchmark/personal.js";

// Personal benchmark fixtures must be exactly what the real connectors write,
// or the replay would test OpenWiki against data it never sees in production.
// Each test inverts one recorded pull back into the Gmail or Slack API
// responses that would have produced it, runs the real connector against them
// with a stubbed fetch and a frozen clock in a throwaway OpenWiki home, and
// requires byte-identical output. A second test proves each builder is
// deterministic by rebuilding into a temp directory.

const benchmarksDir = path.dirname(fileURLToPath(import.meta.url));
const PERSONAL_BENCHMARKS = ["inbox-week", "cross-source"];
const TRACKED_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "OPENWIKI_CONFIG_DIR",
  "OPENWIKI_GMAIL_ACCESS_TOKEN",
  "OPENWIKI_GMAIL_REFRESH_TOKEN",
  "OPENWIKI_GMAIL_TOKEN_EXPIRES_AT",
  "OPENWIKI_SLACK_USER_TOKEN",
  "OPENWIKI_SLACK_USER_TOKEN_EXPIRES_AT",
] as const;
const originalEnv = Object.fromEntries(
  TRACKED_ENV_KEYS.map((key) => [key, process.env[key]]),
);
const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const key of TRACKED_ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A fresh temp directory removed after the test. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Every recorded pull in a benchmark's `raw/` tree. */
async function recordedPulls(
  benchmark: string,
): Promise<Array<{ connectorId: string; rawRunId: string; dir: string }>> {
  const rawRoot = path.join(benchmarksDir, benchmark, "raw");
  const pulls = [];
  for (const connectorId of (await readdir(rawRoot)).sort()) {
    for (const rawRunId of (
      await readdir(path.join(rawRoot, connectorId))
    ).sort()) {
      pulls.push({
        connectorId,
        rawRunId,
        dir: path.join(rawRoot, connectorId, rawRunId),
      });
    }
  }
  return pulls;
}

/** Read every file in a directory as text, keyed by name. */
async function readFiles(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of (await readdir(dir)).sort()) {
    files[name] = await readFile(path.join(dir, name), "utf8");
  }
  return files;
}

/** A JSON fetch response. */
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type Json = Record<string, unknown>;

/** Stub the Gmail API with the list and get responses behind one dump. */
function stubGmail(dump: Json): void {
  const messages = dump.messages as Json[];
  const pages = dump.listPages as Array<{ resultSizeEstimate: number }>;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const [, id] =
        /\/users\/me\/messages(?:\/([^/]+))?$/u.exec(url.pathname) ?? [];
      if (id === undefined) {
        return json(
          messages.length === 0
            ? { resultSizeEstimate: pages[0].resultSizeEstimate }
            : {
                messages: messages.map((message) => ({
                  id: message.id,
                  threadId: message.threadId,
                })),
                resultSizeEstimate: pages[0].resultSizeEstimate,
              },
        );
      }
      const message = messages.find(
        (candidate) => candidate.id === decodeURIComponent(id),
      );
      return message === undefined
        ? new Response("missing", { status: 404 })
        : json(message);
    }),
  );
}

/** Stub the Slack Web API with the responses behind one recorded pull. */
function stubSlack(files: Record<string, string>): void {
  const identity = JSON.parse(files["identity.json"]) as Json;
  const search = JSON.parse(files["my-messages-search.json"]) as Json;
  const recent = JSON.parse(files["recent-messages.json"]) as Json;
  const user = identity.user as Json;
  const conversations = recent.conversations as Array<{
    conversation: Json;
    messages: Json[];
  }>;
  const searchMessages = (search.userMessages as Array<{ message: Json }>).map(
    (entry) => entry.message,
  );

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const method = String(input).split("/").pop();
      const params = Object.fromEntries(
        new URLSearchParams(String(init?.body ?? "")),
      );
      switch (method) {
        case "auth.test":
          return json({
            ok: true,
            url: identity.teamUrl,
            team: identity.team,
            user: user.name,
            team_id: identity.teamId,
            user_id: identity.userId,
          });
        case "users.info":
          return json({ ok: true, user });
        case "search.messages":
          return json({
            ok: true,
            query: params.query,
            messages: {
              matches: searchMessages,
              total: (search.coverage as Json).total,
            },
          });
        case "conversations.list":
          return json({
            ok: true,
            channels: conversations.map((entry) => entry.conversation),
          });
        case "conversations.history":
          return json({
            ok: true,
            messages:
              conversations.find(
                (entry) => entry.conversation.id === params.channel,
              )?.messages ?? [],
          });
        default:
          return json({ ok: false, error: `unexpected method ${method}` });
      }
    }),
  );
}

describe.each(PERSONAL_BENCHMARKS)("%s fixtures", (benchmark) => {
  test("match what the real connectors write, byte for byte", async () => {
    const pulls = await recordedPulls(benchmark);
    expect(pulls.length).toBeGreaterThan(0);

    for (const pull of pulls) {
      const home = await tempDir("openwiki-personal-shape-");
      const recorded = await readFiles(pull.dir);
      vi.resetModules();
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      process.env.OPENWIKI_CONFIG_DIR = path.join(home, ".openwiki");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(rawRunIdToIso(pull.rawRunId) as string));

      let ingest;
      if (pull.connectorId === "google") {
        process.env.OPENWIKI_GMAIL_ACCESS_TOKEN = "gmail-access-token";
        process.env.OPENWIKI_GMAIL_REFRESH_TOKEN = "gmail-refresh-token";
        delete process.env.OPENWIKI_GMAIL_TOKEN_EXPIRES_AT;
        stubGmail(JSON.parse(recorded["gmail-messages.json"]) as Json);
        const { createGmailConnector } =
          await import("../../../src/connectors/sources/gmail.js");
        ingest = createGmailConnector().ingest;
      } else {
        process.env.OPENWIKI_SLACK_USER_TOKEN = "slack-user-token";
        delete process.env.OPENWIKI_SLACK_USER_TOKEN_EXPIRES_AT;
        // `openwiki auth configure slack` enables the connector this way.
        const configDir = path.join(home, ".openwiki", "connectors", "slack");
        await mkdir(configDir, { recursive: true });
        await writeFile(
          path.join(configDir, "config.json"),
          '{ "enabled": true }\n',
        );
        stubSlack(recorded);
        const { createSlackConnector } =
          await import("../../../src/connectors/sources/slack.js");
        ingest = createSlackConnector().ingest;
      }

      const result = await ingest({
        instanceId: pull.connectorId,
        windowHours: 24,
      });
      const written = await readFiles(
        path.join(
          home,
          ".openwiki",
          "connectors",
          pull.connectorId,
          "raw",
          pull.rawRunId,
        ),
      );

      expect(result.status, `${pull.connectorId}/${pull.rawRunId}`).toBe(
        "success",
      );
      expect(result.runId).toBe(pull.rawRunId);
      expect(Object.keys(written)).toEqual(Object.keys(recorded));
      for (const name of Object.keys(recorded)) {
        expect(
          written[name],
          `${pull.connectorId}/${pull.rawRunId}/${name}`,
        ).toBe(recorded[name]);
      }
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  test("rebuild deterministically from build-fixtures.mjs", async () => {
    const committed = path.join(benchmarksDir, benchmark);
    const rebuilt = await tempDir("openwiki-personal-rebuild-");
    execFileSync(process.execPath, [
      path.join(committed, "build-fixtures.mjs"),
      rebuilt,
    ]);

    const tree = async (root: string): Promise<Record<string, string>> => {
      const files: Record<string, string> = {};
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const absolute = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(absolute);
          } else if (entry.name !== "build-fixtures.mjs") {
            files[path.relative(root, absolute)] = await readFile(
              absolute,
              "utf8",
            );
          }
        }
      };
      await walk(root);
      return files;
    };

    expect(await tree(rebuilt)).toEqual(await tree(committed));
  });
});
