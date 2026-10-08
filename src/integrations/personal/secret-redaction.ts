import { isSecretLikeKey } from "../../platform/diagnostics.js";

/**
 * Shortest value treated as a secret. Shorter values, such as `1` or `true`,
 * would redact ordinary text.
 */
const MIN_SECRET_LENGTH = 8;

/**
 * Placeholder that replaces a secret value.
 */
export const REDACTED_SECRET = "[redacted]";

/**
 * Collects the secret values a tool result must never contain (host §3.4):
 * every connector environment value the server loaded, and every process
 * environment value whose key looks secret.
 *
 * @param loaded - Values loaded from `<home>/.env` by the scoped load.
 * @param env - Process environment.
 * @returns Distinct secret values, longest first.
 */
export function collectSecretValues(
  loaded: Iterable<string>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const values = new Set<string>(loaded);
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && isSecretLikeKey(key)) values.add(value);
  }
  return [...values]
    .map((value) => value.trim())
    .filter((value) => value.length >= MIN_SECRET_LENGTH)
    .sort((left, right) => right.length - left.length);
}

/**
 * Replaces every secret value in the strings of a JSON-like value.
 *
 * @param value - Tool result or message.
 * @param secrets - Values from `collectSecretValues`.
 * @returns The value, unchanged when it contains no secret.
 */
export function redactSecretValues<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value;
  return redact(value, secrets) as T;
}

/**
 * Walks one JSON-like value and redacts its strings and object keys.
 */
function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets) {
      if (text.includes(secret))
        text = text.replaceAll(secret, REDACTED_SECRET);
    }
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redact(key, secrets),
        redact(item, secrets),
      ]),
    );
  }
  return value;
}
