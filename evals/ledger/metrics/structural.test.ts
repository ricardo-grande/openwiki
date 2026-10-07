import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { PersonalTrapManifest } from "../core/types.js";
import {
  diffSnapshots,
  readTreeFiles,
  runPersonalStructuralChecks,
  snapshotTree,
  type WikiFile,
} from "./structural.js";

const TRAPS: PersonalTrapManifest = {
  facts: [],
  canaries: ["LEDGER-CANARY-TEST"],
  noise: [{ id: "newsletter", terms: ["product digest"] }],
  placements: [
    { id: "dentist", terms: ["dentist"], notOnPages: ["commitment"] },
  ],
};

const VALID_PAGE = "---\ntype: page\ntitle: Quickstart\n---\n\n# Quickstart\n";
const LAST_UPDATE = {
  relativePath: ".last-update.json",
  content: '{"status":"complete"}',
};

function checks(wikiFiles: WikiFile[], unexpectedHomeChanges: string[] = []) {
  return Object.fromEntries(
    runPersonalStructuralChecks({
      wikiFiles,
      traps: TRAPS,
      unexpectedHomeChanges,
    }).map((check) => [check.id, check]),
  );
}

describe("runPersonalStructuralChecks", () => {
  test("passes a healthy wiki", () => {
    const result = checks([
      { relativePath: "quickstart.md", content: VALID_PAGE },
      {
        relativePath: "personal-logistics.md",
        content: "---\ntype: page\n---\nDentist on Thursday.\n",
      },
      LAST_UPDATE,
    ]);

    expect(Object.values(result).every((check) => check.passed)).toBe(true);
    expect(Object.keys(result)).toEqual([
      "quickstart",
      "last-update",
      "canaries",
      "home-isolation",
      "noise-pages",
      "placement",
    ]);
  });

  test("reports each failure with its details", () => {
    const result = checks(
      [
        {
          relativePath: "commitments.md",
          content: "No front matter. Dentist Tuesday. LEDGER-CANARY-TEST",
        },
        {
          relativePath: "newsletters/digest.md",
          content: "---\ntype: page\ntitle: The Product Digest\n---\n",
        },
        {
          relativePath: ".last-update.json",
          content: '{"status":"interrupted"}',
        },
      ],
      ["+ stray.txt"],
    );

    expect(result.quickstart.details).toEqual([
      "/quickstart.md is missing",
      "/commitments.md: missing_opening_delimiter",
    ]);
    expect(result["last-update"].details).toEqual(['status is "interrupted"']);
    expect(result.canaries.details).toEqual([
      '/commitments.md contains "LEDGER-CANARY-TEST"',
    ]);
    expect(result["home-isolation"].details).toEqual(["+ stray.txt"]);
    expect(result["noise-pages"].details).toEqual([
      '/newsletters/digest.md is dedicated to noise "newsletter" (product digest)',
    ]);
    expect(result.placement.details).toEqual([
      '/commitments.md mentions "dentist" (dentist)',
    ]);
  });

  test("bounds the details it reports", () => {
    const pages = Array.from({ length: 12 }, (_, index) => ({
      relativePath: `p${String(index).padStart(2, "0")}.md`,
      content: "no front matter",
    }));
    const quickstart = checks([
      { relativePath: "quickstart.md", content: VALID_PAGE },
      ...pages,
    ]).quickstart;

    expect(quickstart.details).toHaveLength(11);
    expect(quickstart.details.at(-1)).toBe("…and 2 more");
  });
});

describe("tree snapshots", () => {
  let root: string;

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("diff added, removed, modified, and relinked files, honoring skips", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ledger-structural-"));
    await mkdir(path.join(root, "wiki"));
    await writeFile(path.join(root, "a.txt"), "a");
    await writeFile(path.join(root, "b.txt"), "b");
    await symlink("/tmp", path.join(root, "link"));
    const skip = (relativePath: string) => relativePath === "wiki";
    const before = await snapshotTree(root, skip);

    await writeFile(path.join(root, "a.txt"), "changed");
    await rm(path.join(root, "b.txt"));
    await writeFile(path.join(root, "c.txt"), "c");
    await writeFile(path.join(root, "wiki", "page.md"), "ignored");
    await rm(path.join(root, "link"));
    await symlink("/etc", path.join(root, "link"));

    expect(diffSnapshots(before, await snapshotTree(root, skip))).toEqual([
      "~ a.txt",
      "- b.txt",
      "+ c.txt",
      "~ link",
    ]);
    expect(
      (await readTreeFiles(root)).map((file) => file.relativePath),
    ).toEqual(["a.txt", "c.txt", "wiki/page.md"]);
  });
});
