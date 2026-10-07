// Shared deterministic helpers for the personal LEDGER benchmark builders
// (`inbox-week/build-fixtures.mjs`, `cross-source/build-fixtures.mjs`).
//
// Every fixture file is written in exactly the shape and key order the real
// OpenWiki connector writes for the same Gmail or Slack API responses
// (`src/connectors/sources/gmail.ts`, `slack.ts`): API objects pass through
// verbatim and the connector-built wrappers are reproduced field for field.
// `evals/ledger/benchmarks/personal-fixtures.test.ts` proves it by inverting
// each file back into API responses, running the real connector against them
// with a stubbed fetch, and requiring byte-identical output.
//
// All people, companies, and messages are synthetic. Domains use the reserved
// `example.com`/`example.net` names.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Connector defaults the wrappers echo (gmail.ts and slack.ts). */
export const GMAIL_DEFAULTS = {
  format: "full",
  maxMessages: 100,
  query: "newer_than:1d",
  windowHours: 24,
};

export const SLACK_DEFAULTS = {
  conversationScanLimit: 500,
  conversationTypes: ["public_channel", "private_channel", "im", "mpim"],
  maxConversations: 50,
  messagesPerConversation: 50,
  myMessagesSearchLimit: 20,
};

/**
 * Raw run directory name for an ISO instant (the connectors' `createRunId`).
 *
 * @param {string} iso - ISO-8601 instant.
 * @returns {string} The run id.
 */
export function runIdFromIso(iso) {
  return iso.replace(/[:.]/gu, "-");
}

/**
 * Stable short hex id derived from a seed string.
 *
 * @param {string} seed - Seed text.
 * @param {number} [length] - Hex characters to keep.
 * @returns {string} The id.
 */
