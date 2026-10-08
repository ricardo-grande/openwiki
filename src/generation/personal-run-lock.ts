import { randomUUID } from "node:crypto";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { isFileNotFoundError } from "../platform/fs-errors.js";
import { RepositoryRunError } from "./errors.js";
import { writeJsonState } from "./shared/json-state.js";

/**
 * Basename of the single-writer lock below the wiki directory.
 */
export const PERSONAL_RUN_LOCK_BASENAME = ".run.lock";

/**
 * Time without renewal after which a lock is expired.
 */
export const PERSONAL_RUN_LOCK_TTL_MS = 30 * 60 * 1000;

/**
 * Contents of `.run.lock`.
 */
export interface PersonalRunLock {
  /**
   * `<driver>:<hostname>:<pid>` of the process holding the run.
   */
  holder: string;

  /**
   * Run the lock covers.
   */
  runId: string;

  /**
   * ISO time the holder acquired the lock.
   */
  acquiredAt: string;

  /**
   * ISO time of the holder's latest activity.
   */
  renewedAt: string;
}

/**
 * Parts of a lock holder ID.
 */
export interface PersonalRunLockHolder {
  /**
   * Driver name, such as `native` or `host-claude`.
   */
  driver: string;

  /**
   * Hostname of the holder's machine.
   */
  hostname: string;

  /**
   * Holder's process ID.
   */
  pid: number;
}

/**
 * How a lock's expiry is judged; injectable for tests.
 */
export interface PersonalRunLockClock {
  /**
   * Current time.
   *
   * @default () => new Date()
   */
  now?: () => Date;

  /**
   * Hostname of this machine.
   *
   * @default os.hostname()
   */
  hostname?: string;

  /**
   * Whether a pid on this machine is running.
   *
   * @default a `process.kill(pid, 0)` probe
   */
  isPidAlive?: (pid: number) => boolean;
}

/**
 * A `begin` refused because another process holds the run.
 */
export class PersonalRunLockConflictError extends RepositoryRunError {
  /**
   * Holder ID recorded in the lock.
   */
  readonly holder: string;

  /**
   * Time since the holder last renewed the lock.
   */
  readonly ageMs: number;

  /**
   * Whether the lock is expired and `takeover: true` would take it over.
   */
  readonly expired: boolean;

  constructor(lock: PersonalRunLock, ageMs: number, expired: boolean) {
    const minutes = Math.floor(ageMs / 60_000);
    super(
      "conflict",
      expired
        ? `The personal wiki lock held by ${lock.holder} is expired (last renewed ${minutes} min ago). Begin again with takeover to resume its run.`
        : `The personal wiki is being updated by ${lock.holder} (last active ${minutes} min ago).`,
    );
    this.name = "PersonalRunLockConflictError";
    this.holder = lock.holder;
    this.ageMs = ageMs;
    this.expired = expired;
  }
}

const LockSchema = z
  .object({
    holder: z.string().min(1),
    runId: z.string().min(1),
    acquiredAt: z.string().min(1),
    renewedAt: z.string().min(1),
  })
  .strict();

const HOLDER_PATTERN = /^([a-z][a-z0-9-]*):(.+):([1-9]\d*)$/u;

/**
 * Resolves the lock path below a wiki directory.
 */
export function personalRunLockPath(wikiDir: string): string {
  return path.join(wikiDir, PERSONAL_RUN_LOCK_BASENAME);
}

/**
 * Builds the holder ID of the current process.
 *
 * @param driver - Driver name, such as `native` or `host-claude`.
 * @returns `<driver>:<hostname>:<pid>`.
 */
export function createPersonalRunLockHolder(driver: string): string {
  return `${driver}:${os.hostname()}:${process.pid}`;
}

/**
 * Parses a holder ID.
 *
 * @throws RepositoryRunError (`invalid_input`) when the ID is malformed.
 */
export function parsePersonalRunLockHolder(
  holder: string,
): PersonalRunLockHolder {
  const match = HOLDER_PATTERN.exec(holder);
  if (!match) {
    throw new RepositoryRunError(
      "invalid_input",
      `Lock holder ${JSON.stringify(holder)} must have the form <driver>:<hostname>:<pid>.`,
    );
  }
  return { driver: match[1], hostname: match[2], pid: Number(match[3]) };
}

/**
 * Reads the lock.
 *
 * @returns The lock, or `null` when no process holds the run.
 * @throws RepositoryRunError (`invalid_state`) naming a malformed lock file.
 */
export async function readPersonalRunLock(
  wikiDir: string,
): Promise<PersonalRunLock | null> {
  return (await readLockFile(personalRunLockPath(wikiDir)))?.lock ?? null;
}

/**
 * Time since the holder last renewed the lock.
 */
export function getPersonalRunLockAgeMs(
  lock: PersonalRunLock,
  now: Date = new Date(),
): number {
  const renewed = Date.parse(lock.renewedAt);
  return Number.isNaN(renewed)
    ? Infinity
    : Math.max(0, now.getTime() - renewed);
}

/**
 * Whether a lock may be taken over.
 *
 * A lock is expired when it has not been renewed for 30 minutes, or at once
 * when its holder ran on this machine and that pid is gone.
 */
export function isPersonalRunLockExpired(
  lock: PersonalRunLock,
  {
    now = () => new Date(),
    hostname = os.hostname(),
    isPidAlive = isProcessAlive,
  }: PersonalRunLockClock = {},
): boolean {
  if (getPersonalRunLockAgeMs(lock, now()) >= PERSONAL_RUN_LOCK_TTL_MS) {
    return true;
  }
  const match = HOLDER_PATTERN.exec(lock.holder);
  if (!match || match[2] !== hostname) return false;
  return !isPidAlive(Number(match[3]));
}

