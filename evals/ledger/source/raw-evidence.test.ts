import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "vitest";

import { loadBenchmark } from "../benchmark/benchmark.js";
import type { EvidenceCorpus, PersonalBenchmark } from "../core/types.js";
import { normalizeRawFile, RawEvidenceAdapter } from "./raw-evidence.js";

const benchmarksDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../benchmarks",
);

describe("normalizeRawFile", () => {
  test("renders a Gmail message with its headers, date, and decoded body", () => {
    const [item] = normalizeRawFile(
      "google",
      "2026-03-03T07-00-00-000Z",
      "gmail-messages.json",
      {
        messages: [
          {
            id: "abc",
            labelIds: ["INBOX"],
            internalDate: String(Date.parse("2026-03-02T09:12:00.000Z")),
            payload: {
              mimeType: "multipart/alternative",
              headers: [
                { name: "From", value: "Priya <p@example.com>" },
                { name: "Subject", value: "Deck" },
              ],
              parts: [
                {
                  mimeType: "text/plain",
                  body: {
                    data: Buffer.from("Due Thursday.").toString("base64url"),
                  },
                },
              ],
            },
          },
        ],
      },
    );

    expect(item).toEqual({
      sourceRef:
        "raw://google/2026-03-03T07-00-00-000Z/gmail-messages.json#/messages/0",
      dedupeKey: "google:abc",
      sourceDate: "2026-03-02T09:12:00.000Z",
      content:
        "Gmail message\nSent: 2026-03-02T09:12:00.000Z\nFrom: Priya <p@example.com>\nSubject: Deck\nLabels: INBOX\n\nDue Thursday.",
    });
  });

  test("falls back to stripped HTML, then the snippet", () => {
    const html = normalizeRawFile("google", "r", "gmail-messages.json", {
      messages: [
        {
          payload: {
            mimeType: "text/html",
            body: {
              data: Buffer.from("<p>Hello&nbsp;<b>there</b></p>").toString(
                "base64url",
              ),
            },
          },
        },
        { snippet: "Only a snippet" },
      ],
    });

    expect(html[0].content.endsWith("Hello there")).toBe(true);
    expect(html[1].content.endsWith("Only a snippet")).toBe(true);
    expect(html[1].sourceDate).toBeUndefined();
  });

  test("renders Slack history messages with conversation, author, and thread", () => {
    const [item] = normalizeRawFile("slack", "r", "recent-messages.json", {
      conversations: [
        {
          conversation: { id: "C1", name: "atlas" },
          messages: [
            {
              user: "U1",
              ts: "1773050700.000100",
              thread_ts: "1773050000.000100",
              text: "Cutover is March 27.",
              user_profile: { real_name: "Lee Park" },
            },
          ],
        },
      ],
    });

    expect(item.sourceRef).toBe(
      "raw://slack/r/recent-messages.json#/conversations/0/messages/0",
    );
    expect(item.dedupeKey).toBe("slack:C1:1773050700.000100");
    expect(item.sourceDate).toBe(new Date(1773050700000).toISOString());
    expect(item.content).toContain(
      "Conversation: atlas\nFrom: Lee Park (U1)\nIn thread: 1773050000.000100",
    );
  });

  test("ignores derived and unknown files", () => {
    expect(
      normalizeRawFile("slack", "r", "my-recent-messages.json", {
        userMessages: [{}],
      }),
    ).toEqual([]);
    expect(
      normalizeRawFile("google", "r", "other.json", { messages: [{}] }),
    ).toEqual([]);
    expect(
      normalizeRawFile("google", "r", "gmail-messages.json", null),
    ).toEqual([]);
  });
});

describe("RawEvidenceAdapter", () => {
  let benchmark: PersonalBenchmark;
  let corpora: EvidenceCorpus[];

  beforeAll(async () => {
    benchmark = (await loadBenchmark(
      path.join(benchmarksDir, "cross-source"),
    )) as PersonalBenchmark;
    const adapter = new RawEvidenceAdapter(benchmark);
    corpora = [];
    for (const checkpoint of benchmark.trace.checkpoints) {
      corpora.push(
        await adapter.collectEvidence(checkpoint.id, benchmark.rawRoot),
      );
    }
  });

  test("is cumulative and marks every record current", () => {
    const ids = corpora.map(
      (corpus) => new Set(corpus.records.map((record) => record.evidenceId)),
    );

    for (let index = 1; index < ids.length; index += 1) {
      for (const id of ids[index - 1]) {
        expect(ids[index].has(id)).toBe(true);
      }
    }
    expect(
      corpora
        .flatMap((corpus) => corpus.records)
        .every((record) => record.current),
    ).toBe(true);
  });

  test("starts with the onboarding configuration only", () => {
    expect(corpora[0].records.map((record) => record.sourceRef)).toEqual([
      "config://INSTRUCTIONS.md",
      "config://onboarding.json",
    ]);
    expect(corpora[0].records[1].content).toContain(
      "Harbor Slack (connector slack, instance slack)",
    );
  });

  test("keeps a re-delivered Slack message once, from its first pull's history", () => {
    const lee = corpora[4].records.filter((record) =>
      record.content.includes("engineering is targeting Friday, March 27"),
    );

    expect(lee).toHaveLength(1);
    expect(lee[0].sourceRef).toBe(
      "raw://slack/2026-03-10T07-00-00-000Z/recent-messages.json#/conversations/1/messages/2",
    );
    expect(lee[0].content).toContain("From: Lee Park (U0LEEPRK1)");
    // Alex's own message appears in both search and history; history wins.
    const alex = corpora[4].records.filter((record) =>
      record.content.includes("SOC 2 sign-off before"),
    );
    expect(alex).toHaveLength(1);
    expect(alex[0].sourceRef).toContain("recent-messages.json");
  });

  test("orders records by source date", () => {
    const dates = corpora[4].records.map((record) => record.sourceDate ?? "");
    expect(dates).toEqual([...dates].sort());
  });
});
