import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  checkpointPosition,
  cumulativePulls,
  onboardingInstant,
} from "../benchmark/personal.js";
import { EvaluationError } from "../core/errors.js";
import { compareStrings } from "../core/order.js";
import { isContainedBy } from "../core/paths.js";
import type {
  EvidenceCorpus,
  EvidenceRecord,
  PersonalBenchmark,
} from "../core/types.js";
import type { SourceEvidenceAdapter } from "./source-adapter.js";

/**
 * One normalized raw item before it is stamped with checkpoint metadata.
 */
interface RawItem {
  /**
   * `raw://<connectorId>/<rawRunId>/<file>#<pointer>` reference.
   */
  sourceRef: string;

  /**
   * Normalized, human-readable item text.
   */
  content: string;

  /**
   * ISO-8601 time the item was sent or written.
   *
   * @default absent when the item carries no usable date
   */
  sourceDate?: string;

  /**
   * Identity of the underlying item (a Gmail message id, a Slack channel and
   * timestamp). Connectors re-deliver items across pulls (Slack history,
   * overlapping Gmail windows); only the first delivery becomes evidence.
   *
   * @default the sourceRef, so the item is never deduplicated
   */
  dedupeKey?: string;
}

/**
 * Gmail headers rendered into evidence, in display order.
 */
const GMAIL_HEADERS = ["From", "To", "Cc", "Subject", "Date"];

/**
 * Files read first within a pull, so the richest copy of a re-delivered item is
 * the one kept: Slack history messages carry the author's profile name, search
 * matches only a username.
 */
const FILE_PRIORITY = ["identity.json", "recent-messages.json"];

/**
 * Order a pull's files for reading: priority files first, then by name.
 */
function readOrder(fileNames: string[]): string[] {
  const rank = (name: string): number => {
    const position = FILE_PRIORITY.indexOf(name);
    return position === -1 ? FILE_PRIORITY.length : position;
  };

  return [...fileNames].sort(
    (a, b) => rank(a) - rank(b) || compareStrings(a, b),
  );
}

/**
 * Narrow an unknown JSON value to a plain object.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Narrow an unknown JSON value to an array.
 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Narrow an unknown JSON value to a string.
 */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Convert a millisecond epoch or parseable date string to ISO-8601.
 */
