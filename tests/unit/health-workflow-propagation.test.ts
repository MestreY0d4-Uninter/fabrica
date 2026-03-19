/**
 * Tests that performHealthPass() forwards the project's workflow config
 * to both checkWorkerHealth() and scanStatelessIssues() (P0-7 / P0-8).
 *
 * Before the fix, both functions defaulted to DEFAULT_WORKFLOW, causing
 * false-positive health fixes for projects with custom labels.
 */
import { describe, it, expect, vi } from "vitest";

describe("performHealthPass — workflow propagation", () => {
  it("passes workflow config to checkWorkerHealth (P0-7)", async () => {
    const { performHealthPass } = await import("../../lib/services/heartbeat/passes.js");
    const healthModule = await import("../../lib/services/heartbeat/health.js");

    const checkWorkerHealthSpy = vi.spyOn(healthModule, "checkWorkerHealth").mockResolvedValue([]);
    vi.spyOn(healthModule, "scanOrphanedLabels").mockResolvedValue([]);
    vi.spyOn(healthModule, "scanStatelessIssues").mockResolvedValue([]);

    const customWorkflow = {
      initial: "todo",
      states: {
        todo: { label: "Custom-Todo", type: "queue" as const },
        doing: { label: "Custom-Doing", type: "active" as const },
      },
    } as any;

    const project = {
      workers: { developer: { levels: {} } },
      channels: [],
      slug: "test-proj",
      name: "Test Project",
    } as any;
    const provider = {
      listIssues: vi.fn().mockResolvedValue([]),
    } as any;
    const resolvedConfig = {
      timeouts: { dispatchConfirmTimeoutMs: 5000, staleWorkerHours: 2, stallTimeoutMinutes: 10 },
      workflow: customWorkflow,
    } as any;

    await performHealthPass(
      ".",
      "test-proj",
      project,
      null,
      provider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      resolvedConfig,
    );

    expect(checkWorkerHealthSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workflow: customWorkflow }),
    );

    checkWorkerHealthSpy.mockRestore();
  });

  it("passes workflow config to scanStatelessIssues (P0-8)", async () => {
    const { performHealthPass } = await import("../../lib/services/heartbeat/passes.js");
    const healthModule = await import("../../lib/services/heartbeat/health.js");

    vi.spyOn(healthModule, "checkWorkerHealth").mockResolvedValue([]);
    vi.spyOn(healthModule, "scanOrphanedLabels").mockResolvedValue([]);
    const scanStatelessSpy = vi.spyOn(healthModule, "scanStatelessIssues").mockResolvedValue([]);

    const customWorkflow = {
      initial: "todo",
      states: {
        todo: { label: "Custom-Todo", type: "queue" as const },
        doing: { label: "Custom-Doing", type: "active" as const },
      },
    } as any;

    const project = {
      workers: { developer: { levels: {} } },
      channels: [],
      slug: "test-proj",
      name: "Test Project",
    } as any;
    const provider = {
      listIssues: vi.fn().mockResolvedValue([]),
    } as any;
    const resolvedConfig = {
      timeouts: { dispatchConfirmTimeoutMs: 5000, staleWorkerHours: 2, stallTimeoutMinutes: 10 },
      workflow: customWorkflow,
    } as any;

    await performHealthPass(
      ".",
      "test-proj",
      project,
      null,
      provider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      resolvedConfig,
    );

    expect(scanStatelessSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workflow: customWorkflow }),
    );

    scanStatelessSpy.mockRestore();
  });

  it("workflow is undefined when resolvedConfig is not provided", async () => {
    const { performHealthPass } = await import("../../lib/services/heartbeat/passes.js");
    const healthModule = await import("../../lib/services/heartbeat/health.js");

    const checkWorkerHealthSpy = vi.spyOn(healthModule, "checkWorkerHealth").mockResolvedValue([]);
    vi.spyOn(healthModule, "scanOrphanedLabels").mockResolvedValue([]);
    const scanStatelessSpy = vi.spyOn(healthModule, "scanStatelessIssues").mockResolvedValue([]);

    const project = {
      workers: { developer: { levels: {} } },
      channels: [],
      slug: "test-proj",
      name: "Test Project",
    } as any;
    const provider = {
      listIssues: vi.fn().mockResolvedValue([]),
    } as any;

    await performHealthPass(
      ".",
      "test-proj",
      project,
      null,
      provider,
    );

    expect(checkWorkerHealthSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workflow: undefined }),
    );
    expect(scanStatelessSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workflow: undefined }),
    );

    checkWorkerHealthSpy.mockRestore();
    scanStatelessSpy.mockRestore();
  });
});
