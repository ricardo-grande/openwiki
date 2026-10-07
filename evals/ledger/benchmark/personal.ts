import type {
  PersonalBenchmark,
  PersonalPull,
  PersonalTrapManifest,
  SurfaceItem,
} from "../core/types.js";
import { makeItem } from "./surface.js";

/**
 * Raw run directory names use the connectors' `createRunId` format: an ISO-8601
 * UTC timestamp with `:` and `.` replaced by `-`.
 */
export const RAW_RUN_ID_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/u;

/**
 * Connector ids accepted from benchmark JSON. Mirrors `assertSafeConnectorId`
 * in `src/config/openwiki-home.ts`.
 */
export const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

/**
 * Source instance ids accepted from benchmark JSON. Mirrors the ingestion
 * target rule in `src/ingestion/ingestion.ts`.
 */
export const SOURCE_INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;

/**
 * Convert a raw run id back to the ISO-8601 instant it was created at.
 *
 * @param rawRunId - Raw run directory name.
 *
 * @returns The ISO-8601 timestamp, or undefined when the id is malformed.
 */
export function rawRunIdToIso(rawRunId: string): string | undefined {
  const match = RAW_RUN_ID_PATTERN.exec(rawRunId);

  if (match === null) {
    return undefined;
  }

  const [, date, hours, minutes, seconds, millis] = match;
  return `${date}T${hours}:${minutes}:${seconds}.${millis}Z`;
}

/**
 * Hours of source data each deterministic pull covers, matching
 * `INGESTION_WINDOW_HOURS` in `src/ingestion/ingestion.ts`.
 */
export const PULL_WINDOW_HOURS = 24;

/**
 * When the replayed user finished onboarding and connected their sources: the
 * start of the earliest pull's window, so every pulled item postdates it.
 *
 * @param benchmark - The personal benchmark.
 *
 * @returns The ISO-8601 instant, or the Unix epoch for a trace with no pulls.
 */
export function onboardingInstant(benchmark: PersonalBenchmark): string {
  const firstRun = benchmark.trace.checkpoints
    .flatMap((checkpoint) => checkpoint.pulls.map((pull) => pull.rawRunId))
    .sort()[0];
  const iso = firstRun === undefined ? undefined : rawRunIdToIso(firstRun);

  return iso === undefined
    ? new Date(0).toISOString()
    : new Date(Date.parse(iso) - PULL_WINDOW_HOURS * 3_600_000).toISOString();
}

/**
 * One pull together with the checkpoint that made it available.
 */
export interface PulledRun extends PersonalPull {
  /**
   * Checkpoint id at which the pull was ingested.
   */
  checkpointId: string;
}

/**
 * Every pull made available up to and including a checkpoint, in trace order.
 *
 * @param benchmark - The personal benchmark.
 * @param index - Zero-based checkpoint position.
 *
 * @returns The cumulative pulls.
 */
export function cumulativePulls(
  benchmark: PersonalBenchmark,
  index: number,
): PulledRun[] {
  return benchmark.trace.checkpoints.slice(0, index + 1).flatMap((checkpoint) =>
    checkpoint.pulls.map((pull) => ({
      ...pull,
      checkpointId: checkpoint.id,
    })),
  );
}

/**
 * Position of a checkpoint id within the trace.
 *
 * @param benchmark - The personal benchmark.
 * @param checkpointId - Checkpoint id to find.
 *
 * @returns The zero-based position.
 *
 * @throws Error when the id is not in the trace.
 */
export function checkpointPosition(
  benchmark: PersonalBenchmark,
  checkpointId: string,
): number {
  const index = benchmark.trace.checkpoints.findIndex(
    (checkpoint) => checkpoint.id === checkpointId,
  );

  if (index === -1) {
    throw new Error(`Checkpoint "${checkpointId}" is not in the trace.`);
  }

  return index;
}

/**
 * The trap facts that are current truth at one checkpoint, expressed as surface
 * items so the repository forgetting machinery (`diffSurface`,
 * `obsoleteTargetsFor`, `advanceObsoleteWatchSet`) applies unchanged: a changed
 * version retires its predecessor and a retired fact retires its last version.
 *
 * @param traps - The evaluator-only trap manifest.
 * @param checkpointIds - Trace checkpoint ids in order.
 * @param index - Zero-based checkpoint position.
 *
 * @returns The active trap facts at the checkpoint.
 */
export function trapSurfaceAt(
  traps: PersonalTrapManifest,
  checkpointIds: readonly string[],
  index: number,
): SurfaceItem[] {
  const position = (checkpointId: string): number =>
    checkpointIds.indexOf(checkpointId);
  const surface: SurfaceItem[] = [];

  for (const fact of traps.facts) {
    if (fact.retiredAt !== undefined && position(fact.retiredAt) <= index) {
      continue;
    }

    const active = fact.versions.filter(
      (version) => position(version.from) <= index,
    );
    const current = active.at(-1);

    if (current === undefined) {
      continue;
    }

    surface.push(makeItem(fact.id, "fact", fact.id, current.statement));
  }

  return surface;
}