function toIso(value: number | string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Decode Gmail's base64url body data.
 */
function decodeBase64Url(data: string): string {
  return Buffer.from(
    data.replace(/-/gu, "+").replace(/_/gu, "/"),
    "base64",
  ).toString("utf8");
}

/**
 * Strip HTML to readable text, for messages without a `text/plain` part.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/giu, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * Collect the decoded bodies of every part with a given MIME type, depth first.
 */
function collectBodies(
  part: Record<string, unknown> | undefined,
  mimeType: string,
): string[] {
  if (part === undefined) {
    return [];
  }

  const bodies: string[] = [];
  const data = asString(asRecord(part.body)?.data);

  if (asString(part.mimeType) === mimeType && data !== undefined) {
    bodies.push(decodeBase64Url(data));
  }

  for (const child of asArray(part.parts)) {
    bodies.push(...collectBodies(asRecord(child), mimeType));
  }

  return bodies;
}

/**
 * Normalize one Gmail API message (format `full` or `metadata`).
 */
function normalizeGmailMessage(message: Record<string, unknown>): {
  content: string;
  sourceDate?: string;
} {
  const payload = asRecord(message.payload);
  const headers = new Map<string, string>();

  for (const header of asArray(payload?.headers)) {
    const entry = asRecord(header);
    const name = asString(entry?.name);
    const value = asString(entry?.value);
    if (
      name !== undefined &&
      value !== undefined &&
      !headers.has(name.toLowerCase())
    ) {
      headers.set(name.toLowerCase(), value);
    }
  }

  const internalDate = asString(message.internalDate);
  const sourceDate =
    toIso(internalDate === undefined ? undefined : Number(internalDate)) ??
    toIso(headers.get("date"));
  const plain = collectBodies(payload, "text/plain");
  const body =
    plain.length > 0
      ? plain.join("\n\n")
      : collectBodies(payload, "text/html").map(htmlToText).join("\n\n") ||
        (asString(message.snippet) ?? "");
  const labels = asArray(message.labelIds).filter(
    (label): label is string => typeof label === "string",
  );
  const id = asString(message.id);
  const threadId = asString(message.threadId);
  const lines = [
    "Gmail message",
    ...(id !== undefined ? [`Message id: ${id}`] : []),
    ...(threadId !== undefined ? [`Thread id: ${threadId}`] : []),
    ...(sourceDate !== undefined ? [`Sent: ${sourceDate}`] : []),
    ...GMAIL_HEADERS.flatMap((name) => {
      const value = headers.get(name.toLowerCase());
      return value === undefined ? [] : [`${name}: ${value}`];
    }),
    ...(labels.length > 0 ? [`Labels: ${labels.join(", ")}`] : []),
    "",
    body.trim(),
  ];

  return { content: lines.join("\n"), sourceDate };
}

/**
 * Display name for a Slack message author.
 */
function slackAuthor(message: Record<string, unknown>): string {
  const profile = asRecord(message.user_profile);
  const name =
    asString(profile?.real_name) ??
    asString(profile?.display_name) ??
    asString(message.username);
  const user = asString(message.user);

  if (name !== undefined && user !== undefined) {
    return `${name} (${user})`;
  }

  return name ?? user ?? "unknown";
}

/**
 * Normalize one Slack message in a named conversation.
 */
function normalizeSlackMessage(
  message: Record<string, unknown>,
  conversation: Record<string, unknown> | undefined,
): { content: string; sourceDate?: string } {
  const ts = asString(message.ts);
  const sourceDate = ts === undefined ? undefined : toIso(Number(ts) * 1000);
  const channel =
    asString(conversation?.name) ??
    (conversation?.is_im === true ? "direct message" : undefined) ??
    asString(conversation?.id) ??
    "unknown conversation";
  const thread = asString(message.thread_ts);
  const channelId = asString(conversation?.id);
  const lines = [
    "Slack message",
    ...(ts !== undefined ? [`Message ts: ${ts}`] : []),
    ...(sourceDate !== undefined ? [`Sent: ${sourceDate}`] : []),
    `Conversation: ${channel}${channelId !== undefined && channelId !== channel ? ` (${channelId})` : ""}`,
    `From: ${slackAuthor(message)}`,
    ...(thread !== undefined && thread !== ts ? [`In thread: ${thread}`] : []),
    "",
    (asString(message.text) ?? "").trim(),
  ];

  return { content: lines.join("\n"), sourceDate };
}

/**
 * Normalize every item in one recorded raw file.
 *
 * @param connectorId - Connector that wrote the file.
 * @param rawRunId - Raw run directory name.
 * @param fileName - File name inside the run directory.
 * @param value - Parsed JSON content.
 *
 * @returns The file's items. Files with no item-level content (for example
 *   Slack's derived `my-recent-messages.json`) yield none. The same item can
 *   appear in several files; callers deduplicate by `dedupeKey`.
 */
export function normalizeRawFile(
  connectorId: string,
  rawRunId: string,
  fileName: string,
  value: unknown,
): RawItem[] {
  const root = asRecord(value);
  const ref = (pointer: string): string =>
    `raw://${connectorId}/${rawRunId}/${fileName}#${pointer}`;
  const items: RawItem[] = [];

  if (root === undefined) {
    return items;
  }

  if (connectorId === "google" && fileName === "gmail-messages.json") {
    asArray(root.messages).forEach((message, index) => {
      const record = asRecord(message);
      if (record !== undefined) {
        items.push({
          sourceRef: ref(`/messages/${index}`),
          dedupeKey: `google:${asString(record.id) ?? `${rawRunId}/${index}`}`,
          ...normalizeGmailMessage(record),
        });
      }
    });
    return items;
  }

  if (connectorId === "slack") {
    const push = (
      pointer: string,
      message: unknown,
      conversation: Record<string, unknown> | undefined,
    ): void => {
      const record = asRecord(message);
      if (record === undefined) {
        return;
      }
      items.push({
        sourceRef: ref(pointer),
        dedupeKey: `slack:${asString(conversation?.id) ?? ""}:${asString(record.ts) ?? `${rawRunId}${pointer}`}`,
        ...normalizeSlackMessage(record, conversation),
      });
    };

    if (fileName === "identity.json") {
      const user = asRecord(root.user);
      const profile = asRecord(user?.profile);
      const name =
        asString(profile?.real_name) ??
        asString(user?.real_name) ??
        asString(user?.name);
      items.push({
        sourceRef: ref(""),
        dedupeKey: `slack:identity:${asString(root.userId) ?? rawRunId}`,
        content: [
          "Slack identity of the connected user",
          `Workspace: ${asString(root.team) ?? "unknown"}`,
          `User: ${name ?? "unknown"} (${asString(root.userId) ?? "unknown id"})`,
          ...(asString(profile?.title) !== undefined
            ? [`Title: ${asString(profile?.title)}`]
            : []),
        ].join("\n"),
        sourceDate: toIso(asString(root.fetchedAt)),
      });
    } else if (fileName === "recent-messages.json") {
      asArray(root.conversations).forEach((entry, conversationIndex) => {
        const conversation = asRecord(asRecord(entry)?.conversation);
        asArray(asRecord(entry)?.messages).forEach((message, messageIndex) =>
          push(
            `/conversations/${conversationIndex}/messages/${messageIndex}`,
            message,
            conversation,
          ),
        );
      });
    } else if (fileName === "my-messages-search.json") {
      asArray(root.userMessages).forEach((entry, index) => {
        const record = asRecord(entry);
        push(
          `/userMessages/${index}/message`,
          record?.message,
          asRecord(record?.conversation),
        );
      });
    }
  }

  return items;
}

/**
 * Configuration the user gave during onboarding, which the wiki may legitimately
 * restate: the wiki brief and the connected sources.
 */
function configItems(benchmark: PersonalBenchmark): RawItem[] {
  const sourceDate = onboardingInstant(benchmark);

  return [
    {
      sourceRef: "config://INSTRUCTIONS.md",
      content: `User wiki brief (INSTRUCTIONS.md)\n\n${benchmark.wikiGoal.trim()}`,
      sourceDate,
    },
    {
      sourceRef: "config://onboarding.json",
      content: [
        "Connected sources (onboarding.json)",
        ...benchmark.connectors.map(
          (connector) =>
            `- ${connector.name ?? connector.connectorId} (connector ${connector.connectorId}, instance ${connector.instanceId})${
              connector.ingestionGoal !== undefined
                ? `: ${connector.ingestionGoal}`
                : ""
            }`,
        ),
      ].join("\n"),
      sourceDate,
    },
  ];
}

/**
 * Personal source evidence: one record per raw item (one email, one Slack
 * message) across every pull made available up to and including the active
 * checkpoint, plus the onboarding configuration. An item delivered by several
 * pulls or files is kept once, at its first delivery. The corpus is cumulative, so
 * every record is current; the dated-evidence grounding mode lets the newest
 * relevant item decide. Records are read from the benchmark's immutable
 * fixtures, never from the home the system under test writes to.
 */
export class RawEvidenceAdapter implements SourceEvidenceAdapter {
  readonly name = "personal-raw-items";

  /**
   * The corpus already spans every checkpoint so far; the runner adds no
   * historical records.
   */
  readonly cumulative = true;

  constructor(private readonly benchmark: PersonalBenchmark) {}

  /**
   * Collect the cumulative raw-item evidence at a checkpoint.
   *
   * @param checkpointId - Active benchmark checkpoint.
   * @param sourceRoot - The benchmark's `raw/` fixture root.
   *
   * @returns The evidence corpus, ordered by source date then reference.
   *
   * @throws EvaluationError when a fixture path escapes the root or a file is
   *   not valid JSON.
   */
  async collectEvidence(
    checkpointId: string,
    sourceRoot: string,
  ): Promise<EvidenceCorpus> {
    const index = checkpointPosition(this.benchmark, checkpointId);
    const items = configItems(this.benchmark);
    const seen = new Set<string>();

    for (const pull of cumulativePulls(this.benchmark, index)) {
      const runDir = path.join(sourceRoot, pull.connectorId, pull.rawRunId);

      if (!isContainedBy(sourceRoot, runDir)) {
        throw new EvaluationError(
          `Raw pull escapes the fixture root: ${runDir}`,
        );
      }

      for (const fileName of readOrder(await readdir(runDir))) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(
            await readFile(path.join(runDir, fileName), "utf8"),
          );
        } catch (error) {
          throw new EvaluationError(
            `Raw fixture ${pull.connectorId}/${pull.rawRunId}/${fileName} is not valid JSON: ${(error as Error).message}`,
          );
        }
        for (const item of normalizeRawFile(
          pull.connectorId,
          pull.rawRunId,
          fileName,
          parsed,
        )) {
          const key = item.dedupeKey ?? item.sourceRef;
          if (!seen.has(key)) {
            seen.add(key);
            items.push(item);
          }
        }
      }
    }

    const records: EvidenceRecord[] = items
      .map((item) => ({
        evidenceId: item.sourceRef,
        sourceRef: item.sourceRef,
        observedAtCheckpoint: checkpointId,
        current: true,
        content: item.content,
        ...(item.sourceDate !== undefined
          ? { sourceDate: item.sourceDate }
          : {}),
      }))
      .sort(
        (a, b) =>
          compareStrings(a.sourceDate ?? "", b.sourceDate ?? "") ||
          compareStrings(a.sourceRef, b.sourceRef),
      );

    return { checkpointId, records };
  }
}
