import type { OpenWikiLocalShellBackend } from "../../agent/docs-only-backend.js";
import { isFileNotFoundError } from "../../platform/fs-errors.js";
import { RepositoryRunError } from "../errors.js";

/**
 * Backend operations a Markdown page snapshot needs.
 */
export type PageSnapshotBackend = Pick<
  OpenWikiLocalShellBackend,
  "readRaw" | "write" | "delete"
>;

/**
 * Markdown state of one page captured before model-owned work.
 */
export interface PageMarkdownSnapshot {
  /**
   * Canonical virtual Markdown path of the page.
   */
  path: string;

  /**
   * Page content before the worker started, or `null` when it did not exist.
   */
  markdown: string | null;
}

/**
 * True when a backend result error indicates a file does not exist.
 *
 * Matches both the standard `"file_not_found"` error code used by some backends
 * and the human-readable `"Error: File '...' not found"` string returned by
 * DeepAgents' filesystem backends (see #765).
 */
export function isNotFoundBackendError(error: string): boolean {
  return error === "file_not_found" || error.includes("not found");
}

/**
 * Reads one page's Markdown for a pre-work snapshot.
 *
 * @param backend - Backend rooted where the page's virtual path resolves.
 * @param page - Canonical virtual Markdown path.
 * @returns Current Markdown, or `null` when the page does not exist.
 * @throws RepositoryRunError when the page cannot be read as text.
 */
export async function readPageMarkdownSnapshot(
  backend: PageSnapshotBackend,
  page: string,
): Promise<string | null> {
  let markdown: string | null = null;
  try {
    const read = await backend.readRaw(page);
    if (read.error && !isNotFoundBackendError(read.error)) {
      throw new RepositoryRunError(
        "invalid_state",
        `Could not snapshot ${page}: ${read.error}`,
      );
    }
    const content = read.data?.content;
    if (content !== undefined && typeof content !== "string") {
      throw new RepositoryRunError(
        "invalid_state",
        `Could not snapshot non-text Markdown page ${page}.`,
      );
    }
    markdown = content ?? null;
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
  }
  return markdown;
}

/**
 * Restores one page's Markdown to what its snapshot captured.
 *
 * A page that did not exist is deleted again; deleting an already-absent page
 * succeeds.
 *
 * @param backend - Backend rooted where the page's virtual path resolves.
 * @param snapshot - Page path and Markdown captured before the worker started.
 * @throws RepositoryRunError when the page cannot be restored.
 */
export async function restorePageMarkdown(
  backend: PageSnapshotBackend,
  snapshot: PageMarkdownSnapshot,
): Promise<void> {
  const result =
    snapshot.markdown === null
      ? await backend.delete(snapshot.path)
      : await backend.write(snapshot.path, snapshot.markdown);
  if (
    result.error &&
    !(snapshot.markdown === null && isNotFoundBackendError(result.error))
  ) {
    throw new RepositoryRunError(
      "invalid_state",
      `Could not restore ${snapshot.path}: ${result.error}`,
    );
  }
}
