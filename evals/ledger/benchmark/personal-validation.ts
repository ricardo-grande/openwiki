import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { createConnectorRegistry } from "../../../src/connectors/registry.js";
import { BenchmarkValidationError } from "../core/errors.js";
import type { PersonalBenchmark, PersonalTrapManifest } from "../core/types.js";
import {
  CONNECTOR_ID_PATTERN,
  RAW_RUN_ID_PATTERN,
  SOURCE_INSTANCE_ID_PATTERN,
} from "./personal.js";
import { buildCheckpointIdIndex, isObject } from "./validation.js";

/**
 * Whether a value is a non-empty, non-blank string.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate a personal benchmark's manifest and trap catalog structurally,
 * throwing on the first problem. Filesystem checks on the raw fixtures live in
 * `validatePersonalRawFixtures`.
 *
 * Rules: the wiki brief is non-empty; connectors are unique, deterministic
 * OpenWiki connectors with safe instance ids; checkpoint ids are safe and
 * unique; T0 pulls nothing (it is the onboarding init); each later checkpoint
 * pulls each connector at most once, from a connected source, in a raw run newer
 * than that connector's previous pull; and the trap catalog refers only to
 * checkpoints that exist, in order.
 *
 * @param benchmark - The assembled personal benchmark.
 *
 * @throws BenchmarkValidationError on the first inconsistency found.
 */
export function validatePersonalBenchmark(benchmark: PersonalBenchmark): void {
  if (!isNonEmptyString(benchmark.wikiGoal)) {
    throw new BenchmarkValidationError(
      'A personal benchmark must declare a non-empty "wikiGoal".',
    );
  }

  if (benchmark.evidenceMap !== undefined) {
    throw new BenchmarkValidationError(
      "evidenceMap is not supported for personal benchmarks.",
    );
  }

  const connectorIds = validateConnectors(benchmark);
  const checkpoints = benchmark.trace?.checkpoints;

  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    throw new BenchmarkValidationError(
      "trace.checkpoints must be a non-empty array.",
    );
  }

  const index = buildCheckpointIdIndex(checkpoints);
  const lastRunId = new Map<string, string>();

  checkpoints.forEach((checkpoint, position) => {
    if (!Array.isArray(checkpoint.pulls)) {
      throw new BenchmarkValidationError(
        `Checkpoint "${checkpoint.id}" must declare a pulls array.`,
      );
    }

    if (position === 0 && checkpoint.pulls.length > 0) {
      throw new BenchmarkValidationError(
        `Checkpoint "${checkpoint.id}" is the onboarding init and must not pull raw data.`,
      );
    }

    if (position > 0 && checkpoint.pulls.length === 0) {
      throw new BenchmarkValidationError(
        `Checkpoint "${checkpoint.id}" must pull at least one connector; record an empty pull to model a day with no new data.`,
      );
    }

    const seen = new Set<string>();
    for (const pull of checkpoint.pulls) {
      if (
        !isObject(pull) ||
        typeof pull.connectorId !== "string" ||
        typeof pull.rawRunId !== "string"
      ) {
        throw new BenchmarkValidationError(
          `Checkpoint "${checkpoint.id}" has a malformed pull.`,
        );
      }

      if (!connectorIds.has(pull.connectorId)) {
        throw new BenchmarkValidationError(
          `Checkpoint "${checkpoint.id}" pulls "${pull.connectorId}", which is not a connected source.`,
        );
      }

      if (seen.has(pull.connectorId)) {
        throw new BenchmarkValidationError(
          `Checkpoint "${checkpoint.id}" pulls "${pull.connectorId}" more than once.`,
        );
      }
      seen.add(pull.connectorId);

      if (!RAW_RUN_ID_PATTERN.test(pull.rawRunId)) {
        throw new BenchmarkValidationError(
          `Checkpoint "${checkpoint.id}" has invalid rawRunId "${pull.rawRunId}". Use the connector run-id format, for example 2026-03-02T07-00-00-000Z.`,
        );
      }

      const previous = lastRunId.get(pull.connectorId);
      if (previous !== undefined && previous >= pull.rawRunId) {
        throw new BenchmarkValidationError(
          `Checkpoint "${checkpoint.id}" pulls "${pull.connectorId}" run "${pull.rawRunId}", which is not newer than its previous pull "${previous}".`,
        );
      }
      lastRunId.set(pull.connectorId, pull.rawRunId);
    }
  });

  validateTraps(benchmark.traps, index);
}

