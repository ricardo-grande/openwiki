import { HostIntegrationError } from "./errors.js";

/**
 * Serializes a session manager's operations: one runs at a time, and a call
 * made while another is in progress fails instead of waiting.
 */
export class OperationGuard {
  /**
   * Whether one operation currently owns the guard.
   */
  private inProgress = false;

  /**
   * Runs one operation while holding the guard.
   *
   * @param task - Operation that requires exclusive access.
   * @returns The operation result.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.inProgress) {
      throw new HostIntegrationError(
        "invalid_state",
        "Another OpenWiki lifecycle operation is already in progress.",
      );
    }
    this.inProgress = true;
    try {
      return await task();
    } finally {
      this.inProgress = false;
    }
  }
}
