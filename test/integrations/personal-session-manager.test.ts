import os from "node:os";
import { describe, expect, test, vi } from "vitest";
import { PersonalSessionManager } from "../../src/integrations/personal/session-manager.ts";

describe("PersonalSessionManager", () => {
  test("registers no tools at stage H1 (PHM-005, staged form)", () => {
    const manager = PersonalSessionManager.create({ host: "claude" });

    expect(manager.tools()).toEqual([]);
  });

  test("derives the run actor and the lock holder from the host", () => {
    const manager = PersonalSessionManager.create({
      host: "claude",
      producerActor: "claude-code",
    });

    expect(manager.actor).toEqual({
      producerActor: "claude-code",
      metadataModel: "host-agent/claude",
    });
    expect(manager.holder).toBe(`host-claude:${os.hostname()}:${process.pid}`);
  });

  test.each([
    [{ host: "Claude" }, /host ID/u],
    [{ host: "claude", producerActor: "bad_actor" }, /producer actor/u],
  ])("rejects an invalid identity: %j", (options, message) => {
    expect(() => PersonalSessionManager.create(options)).toThrow(message);
  });

  test("rejects an operation while another is in progress", async () => {
    const manager = PersonalSessionManager.create({ host: "claude" });
    let release: () => void = () => undefined;
    const first = manager.runOperation(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("first");
        }),
    );

    await expect(
      manager.runOperation(() => Promise.resolve("second")),
    ).rejects.toMatchObject({
      code: "invalid_state",
      message: "Another OpenWiki lifecycle operation is already in progress.",
    });
    release();
    await expect(first).resolves.toBe("first");
    await expect(
      manager.runOperation(() => Promise.resolve("third")),
    ).resolves.toBe("third");
  });

  test("loads the connector environment once, and again after a failure", async () => {
    const loadConnectorEnv = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("unreadable .env"))
      .mockResolvedValue(undefined);
    const manager = PersonalSessionManager.create({
      host: "claude",
      loadConnectorEnv,
    });

    await expect(manager.loadConnectorEnvironment()).rejects.toThrow(
      "unreadable .env",
    );
    await manager.loadConnectorEnvironment();
    await manager.loadConnectorEnvironment();

    expect(loadConnectorEnv).toHaveBeenCalledTimes(2);
  });
});
