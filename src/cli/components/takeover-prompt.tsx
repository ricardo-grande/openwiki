import React from "react";
import { Box, Text, useInput } from "ink";
import type { ExpiredPersonalLock } from "../../agent/types.js";
import { formatTakeoverQuestion } from "../takeover-prompt.js";

/**
 * Props for the expired-lock takeover question.
 */
interface TakeoverPromptProps {
  /**
   * Holder and age of the expired lock.
   */
  lock: ExpiredPersonalLock;

  /**
   * Receives the answer: `true` only for an explicit yes.
   */
  onAnswer: (takeOver: boolean) => void;
}

/**
 * Asks whether to take over an expired personal wiki lock. `y` confirms;
 * `n`, Enter, and Esc decline.
 *
 * @param props - Lock and answer callback.
 * @returns Ink question view.
 */
export function TakeoverPrompt({ lock, onAnswer }: TakeoverPromptProps) {
  useInput((input, key) => {
    if (input.toLowerCase() === "y") {
      onAnswer(true);
    } else if (input.toLowerCase() === "n" || key.return || key.escape) {
      onAnswer(false);
    }
  });

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="yellow">{formatTakeoverQuestion(lock)}</Text>
      <Text color="gray">y take over · n, Enter, or Esc cancel</Text>
    </Box>
  );
}