export function stableId(seed, length = 16) {
  return createHash("sha256").update(seed).digest("hex").slice(0, length);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * RFC 2822 date header in UTC, for example `Mon, 02 Mar 2026 09:14:00 +0000`.
 *
 * @param {string} iso - ISO-8601 instant.
 * @returns {string} The header value.
 */
export function rfc2822(iso) {
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, "0");
  return `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

/**
 * Format a mailbox as `Name <address>`.
 *
 * @param {{ name: string, email: string }} person - The person.
 * @returns {string} The mailbox.
 */
export function mailbox(person) {
  return `${person.name} <${person.email}>`;
}

/**
 * One Gmail API message in `format=full`, with a single `text/plain` part.
 *
 * @param {object} spec - Message spec.
 * @param {string} spec.key - Stable seed for ids.
 * @param {string} [spec.thread] - Thread seed; defaults to `key`.
 * @param {{ name: string, email: string }} spec.from - Sender.
 * @param {Array<{ name: string, email: string }>} spec.to - Recipients.
 * @param {Array<{ name: string, email: string }>} [spec.cc] - Cc recipients.
 * @param {string} spec.subject - Subject line.
 * @param {string} spec.date - ISO-8601 send time.
 * @param {string} spec.body - Plain-text body.
 * @param {string[]} spec.labels - Gmail label ids.
 * @returns {object} The API message.
 */
export function gmailMessage(spec) {
  const id = stableId(`gmail:${spec.key}`);
  const threadId = stableId(`gmail-thread:${spec.thread ?? spec.key}`);
  const body = spec.body.trim();
  const data = Buffer.from(body, "utf8").toString("base64url");
  const headers = [
    { name: "From", value: mailbox(spec.from) },
    { name: "To", value: spec.to.map(mailbox).join(", ") },
    ...(spec.cc?.length
      ? [{ name: "Cc", value: spec.cc.map(mailbox).join(", ") }]
      : []),
    { name: "Subject", value: spec.subject },
    { name: "Date", value: rfc2822(spec.date) },
    { name: "Message-ID", value: `<${id}@mail.example.com>` },
  ];
  const size = Buffer.byteLength(body, "utf8");

  return {
    id,
    threadId,
    labelIds: spec.labels,
    snippet: body.replace(/\s+/gu, " ").slice(0, 120),
    payload: {
      partId: "",
      mimeType: "multipart/alternative",
      filename: "",
      headers,
      body: { size: 0 },
      parts: [
        {
          partId: "0",
          mimeType: "text/plain",
          filename: "",
          headers: [
            { name: "Content-Type", value: 'text/plain; charset="UTF-8"' },
          ],
          body: { size, data },
        },
      ],
    },
    sizeEstimate: 900 + size,
    historyId: String(100000 + (Number.parseInt(id.slice(0, 6), 16) % 900000)),
    internalDate: String(Date.parse(spec.date)),
  };
}

/**
 * The `gmail-messages.json` dump the Gmail connector writes for a pull, with
 * messages newest first as the Gmail list API returns them.
 *
 * @param {string} fetchedAt - ISO-8601 pull time.
 * @param {object[]} messages - Gmail API messages.
 * @returns {object} The dump.
 */
export function gmailDump(fetchedAt, messages) {
  const ordered = [...messages].sort(
    (a, b) => Number(b.internalDate) - Number(a.internalDate),
  );
  return {
    fetchedAt,
    format: GMAIL_DEFAULTS.format,
    includeSpamTrash: false,
    labelIds: [],
    listPages: [
      { messageCount: ordered.length, resultSizeEstimate: ordered.length },
    ],
    maxMessages: GMAIL_DEFAULTS.maxMessages,
    messageCount: ordered.length,
    messages: ordered,
    query: GMAIL_DEFAULTS.query,
    windowHours: GMAIL_DEFAULTS.windowHours,
  };
}

/**
 * Slack message timestamp for an ISO instant plus a sequence suffix.
 *
 * @param {string} iso - ISO-8601 instant.
 * @param {number} [sequence] - Disambiguating microsecond suffix.
 * @returns {string} The Slack `ts`.
 */
export function slackTs(iso, sequence = 100) {
  return `${Math.floor(Date.parse(iso) / 1000)}.${String(sequence).padStart(6, "0")}`;
}

/**
 * One Slack `conversations.history` message.
 *
 * @param {object} spec - Message spec.
 * @param {{ id: string, name: string, display: string }} spec.author - Author.
 * @param {string} spec.date - ISO-8601 send time.
 * @param {string} spec.text - Message text.
 * @param {number} [spec.sequence] - `ts` suffix for same-second messages.
 * @param {string} [spec.threadTs] - Parent `ts` for a thread reply.
 * @returns {object} The API message.
 */
export function slackMessage(spec) {
  const ts = slackTs(spec.date, spec.sequence);
  return {
    type: "message",
    user: spec.author.id,
    text: spec.text,
    ts,
    ...(spec.threadTs !== undefined ? { thread_ts: spec.threadTs } : {}),
    user_profile: {
      real_name: spec.author.name,
      display_name: spec.author.display,
    },
  };
}

/** Narrow a conversation to the fields the connector copies per message. */
function conversationRef(conversation) {
  return {
    id: conversation.id,
    is_im: conversation.is_im,
    is_mpim: conversation.is_mpim,
    name: conversation.name,
  };
}

/** Sort user messages by `ts` descending, stably (compareSlackUserMessages). */
function byTsDesc(entries) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        Number(b.entry.message.ts) - Number(a.entry.message.ts) ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);
}

/**
 * Every file the Slack connector writes for one pull with its default streams
 * (`my_messages_search`, `recent_messages`).
 *
 * @param {object} spec - Pull spec.
 * @param {string} spec.fetchedAt - ISO-8601 pull time.
 * @param {{ name: string, id: string, url: string }} spec.team - Workspace.
 * @param {object} spec.user - `users.info` user object for the connected user.
 * @param {Array<{ conversation: object, messages: object[] }>} spec.conversations
 *   - Conversations with their full history, any order.
 * @returns {Record<string, object>} File name to content.
 */
export function slackPull(spec) {
  const userId = spec.user.id;
  const conversations = spec.conversations
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        (b.entry.conversation.updated ?? 0) -
          (a.entry.conversation.updated ?? 0) || a.index - b.index,
    )
    .map(({ entry }) => entry)
    .slice(0, SLACK_DEFAULTS.maxConversations)
    .map(({ conversation, messages }) => {
      const history = [...messages]
        .sort((a, b) => Number(b.ts) - Number(a.ts))
        .slice(0, SLACK_DEFAULTS.messagesPerConversation);
      return {
        conversation,
        messages: history,
        userMessages: history.filter((message) => message.user === userId),
      };
    });

  const recentUserMessages = byTsDesc(
    conversations.flatMap(({ conversation, userMessages }) =>
      userMessages.map((message) => ({
        conversation: conversationRef(conversation),
        message,
      })),
    ),
  );

  const allMatches = byTsDesc(
    spec.conversations.flatMap(({ conversation, messages }) =>
      messages
        .filter((message) => message.user === userId)
        .map((message) => ({
          conversation: conversationRef(conversation),
          message: {
            type: "message",
            user: message.user,
            username: spec.user.name,
            ts: message.ts,
            text: message.text,
            permalink: `${spec.team.url}archives/${conversation.id}/p${message.ts.replace(".", "")}`,
            channel: conversationRef(conversation),
          },
        })),
    ),
  );
  const searchUserMessages = allMatches.slice(
    0,
    SLACK_DEFAULTS.myMessagesSearchLimit,
  );

  const searchCoverage = {
    limit: SLACK_DEFAULTS.myMessagesSearchLimit,
    note: "Slack search.messages query for the authenticated user's messages, sorted by timestamp descending.",
    query: `from:<@${userId}>`,
    resultCount: searchUserMessages.length,
    source: "search.messages",
    sort: "timestamp_desc",
    total: allMatches.length,
  };
  const recentCoverage = {
    conversationScanLimit: SLACK_DEFAULTS.conversationScanLimit,
    conversationTypes: SLACK_DEFAULTS.conversationTypes,
    hasMoreAfterScan: false,
    maxConversations: SLACK_DEFAULTS.maxConversations,
    messagesPerConversation: SLACK_DEFAULTS.messagesPerConversation,
    note: "Bounded recent conversation history. Slack conversations are scanned first, sorted by updated timestamp descending, then the selected conversations' recent histories are fetched.",
    scannedConversationCount: spec.conversations.length,
    selectedConversationCount: conversations.length,
    sort: "updated_desc",
    source: "conversations.history",
  };
  const fromSearch = searchUserMessages.length > 0;
  const latestMessages = fromSearch ? searchUserMessages : recentUserMessages;
  const latestSource = fromSearch ? "search.messages" : "conversations.history";

  return {
    "identity.json": {
      fetchedAt: spec.fetchedAt,
      team: spec.team.name,
      teamId: spec.team.id,
      teamUrl: spec.team.url,
      user: spec.user,
      userId,
    },
    "my-messages-search.json": {
      coverage: searchCoverage,
      fetchedAt: spec.fetchedAt,
      latestMessage: searchUserMessages[0] ?? null,
      user: spec.user,
      userId,
      userMessages: searchUserMessages,
    },
    "recent-messages.json": {
      coverage: recentCoverage,
      fetchedAt: spec.fetchedAt,
      userId,
      conversations,
      userMessages: recentUserMessages,
    },
    "my-recent-messages.json": {
      coverage: {
        definitiveForLatestMessage: fromSearch,
        latestMessageSource: latestSource,
        recent: recentCoverage,
        search: searchCoverage,
      },
      definitiveForLatestMessage: fromSearch,
      fetchedAt: spec.fetchedAt,
      latestMessage: latestMessages[0] ?? null,
      note: fromSearch
        ? "latestMessage is computed from Slack search.messages sorted by timestamp descending for the authenticated user."
        : "latestMessage is only the latest authenticated-user message found in bounded conversations.history fallback data. It is not a reliable global answer for the user's true latest Slack message. Add the Slack user-token search:read scope and rerun openwiki auth slack to enable definitive self-message search.",
      recentUserMessages,
      searchUserMessages,
      source: latestSource,
      user: spec.user,
      userId,
      userMessages: latestMessages,
    },
  };
}

/**
 * Serialize JSON exactly as the connectors' `writePrivateJson` does.
 *
 * @param {unknown} value - Value to serialize.
 * @returns {string} Two-space indented JSON with a trailing newline.
 */
export function connectorJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Recreate a benchmark's `raw/` directory and write every pull, the trap
 * manifest, and the benchmark manifest.
 *
 * @param {string} benchmarkDir - Benchmark directory.
 * @param {object} output - What to write.
 * @param {object} output.benchmark - `benchmark.json` content.
 * @param {object} output.traps - `traps.json` content.
 * @param {Array<{ connectorId: string, rawRunId: string, files: Record<string, unknown> }>} output.pulls
 *   - Recorded pulls.
 */
export function writeBenchmark(benchmarkDir, { benchmark, traps, pulls }) {
  const rawRoot = path.join(benchmarkDir, "raw");
  rmSync(rawRoot, { recursive: true, force: true });

  for (const pull of pulls) {
    const runDir = path.join(rawRoot, pull.connectorId, pull.rawRunId);
    mkdirSync(runDir, { recursive: true });
    for (const [name, value] of Object.entries(pull.files)) {
      writeFileSync(path.join(runDir, name), connectorJson(value));
    }
  }

  writeFileSync(
    path.join(benchmarkDir, "benchmark.json"),
    connectorJson(benchmark),
  );
  writeFileSync(path.join(benchmarkDir, "traps.json"), connectorJson(traps));
}
