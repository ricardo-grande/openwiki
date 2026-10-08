import { wikiDirFor } from "../core/paths.js";
import type { RepositoryBenchmark, StructuralCheck } from "../core/types.js";
import { GitReplay } from "./git-replay.js";

/**
 * The runner's view of a replay: one materialized source root that advances
 * through a benchmark trace, the wiki directory the System Under Test writes,
 * and the root its source evidence is read from. Implemented by the Git
 * worktree replay (repository benchmarks) and the raw-timeline replay
 * (personal benchmarks).
 */
export interface CheckpointReplay {
  /**
   * Absolute path handed to `SystemUnderTest.init` and `update`.
   */
  readonly rootDir: string;

  /**
   * Absolute path of the wiki directory captured as the artifact.
   */
  readonly wikiDir: string;

  /**
   * Absolute path handed to the source evidence adapter.
   */
  readonly evidenceRoot: string;

  /**
   * Validate the whole trace before any system runs.
   */
  preflight(): Promise<void>;

  /**
   * Materialize the source at a checkpoint, before the system runs there.
   *
   * @param index - Zero-based checkpoint position.
   */
  advanceTo(index: number): Promise<void>;

  /**
   * Model-free structural checks on the system's output at a checkpoint, run
   * after the system and before evaluation.
   *
   * @default undefined the replay defines no structural checks
   */
  structuralChecks?(index: number): Promise<StructuralCheck[]>;

  /**
   * Release replay resources. Never throws.
   */
  teardown(): Promise<void>;
}

/**
 * Repository replay: a guarded Git worktree checked out at each commit.
 */
export class GitCheckpointReplay implements CheckpointReplay {
  private constructor(
    private readonly benchmark: RepositoryBenchmark,
    private readonly replay: GitReplay,
  ) {}

  /**
   * Create the private clone and worktree at the trace's first commit.
   *
   * @param benchmark - The repository benchmark.
   * @param worktreeParent - Workspace directory to create the worktree under.
   *
   * @returns The ready replay.
   */
  static async create(
    benchmark: RepositoryBenchmark,
    worktreeParent: string,
  ): Promise<GitCheckpointReplay> {
    const replay = await GitReplay.create(
      benchmark.sourceRepoPath,
      worktreeParent,
      benchmark.trace.checkpoints[0].commit,
    );

    return new GitCheckpointReplay(benchmark, replay);
  }

  get rootDir(): string {
    return this.replay.worktreeDir;
  }

  get wikiDir(): string {
    return wikiDirFor(this.replay.worktreeDir);
  }

  get evidenceRoot(): string {
    return this.replay.worktreeDir;
  }

  /**
   * Check that every checkpoint SHA resolves to a commit, each checkpoint is a
   * Git ancestor of the next, and no checkpoint tracks the wiki directory.
   */
  async preflight(): Promise<void> {
    const checkpoints = this.benchmark.trace.checkpoints;

    for (let i = 0; i < checkpoints.length; i += 1) {
      const checkpoint = checkpoints[i];

      await this.replay.assertCommitResolves(checkpoint.commit);

      if (i > 0) {
        await this.replay.assertAncestor(
          checkpoints[i - 1].commit,
          checkpoint.commit,
        );
      }

      await this.replay.assertWikiNotTrackedAt(checkpoint.commit);
    }
  }

  async advanceTo(index: number): Promise<void> {
    if (index > 0) {
      await this.replay.checkout(
        this.benchmark.trace.checkpoints[index].commit,
      );
    }
  }

  async teardown(): Promise<void> {
    await this.replay.teardown();
  }
}
