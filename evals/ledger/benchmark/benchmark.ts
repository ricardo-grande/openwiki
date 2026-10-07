import { readFile } from "node:fs/promises";
import path from "node:path";

import { BenchmarkValidationError } from "../core/errors.js";
import type {
  BenchmarkDifficulty,
  LedgerBenchmark,
  PersonalBenchmark,
  PersonalTrapManifest,
  RepositoryBenchmark,
} from "../core/types.js";
import { validatePersonalRawFixtures } from "./personal-validation.js";
import { ensureSourceRepoAvailable } from "./source-repo.js";
import { validateBenchmark, validateEvidenceMapSources } from "./validation.js";

/**
 * Name of the manifest file inside a benchmark directory.
 */
const BENCHMARK_FILE = "benchmark.json";

/**
 * Name of a personal benchmark's evaluator-only trap manifest.
 */
const TRAPS_FILE = "traps.json";

/**
 * Name of a personal benchmark's recorded-pull fixture directory.
 */
const RAW_DIR = "raw";

/**
 * The difficulty labels a benchmark manifest may declare, in ascending order.
 * Used as the allowlist the untrusted `difficulty` field is checked against.
 */
const DIFFICULTIES: readonly BenchmarkDifficulty[] = ["easy", "medium", "hard"];

/**
 * Optional benchmark-loading behavior for callers that do not replay source.
 */
export interface LoadBenchmarkOptions {
  /**
   * Whether to reconstruct a missing Git source repository from its committed
   * bundle.
   *
   * @default true
   */
  ensureSourceRepo?: boolean;
}

/**
 * Raw on-disk shape of `benchmark.json`, before path resolution and validation.
 * Kept separate from `LedgerBenchmark` because the file stores a relative
 * `sourceRepo` while the domain type stores an absolute `sourceRepoPath`.
 *
 * Every field is optional and typed `unknown` on purpose: the file is untrusted
 * input, so neither the presence nor the type of any key is assumed until
 * `loadBenchmark` and `validateBenchmark` have checked it.
 */
interface RawBenchmark {
  /**
   * Benchmark kind. Typed `unknown` because the raw file is untrusted until
   * checked.
   *
   * @default "repository" when absent
   */
  kind?: unknown;

  /**
   * Personal benchmarks only: the user's wiki brief.
   */
  wikiGoal?: unknown;

  /**
   * Personal benchmarks only: the connected sources.
   */
  connectors?: unknown;

  /**
   * Human-readable benchmark name for reports. Typed `unknown` because the raw
   * file is untrusted until checked.
   *
   * @default an empty string when absent or not a string, since the name is
   *   only cosmetic
   */
  name?: unknown;

  /**
   * Free-text description of what the benchmark exercises, for reports. Typed
   * `unknown` because the raw file is untrusted until checked.
   *
   * @default an empty string when absent or not a string, since the description
   *   is only cosmetic
   */
  description?: unknown;

  /**
   * Author-declared difficulty rating. Typed `unknown` because the raw file is
   * untrusted until checked.
   *
   * @default no fallback; an absent or unrecognized value is rejected with a
   *   `BenchmarkValidationError` so every benchmark declares an explicit rating
   */
  difficulty?: unknown;

  /**
   * Path to the repository the benchmark replays, written relative to the
   * benchmark directory. `loadBenchmark` resolves it against that directory into
   * the absolute `sourceRepoPath` on `LedgerBenchmark`.
   *
   * @default no fallback; an absent, non-string, or empty value is rejected with
   *   a `BenchmarkValidationError` before any path resolution
   */
  sourceRepo?: unknown;

  /**
   * Ordered checkpoint sequence to replay. Passed straight to
   * `validateBenchmark`, whose deep structural checks make the later cast to
   * `LedgerBenchmark["trace"]` sound; no shape is assumed here.
   *
   * @default no fallback; `validateBenchmark` rejects an absent or malformed
   *   trace with a `BenchmarkValidationError`
   */
  trace?: unknown;

  /**
   * Optional evaluator-only semantic routing metadata. Deep validation happens
   * in `validateBenchmark` alongside the trace checks.
   */
  evidenceMap?: unknown;
}

/**
 * Load, resolve, and validate the benchmark in `benchmarkDir`.
 *
 * @param benchmarkDir - Absolute path to the directory containing
 *   `benchmark.json`.
 * @param options - Optional source-materialization behavior.
 *
 * @returns The validated benchmark with `sourceRepoPath` resolved to an absolute
 *   path.
 *
 * @throws BenchmarkValidationError when the file is missing, unparseable, or
 *   fails an integrity check.
 */