/**
 * Validate the connected-source list and return its connector ids.
 */
function validateConnectors(benchmark: PersonalBenchmark): Set<string> {
  if (
    !Array.isArray(benchmark.connectors) ||
    benchmark.connectors.length === 0
  ) {
    throw new BenchmarkValidationError(
      "A personal benchmark must declare a non-empty connectors array.",
    );
  }

  const registry = createConnectorRegistry();
  const connectorIds = new Set<string>();
  const instanceIds = new Set<string>();

  benchmark.connectors.forEach((connector, position) => {
    if (
      !isObject(connector) ||
      typeof connector.connectorId !== "string" ||
      !CONNECTOR_ID_PATTERN.test(connector.connectorId)
    ) {
      throw new BenchmarkValidationError(
        `Connector at position ${position} has an invalid connectorId.`,
      );
    }

    const runtime = (
      registry as Partial<Record<string, { supportsAgenticDiscovery: boolean }>>
    )[connector.connectorId];
    if (runtime === undefined) {
      throw new BenchmarkValidationError(
        `Connector "${connector.connectorId}" is not an OpenWiki connector.`,
      );
    }
    if (runtime.supportsAgenticDiscovery) {
      throw new BenchmarkValidationError(
        `Connector "${connector.connectorId}" gathers live during the run and cannot be replayed from recorded pulls yet.`,
      );
    }

    if (connectorIds.has(connector.connectorId)) {
      throw new BenchmarkValidationError(
        `Connector "${connector.connectorId}" is declared more than once.`,
      );
    }
    connectorIds.add(connector.connectorId);

    if (
      typeof connector.instanceId !== "string" ||
      !SOURCE_INSTANCE_ID_PATTERN.test(connector.instanceId) ||
      instanceIds.has(connector.instanceId)
    ) {
      throw new BenchmarkValidationError(
        `Connector "${connector.connectorId}" has a missing, unsafe, or duplicate instanceId.`,
      );
    }
    instanceIds.add(connector.instanceId);

    for (const field of ["name", "ingestionGoal"] as const) {
      if (
        connector[field] !== undefined &&
        !isNonEmptyString(connector[field])
      ) {
        throw new BenchmarkValidationError(
          `Connector "${connector.connectorId}" has an empty ${field}.`,
        );
      }
    }
  });

  return connectorIds;
}

/**
 * Validate the evaluator-only trap manifest against the trace.
 */
