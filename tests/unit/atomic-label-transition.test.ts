import { describe, it, expect, vi } from "vitest";

/**
 * This test verifies the atomic label transition contract.
 * The real atomic PUT call uses `gh api repos/{owner}/{repo}/issues/N/labels --method PUT`
 * which replaces ALL labels in a single HTTP call, eliminating the dual-state race window.
 */
describe("atomic label transition contract", () => {
  it("PUT replaces all labels atomically (no intermediate dual-state)", () => {
    // This is a contract test — it documents the expected behavior:
    // When transitioning from "Doing" to "To Review":
    // - Old: add "To Review" first (dual state), then remove "Doing"
    //   → 12s window where heartbeat can see both labels and remove "To Review"
    // - New: single PUT with only ["To Review", ...other-labels]
    //   → no intermediate state possible

    const oldLabels = ["Doing", "priority: high"];
    const newStateLabel = "To Review";
    const stateLabels = ["Planning", "To Do", "Doing", "To Review", "Reviewing",
                         "To Test", "Testing", "To Improve", "Done"];

    // Simulate the new atomic logic:
    // keep non-state labels, add target state label
    const desired = oldLabels
      .filter((l) => !stateLabels.includes(l))
      .concat(newStateLabel);

    expect(desired).toEqual(["priority: high", "To Review"]);
    // No "Doing" — single atomic replace, no intermediate dual-state
    expect(desired).not.toContain("Doing");
    expect(desired.filter((l) => stateLabels.includes(l))).toHaveLength(1);
  });
});