/**
 * Acquires the lock for one run.
 *
 * A lock already held by `holder` is renewed and re-pointed at `runId`. A
 * fresh lock of another holder, or an expired one without `takeover`, fails
 * with {@link PersonalRunLockConflictError}. An expired lock is moved aside
 * and re-acquired with an exclusive create, so of two simultaneous takers
 * exactly one wins.
 *
 * @returns The lock as written, and whether `holder` already held it.
 */
export async function acquirePersonalRunLock(
  wikiDir: string,
  input: {
    holder: string;
    runId: string;
    takeover?: boolean;
  } & PersonalRunLockClock,
): Promise<{ lock: PersonalRunLock; alreadyHeld: boolean }> {
  parsePersonalRunLockHolder(input.holder);
  const now = input.now ?? (() => new Date());
  const file = personalRunLockPath(wikiDir);

  // Each pass either creates the lock or removes one expired lock; a second
  // removal would mean another taker won and holds a fresh lock.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const at = now().toISOString();
    const lock: PersonalRunLock = {
      holder: input.holder,
      runId: input.runId,
      acquiredAt: at,
      renewedAt: at,
    };
    if (await createLockExclusive(file, lock))
      return { lock, alreadyHeld: false };

    const existing = await readLockFile(file);
    if (!existing) continue;
    if (existing.lock.holder === input.holder) {
      const renewed = { ...existing.lock, runId: input.runId, renewedAt: at };
      await writeJsonState(file, LockSchema, renewed);
      return { lock: renewed, alreadyHeld: true };
    }

    const expired = isPersonalRunLockExpired(existing.lock, input);
    if (!expired || input.takeover !== true) {
      throw new PersonalRunLockConflictError(
        existing.lock,
        getPersonalRunLockAgeMs(existing.lock, now()),
        expired,
      );
    }
    await moveExpiredLockAside(file, existing);
  }

  const current = await readLockFile(file);
  if (current) {
    throw new PersonalRunLockConflictError(
      current.lock,
      getPersonalRunLockAgeMs(current.lock, now()),
      false,
    );
  }
  throw new RepositoryRunError(
    "conflict",
    "Could not acquire the personal wiki lock; another process is taking it over.",
  );
}

/**
 * Verifies that `holder` still holds the lock for `runId`, and renews it.
 *
 * @throws RepositoryRunError (`conflict`) when the lock is gone or held by
 *   another process or run.
 */
export async function renewPersonalRunLock(
  wikiDir: string,
  input: { holder: string; runId: string; now?: () => Date },
): Promise<void> {
  const file = personalRunLockPath(wikiDir);
  const existing = await readLockFile(file);
  if (
    existing?.lock.holder !== input.holder ||
    existing.lock.runId !== input.runId
  ) {
    throw new RepositoryRunError(
      "conflict",
      existing
        ? `This process no longer holds the personal wiki lock; ${existing.lock.holder} holds it now.`
        : "This process no longer holds the personal wiki lock.",
    );
  }
  await writeJsonState(file, LockSchema, {
    ...existing.lock,
    renewedAt: (input.now ?? (() => new Date()))().toISOString(),
  });
}

/**
 * Releases the lock when `holder` holds it; otherwise does nothing.
 *
 * A driver that exits without finishing calls this and leaves `.run.json` in
 * place, so another driver can resume the run.
 */
export async function releasePersonalRunLock(
  wikiDir: string,
  holder: string,
): Promise<void> {
  const file = personalRunLockPath(wikiDir);
  const existing = await readLockFile(file).catch(() => null);
  if (existing?.lock.holder === holder) {
    await rm(file, { force: true });
  }
}

/**
 * Reads and validates the lock file, keeping its exact text.
 */
async function readLockFile(
  file: string,
): Promise<{ lock: PersonalRunLock; text: string } | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw error;
  }
  try {
    return { lock: LockSchema.parse(JSON.parse(text)), text };
  } catch {
    throw new RepositoryRunError(
      "invalid_state",
      `OpenWiki personal run lock is malformed at ${file}; remove it if no OpenWiki process is running.`,
    );
  }
}

/**
 * Creates the lock only if none exists.
 *
 * The complete content is written to a private temporary file and hard-linked
 * into place. `link` fails when the target exists, which gives the exclusive
 * create of `wx` without ever exposing a partially written lock.
 *
 * @returns Whether this call created the lock.
 */
async function createLockExclusive(
  file: string,
  lock: PersonalRunLock,
): Promise<boolean> {
  LockSchema.parse(lock);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await link(temporary, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Moves one expired lock out of the way.
 *
 * The lock is renamed to a unique name, so only one taker can move a given
 * file. If what was moved is not the expired lock this taker judged (another
 * taker already replaced it), it is linked back without overwriting and the
 * takeover fails.
 */
async function moveExpiredLockAside(
  file: string,
  expired: { lock: PersonalRunLock; text: string },
): Promise<void> {
  const aside = `${file}.${process.pid}.${randomUUID()}.stale`;
  try {
    await rename(file, aside);
  } catch (error) {
    if (isFileNotFoundError(error)) return;
    throw error;
  }

  try {
    const moved = await readFile(aside, "utf8");
    if (moved === expired.text) return;
    await link(aside, file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    throw new PersonalRunLockConflictError(
      LockSchema.parse(JSON.parse(moved)),
      0,
      false,
    );
  } finally {
    await rm(aside, { force: true }).catch(() => undefined);
  }
}

/**
 * Probes whether a pid on this machine is running.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
