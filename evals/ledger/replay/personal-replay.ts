import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { assertContained } from "../core/paths.js";
import { WorktreeSafetyError } from "../core/errors.js";
import type { PersonalBenchmark, StructuralCheck } from "../core/types.js";
import { onboardingInstant } from "../benchmark/personal.js";
import {
  diffSnapshots,
  readTreeFiles,
  runPersonalStructuralChecks,
  snapshotTree,
  type TreeSnapshot,
} from "../metrics/structural.js";
import {
  PENDING_PULLS_FILE,
  type PendingPulls,
} from "../system/personal-protocol.js";
import type { CheckpointReplay } from "./checkpoint-replay.js";
import { assertContainedByRealpath } from "./workspace.js";

/**
 * Directory name of the temporary OpenWiki home inside the replay parent.
 */
const HOME_DIR = "home";

/**
 * Whether a home-relative path is written by OpenWiki itself during a normal
 * run, and therefore excluded from the home-isolation check: the wiki, the
 * connectors' raw data, state, and logs, the skills and conversation-history
 * directories, scheduler logs, the agent checkpoint database, and the
 * telemetry install id.
 *
 * @param relativePath - POSIX path relative to the home.
 *
 * @returns True when changes under the path are expected.
 */
export function isOpenWikiOwnedHomePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const [top] = segments;

  if (
    top === "wiki" ||
    top === "skills" ||
    top === "conversation_history" ||
    top === "logs"
  ) {
    return true;
  }

  if (segments.length === 1) {
    return top.startsWith("openwiki.sqlite") || top === "install-id";
  }

  if (top === "connectors" && segments.length >= 3) {
    const entry = segments[2];
    return (
      entry === "raw" ||
      entry === "logs" ||
      (entry === "state.json" && segments.length === 3)
    );
  }

  return false;
}

/**
 * Create `root/<segments...>` one directory at a time, refusing any existing
 * segment that is not a real directory. The system under test can write
 * anywhere in the home between checkpoints, so a symlinked `connectors/<id>`
 * must not redirect the next pull's files outside the replay.
 *
 * @param root - Existing directory to create beneath.
 * @param segments - Path segments to create.
 *
 * @throws WorktreeSafetyError when a segment exists but is not a directory.
 */
async function mkdirWithoutSymlinks(
  root: string,
  segments: string[],
): Promise<void> {
  let current = root;

  for (const segment of segments) {
    current = path.join(current, segment);

    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory()) {
        throw new WorktreeSafetyError(
          `Refusing to write raw fixtures through non-directory "${current}".`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await mkdir(current, { mode: 0o700 });
    }
  }
}

/**
 * Raw-timeline replay for personal benchmarks. Builds a temporary OpenWiki home
 * holding the onboarding configuration, makes each checkpoint's recorded pulls
 * available under `connectors/<id>/raw/<runId>/`, and tells the system which
 * pulls to ingest through `pending-pulls.json`, a sibling of the home so it is
 * never part of what the system sees. Every write is confined by realpath to
 * the replay directory, so a run never touches the user's `~/.openwiki`.
 */
export class PersonalReplay implements CheckpointReplay {
  /**
   * Home snapshot taken after the checkpoint's pulls were added and before the
   * system ran, excluding OpenWiki-owned paths.
   */
  private homeBefore: TreeSnapshot = new Map();

  private constructor(
    private readonly benchmark: PersonalBenchmark,
    private readonly replayRoot: string,
    private readonly rawRoot: string,
  ) {}

  /**
   * Create the temporary home with its onboarding configuration.
   *
   * @param benchmark - The validated personal benchmark.
   * @param replayParent - Workspace directory to create the home under.
   *
   * @returns The ready replay.
   *
   * @throws WorktreeSafetyError when a path escapes the replay parent.
   */
  static async create(
    benchmark: PersonalBenchmark,
    replayParent: string,
  ): Promise<PersonalReplay> {
    const replayRoot = await realpath(replayParent);
    const home = path.join(replayRoot, HOME_DIR);

    await assertContainedByRealpath(replayRoot, home);
    await mkdir(home, { recursive: true, mode: 0o700 });

    const replay = new PersonalReplay(
      benchmark,
      replayRoot,
      await realpath(benchmark.rawRoot),
    );
    await replay.writeOnboarding();

    return replay;
  }

  /**
   * The temporary OpenWiki home, passed to the system as its root.
   */
  get rootDir(): string {
    return path.join(this.replayRoot, HOME_DIR);
  }

  get wikiDir(): string {
    return path.join(this.rootDir, "wiki");
  }

  /**
   * Evidence is read from the benchmark's own immutable fixtures, never from
   * the home the system can write to.
   */
  get evidenceRoot(): string {
    return this.rawRoot;
  }

  /**
   * Path of the pending-pulls handoff file.
   */
  get pendingPullsPath(): string {
    return path.join(this.replayRoot, PENDING_PULLS_FILE);
  }

  /**
   * Nothing to check up front: the loader already validated the trace and
   * confirmed every pull's fixtures exist.
   */
  async preflight(): Promise<void> {}

