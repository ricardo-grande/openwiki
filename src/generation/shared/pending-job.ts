import { RepositoryRunError } from "../errors.js";

/**
 * Minimal page-job shape shared by every durable page queue.
 */
export interface QueuedPageJob {
  /**
   * Stable identifier used by page submission.
   */
  id: string;

  /**
   * Durable completion state for this queue entry.
   */
  status: "pending" | "skipped" | "complete";
}

/**
 * Finds one page job that a worker may still act on.
 *
 * Any pending job qualifies, not only the first one in queue order, so several
 * workers can own distinct jobs at the same time. Ownership is process-local;
 * the durable checkpoint only records `pending`, `skipped`, and `complete`.
 *
 * @param pages - Ordered queue of the durably installed plan, if any.
 * @param jobId - Page job identifier supplied by the worker.
 * @param action - Past-tense verb named in the rejection message.
 * @returns The pending page job.
 */
export function requirePendingJob<Job extends QueuedPageJob>(
  pages: readonly Job[] | undefined,
  jobId: string,
  action: string,
): Job {
  const job = pages?.find(({ id }) => id === jobId);
  if (!job || job.status !== "pending") {
    throw new RepositoryRunError(
      "invalid_state",
      `Only a pending OpenWiki page job may be ${action}.`,
    );
  }
  return job;
}
