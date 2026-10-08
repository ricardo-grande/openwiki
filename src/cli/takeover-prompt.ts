import { createInterface } from "node:readline/promises";
import type {
  ExpiredPersonalLock,
  PersonalTakeoverConfirmation,
} from "../agent/types.js";

/**
 * Describes an expired personal wiki lock and asks whether to take it over.
 *
 * @param lock - Holder and age of the expired lock.
 * @returns One-line question, without the answer hint.
 */
export function formatTakeoverQuestion(lock: ExpiredPersonalLock): string {
  const minutes = Math.floor(lock.ageMs / 60_000);
  return `The personal wiki lock held by ${lock.holder} has expired (last renewed ${minutes} min ago). Take it over and resume its run?`;
}

/**
 * Creates a takeover confirmation that asks on the terminal.
 *
 * The question goes to `output`, so piped stdout stays clean. It defaults to
 * "no".
 *
 * @param input - Stream the answer is read from.
 * @param output - Stream the question is written to.
 * @returns The confirmation, or `undefined` when either stream is not a
 *   terminal: with no one to ask, an expired lock is never taken over.
 */
export function createTerminalTakeoverConfirmation(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): PersonalTakeoverConfirmation | undefined {
  if (!input.isTTY || !output.isTTY) return undefined;
  return async (lock) => {
    const readline = createInterface({ input, output });
    try {
      const answer = await readline.question(
        `${formatTakeoverQuestion(lock)} [y/N] `,
      );
      return /^y(es)?$/iu.test(answer.trim());
    } finally {
      readline.close();
    }
  };
}
