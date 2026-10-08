import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  createTerminalTakeoverConfirmation,
  formatTakeoverQuestion,
} from "../../src/cli/takeover-prompt.ts";

const LOCK = { holder: "native:mbp:4711", ageMs: 42 * 60_000 + 30_000 };

/**
 * A stream pair standing in for a terminal; `tty` sets `isTTY` on both.
 */
function streams(tty: boolean): {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  written: () => string;
} {
  const input = Object.assign(new PassThrough(), { isTTY: tty });
  const output = Object.assign(new PassThrough(), { isTTY: tty });
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  return {
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    written: () => chunks.join(""),
  };
}

describe("terminal takeover confirmation", () => {
  test("names the holder and the lock age in whole minutes", () => {
    expect(formatTakeoverQuestion(LOCK)).toBe(
      "The personal wiki lock held by native:mbp:4711 has expired (last renewed 42 min ago). Take it over and resume its run?",
    );
  });

  test("is unavailable without a terminal, so nothing is taken over", () => {
    const { input, output } = streams(false);
    expect(createTerminalTakeoverConfirmation(input, output)).toBeUndefined();
  });

  test.each([
    ["y\n", true],
    ["YES\n", true],
    ["n\n", false],
    ["\n", false],
    ["sure\n", false],
  ])("answer %j confirms: %s", async (answer, expected) => {
    const { input, output, written } = streams(true);
    const confirm = createTerminalTakeoverConfirmation(input, output);

    const result = confirm?.(LOCK);
    input.write(answer);

    await expect(result).resolves.toBe(expected);
    expect(written()).toContain("[y/N]");
  });
});