function validateTraps(
  traps: PersonalTrapManifest,
  index: Map<string, number>,
): void {
  if (
    !isObject(traps) ||
    !Array.isArray(traps.facts) ||
    !Array.isArray(traps.canaries) ||
    !Array.isArray(traps.noise)
  ) {
    throw new BenchmarkValidationError(
      "traps.json must contain facts, canaries, and noise arrays.",
    );
  }

  const position = (checkpointId: unknown, factId: string): number => {
    const found =
      typeof checkpointId === "string" ? index.get(checkpointId) : undefined;
    if (found === undefined) {
      throw new BenchmarkValidationError(
        `Trap fact "${factId}" refers to unknown checkpoint "${String(checkpointId)}".`,
      );
    }
    return found;
  };

  const factIds = new Set<string>();
  for (const fact of traps.facts) {
    if (!isObject(fact) || !isNonEmptyString(fact.id) || factIds.has(fact.id)) {
      throw new BenchmarkValidationError(
        "Every trap fact needs a unique non-empty id.",
      );
    }
    factIds.add(fact.id);

    if (!Array.isArray(fact.versions) || fact.versions.length === 0) {
      throw new BenchmarkValidationError(
        `Trap fact "${fact.id}" must declare at least one version.`,
      );
    }

    let previousPosition = 0;
    let previousStatement: string | undefined;
    for (const version of fact.versions) {
      if (!isObject(version) || !isNonEmptyString(version.statement)) {
        throw new BenchmarkValidationError(
          `Trap fact "${fact.id}" has a version without a statement.`,
        );
      }
      const from = position(version.from, fact.id);
      if (from <= previousPosition) {
        throw new BenchmarkValidationError(
          `Trap fact "${fact.id}" versions must start after T0 and in trace order.`,
        );
      }
      if (version.statement === previousStatement) {
        throw new BenchmarkValidationError(
          `Trap fact "${fact.id}" repeats an unchanged statement.`,
        );
      }
      previousPosition = from;
      previousStatement = version.statement;
    }

    if (
      fact.retiredAt !== undefined &&
      position(fact.retiredAt, fact.id) <= previousPosition
    ) {
      throw new BenchmarkValidationError(
        `Trap fact "${fact.id}" must retire after its last version.`,
      );
    }
  }

  if (!traps.canaries.every(isNonEmptyString)) {
    throw new BenchmarkValidationError(
      "Trap canaries must be non-empty strings.",
    );
  }

  const noiseIds = new Set<string>();
  for (const noise of traps.noise) {
    if (
      !isObject(noise) ||
      !isNonEmptyString(noise.id) ||
      noiseIds.has(noise.id) ||
      !Array.isArray(noise.terms) ||
      noise.terms.length === 0 ||
      !noise.terms.every(isNonEmptyString)
    ) {
      throw new BenchmarkValidationError(
        "Every trap noise item needs a unique id and non-empty terms.",
      );
    }
    noiseIds.add(noise.id);
  }

  if (traps.placements === undefined) {
    return;
  }

  if (!Array.isArray(traps.placements)) {
    throw new BenchmarkValidationError("Trap placements must be an array.");
  }

  const placementIds = new Set<string>();
  for (const placement of traps.placements) {
    if (
      !isObject(placement) ||
      !isNonEmptyString(placement.id) ||
      placementIds.has(placement.id) ||
      !Array.isArray(placement.terms) ||
      placement.terms.length === 0 ||
      !placement.terms.every(isNonEmptyString) ||
      !Array.isArray(placement.notOnPages) ||
      placement.notOnPages.length === 0 ||
      !placement.notOnPages.every(isNonEmptyString)
    ) {
      throw new BenchmarkValidationError(
        "Every trap placement needs a unique id, non-empty terms, and non-empty notOnPages.",
      );
    }
    placementIds.add(placement.id);
  }
}

/**
 * Confirm every pull's fixture directory exists under the benchmark's `raw/`
 * root as a real directory holding at least one regular file and nothing else:
 * no symlinks and no nested directories, matching what a connector writes.
 *
 * @param benchmark - The validated personal benchmark.
 *
 * @throws BenchmarkValidationError when a pull's fixtures are missing or unsafe.
 */
export async function validatePersonalRawFixtures(
  benchmark: PersonalBenchmark,
): Promise<void> {
  for (const checkpoint of benchmark.trace.checkpoints) {
    for (const pull of checkpoint.pulls) {
      const runDir = path.join(
        benchmark.rawRoot,
        pull.connectorId,
        pull.rawRunId,
      );
      const label = `${pull.connectorId}/${pull.rawRunId}`;
      let entries;

      try {
        const metadata = await lstat(runDir);
        if (!metadata.isDirectory()) {
          throw new Error("not a directory");
        }
        entries = await readdir(runDir, { withFileTypes: true });
      } catch (error) {
        throw new BenchmarkValidationError(
          `Raw fixtures for pull "${label}" at checkpoint "${checkpoint.id}" are missing: ${(error as Error).message}`,
        );
      }

      if (entries.length === 0 || !entries.every((entry) => entry.isFile())) {
        throw new BenchmarkValidationError(
          `Raw fixtures for pull "${label}" must be one or more regular files.`,
        );
      }
    }
  }
}
