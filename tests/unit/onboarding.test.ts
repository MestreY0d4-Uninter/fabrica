import { describe, expect, it } from "vitest";
import { buildOnboardToolContext, buildReconfigContext } from "../../lib/setup/onboarding.js";

describe("setup onboarding context", () => {
  it("uses Fabrica branding and workspace-neutral workflow guidance in reconfiguration", () => {
    const content = buildReconfigContext();
    expect(content).toContain("# Fabrica Reconfiguration");
    expect(content).toContain("reconfigure Fabrica");
    expect(content).toContain("workflow.yaml");
    expect(content).not.toContain("devclaw/workflow.yaml");
    expect(content).not.toContain("DevClaw");
  });

  it("uses Fabrica branding in first-run onboarding", () => {
    const content = buildOnboardToolContext();
    expect(content).toContain("# Fabrica Onboarding");
    expect(content).toContain("What is Fabrica?");
    expect(content).toContain("configure Fabrica");
    expect(content).not.toContain("What is DevClaw?");
  });
});