export async function loadBenchmark(
  benchmarkDir: string,
  options: LoadBenchmarkOptions = {},
): Promise<LedgerBenchmark> {
  const file = path.join(benchmarkDir, BENCHMARK_FILE);

  let raw: RawBenchmark;

  try {
    raw = JSON.parse(await readFile(file, "utf8")) as RawBenchmark;
  } catch (error) {
    throw new BenchmarkValidationError(
      `Could not read or parse ${file}: ${(error as Error).message}`,
    );
  }

  if (
    typeof raw.difficulty !== "string" ||
    !DIFFICULTIES.includes(raw.difficulty as BenchmarkDifficulty)
  ) {
    throw new BenchmarkValidationError(
      `${file}: "difficulty" must be one of ${DIFFICULTIES.join(", ")}.`,
    );
  }
  const difficulty = raw.difficulty as BenchmarkDifficulty;
  const name = typeof raw.name === "string" ? raw.name : "";
  const description =
    typeof raw.description === "string" ? raw.description : "";

  if (raw.kind === "personal") {
    return loadPersonalBenchmark(benchmarkDir, raw, {
      name,
      description,
      difficulty,
    });
  }

  if (raw.kind !== undefined && raw.kind !== "repository") {
    throw new BenchmarkValidationError(
      `${file}: "kind" must be "repository" or "personal".`,
    );
  }

  if (typeof raw.sourceRepo !== "string" || raw.sourceRepo.length === 0) {
    throw new BenchmarkValidationError(
      `${file}: "sourceRepo" must be a non-empty string.`,
    );
  }

  const sourceRepoPath = path.resolve(benchmarkDir, raw.sourceRepo);

  // Reconstruct the source working tree from its committed bundle when a fresh
  // checkout left it absent. A no-op for benchmarks that ship a real repository.
  if (options.ensureSourceRepo !== false) {
    await ensureSourceRepoAvailable(benchmarkDir, sourceRepoPath);
  }

  const benchmark: RepositoryBenchmark = {
    name,
    description,
    difficulty,
    sourceRepoPath,
    evidenceMap: raw.evidenceMap as RepositoryBenchmark["evidenceMap"],
    // Cast is deliberate: validateBenchmark performs the deep structural checks
    // that make this cast sound, and throws before the value is used otherwise.
    trace: raw.trace as RepositoryBenchmark["trace"],
  };

  validateBenchmark(benchmark);
  if (options.ensureSourceRepo !== false) {
    await validateEvidenceMapSources(benchmark);
  }

  return benchmark;
}

/**
 * Assemble and validate a personal benchmark: read its evaluator-only trap
 * manifest, resolve its `raw/` fixture root, and confirm every pull's fixture
 * directory exists.
 *
 * @param benchmarkDir - Absolute benchmark directory.
 * @param raw - The parsed, untrusted manifest.
 * @param common - Already-checked cosmetic fields and difficulty.
 *
 * @returns The validated personal benchmark.
 *
 * @throws BenchmarkValidationError when the trap manifest is missing or the
 *   benchmark fails an integrity check.
 */
async function loadPersonalBenchmark(
  benchmarkDir: string,
  raw: RawBenchmark,
  common: Pick<PersonalBenchmark, "name" | "description" | "difficulty">,
): Promise<PersonalBenchmark> {
  if (raw.sourceRepo !== undefined) {
    throw new BenchmarkValidationError(
      `A personal benchmark must not declare "sourceRepo".`,
    );
  }

  const trapsFile = path.join(benchmarkDir, TRAPS_FILE);
  let traps: PersonalTrapManifest;

  try {
    traps = JSON.parse(
      await readFile(trapsFile, "utf8"),
    ) as PersonalTrapManifest;
  } catch (error) {
    throw new BenchmarkValidationError(
      `Could not read or parse ${trapsFile}: ${(error as Error).message}`,
    );
  }

  // Casts are deliberate: validateBenchmark performs the deep structural checks
  // that make them sound, and throws before the values are used otherwise.
  const benchmark: PersonalBenchmark = {
    ...common,
    kind: "personal",
    rawRoot: path.join(benchmarkDir, RAW_DIR),
    wikiGoal: raw.wikiGoal as string,
    connectors: raw.connectors as PersonalBenchmark["connectors"],
    evidenceMap: raw.evidenceMap as PersonalBenchmark["evidenceMap"],
    trace: raw.trace as PersonalBenchmark["trace"],
    traps,
  };

  validateBenchmark(benchmark);
  await validatePersonalRawFixtures(benchmark);

  return benchmark;
}