  /**
   * Copy the checkpoint's pulls into the home, write the pending-pulls handoff,
   * and snapshot the home for the isolation check.
   *
   * @param index - Zero-based checkpoint position.
   */
  async advanceTo(index: number): Promise<void> {
    const checkpoint = this.benchmark.trace.checkpoints[index];
    const pending: PendingPulls = {
      checkpointId: checkpoint.id,
      command: index === 0 ? "init" : "ingest",
      pulls: [],
    };

    for (const pull of checkpoint.pulls) {
      const connector = this.benchmark.connectors.find(
        (candidate) => candidate.connectorId === pull.connectorId,
      );

      if (connector === undefined) {
        throw new Error(
          `Checkpoint "${checkpoint.id}" pulls unconnected source "${pull.connectorId}".`,
        );
      }

      const files = await this.copyPull(pull.connectorId, pull.rawRunId);
      pending.pulls.push({
        connectorId: pull.connectorId,
        instanceId: connector.instanceId,
        rawRunId: pull.rawRunId,
        files,
      });
    }

    pending.allSources =
      pending.pulls.length === this.benchmark.connectors.length &&
      pending.pulls.length > 0;

    await this.writeContained(
      this.replayRoot,
      this.pendingPullsPath,
      `${JSON.stringify(pending, null, 2)}\n`,
    );
    this.homeBefore = await snapshotTree(this.rootDir, isOpenWikiOwnedHomePath);
  }

  /**
   * Run the model-free personal checks on the system's output.
   *
   * @param index - Zero-based checkpoint position.
   *
   * @returns The structural checks.
   */
  async structuralChecks(index: number): Promise<StructuralCheck[]> {
    void index;
    const homeAfter = await snapshotTree(this.rootDir, isOpenWikiOwnedHomePath);

    return runPersonalStructuralChecks({
      wikiFiles: await readTreeFiles(this.wikiDir),
      traps: this.benchmark.traps,
      unexpectedHomeChanges: diffSnapshots(this.homeBefore, homeAfter),
    });
  }

  /**
   * Nothing to release: the workspace owning the replay directory deletes it.
   */
  async teardown(): Promise<void> {}

  /**
   * Write `onboarding.json` and `INSTRUCTIONS.md` in the shape
   * `saveOpenWikiOnboardingConfig` writes, connecting every source at the
   * start of the first pull's window.
   */
  private async writeOnboarding(): Promise<void> {
    const connectedAt = onboardingInstant(this.benchmark);
    const sourceInstances = this.benchmark.connectors.map((connector) => ({
      connectedAt,
      ...(connector.ingestionGoal !== undefined
        ? { ingestionGoal: connector.ingestionGoal }
        : {}),
      connectorId: connector.connectorId,
      id: connector.instanceId,
      ...(connector.name !== undefined ? { name: connector.name } : {}),
    }));
    const sources = Object.fromEntries(
      this.benchmark.connectors.map((connector) => [
        connector.connectorId,
        {
          connectedAt,
          ...(connector.ingestionGoal !== undefined
            ? { ingestionGoal: connector.ingestionGoal }
            : {}),
        },
      ]),
    );
    const onboarding = {
      sourceInstances,
      sources,
      version: 1,
      completedAt: connectedAt,
      ingestionSchedule: {
        description: "Every day at 07:00",
        expression: "0 7 * * *",
        updatedAt: connectedAt,
      },
    };

    await this.writeContained(
      this.rootDir,
      path.join(this.rootDir, "onboarding.json"),
      `${JSON.stringify(onboarding, null, 2)}\n`,
    );
    await this.writeContained(
      this.rootDir,
      path.join(this.rootDir, "INSTRUCTIONS.md"),
      `${this.benchmark.wikiGoal.trim()}\n`,
    );
  }

  /**
   * Copy one recorded pull into the home's connector raw directory.
   *
   * @param connectorId - Connector id.
   * @param rawRunId - Raw run directory name.
   *
   * @returns The copied file names, sorted.
   *
   * @throws WorktreeSafetyError when a source or destination escapes its root.
   */
  private async copyPull(
    connectorId: string,
    rawRunId: string,
  ): Promise<string[]> {
    const sourceDir = path.join(this.rawRoot, connectorId, rawRunId);
    const destinationDir = path.join(
      this.rootDir,
      "connectors",
      connectorId,
      "raw",
      rawRunId,
    );

    await assertContained(
      this.rawRoot,
      sourceDir,
      (resolved, root) =>
        new WorktreeSafetyError(
          `Refusing to read raw fixtures outside "${root}": "${resolved}".`,
        ),
    );
    await mkdirWithoutSymlinks(this.rootDir, [
      "connectors",
      connectorId,
      "raw",
      rawRunId,
    ]);

    const names = (await readdir(sourceDir)).sort();

    for (const name of names) {
      const source = path.join(sourceDir, name);

      if (!(await lstat(source)).isFile()) {
        throw new WorktreeSafetyError(
          `Raw fixture "${connectorId}/${rawRunId}/${name}" is not a regular file.`,
        );
      }

      const destination = path.join(destinationDir, name);
      await assertContainedByRealpath(this.rootDir, destination);
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      await chmod(destination, 0o600);
    }

    return names;
  }

  /**
   * Write a private file after proving it stays inside `root`.
   */
  private async writeContained(
    root: string,
    filePath: string,
    content: string,
  ): Promise<void> {
    await assertContainedByRealpath(root, filePath);
    await writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
  }
}
