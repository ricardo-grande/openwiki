import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isFileNotFoundError } from "../../platform/fs-errors.js";
import { RepositoryRunError } from "../errors.js";

/**
 * Loads and validates one durable JSON state file.
 *
 * @param file - Absolute path of the state file.
 * @param schema - Schema the parsed JSON must satisfy.
 * @param malformedMessage - `invalid_state` message used when the file is not
 *   valid JSON or does not match the schema.
 * @returns Valid state, or `null` when the file does not exist.
 * @throws RepositoryRunError when the file is malformed.
 */
export async function readJsonState<T>(
  file: string,
  schema: z.ZodType<T>,
  malformedMessage: string,
): Promise<T | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return schema.parse(parsed);
  } catch (error) {
    if (isFileNotFoundError(error)) return null;

    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new RepositoryRunError("invalid_state", malformedMessage);
    }
    throw error;
  }
}

/**
 * Validates and atomically replaces one durable JSON state file.
 *
 * The value is written to a unique temporary sibling and renamed into place,
 * so readers never observe a partial file.
 *
 * @param file - Absolute path of the state file.
 * @param schema - Schema the value must satisfy before anything is written.
 * @param value - Complete state to persist.
 * @throws Error when validation or filesystem persistence fails.
 */
export async function writeJsonState<T>(
  file: string,
  schema: z.ZodType<T>,
  value: T,
): Promise<void> {
  schema.parse(value);
  await mkdir(path.dirname(file), { recursive: true });

  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
