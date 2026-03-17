import { afterEach, describe, expect, it, vi } from "vitest";
import { isExplicitCliTelemetryEnabled, isGatewayServerProcess } from "../../lib/runtime-mode.js";

describe("runtime-mode", () => {
  const originalArgv = process.argv.slice();

  afterEach(() => {
    process.argv = originalArgv.slice();
    vi.unstubAllEnvs();
  });

  it("detects the gateway server process only when gateway is the active command", () => {
    process.argv = ["node", "openclaw", "gateway", "--port", "18789"];
    expect(isGatewayServerProcess()).toBe(true);

    process.argv = ["node", "openclaw", "gateway", "status", "--require-rpc"];
    expect(isGatewayServerProcess()).toBe(false);

    process.argv = ["node", "openclaw", "plugins", "doctor"];
    expect(isGatewayServerProcess()).toBe(false);
  });

  it("treats the service marker as authoritative for gateway runtime", () => {
    vi.stubEnv("OPENCLAW_SERVICE_KIND", "gateway");
    process.argv = ["node", "openclaw", "plugins", "doctor"];
    expect(isGatewayServerProcess()).toBe(true);
  });

  it("only enables CLI telemetry when explicitly requested", () => {
    expect(isExplicitCliTelemetryEnabled()).toBe(false);
    vi.stubEnv("FABRICA_ENABLE_CLI_TELEMETRY", "true");
    expect(isExplicitCliTelemetryEnabled()).toBe(true);
  });
});
