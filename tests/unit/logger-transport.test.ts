import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportSpy = vi.fn();
const loggerFactorySpy = vi.fn(() => ({
  child: vi.fn().mockReturnThis(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("pino", () => {
  const pinoMock = Object.assign(loggerFactorySpy, {
    transport: transportSpy,
    stdTimeFunctions: {
      isoTime: vi.fn(),
    },
  });

  return {
    default: pinoMock,
    stdSerializers: {
      err: vi.fn(),
    },
  };
});

describe("logger transport", () => {
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    transportSpy.mockReset();
    loggerFactorySpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
    }
  });

  it("does not auto-enable pino-pretty just because stdout is a TTY", async () => {
    vi.stubEnv("NODE_ENV", "development");
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });

    await import("../../lib/observability/logger.js");

    expect(transportSpy).not.toHaveBeenCalled();
  });

  it("falls back to plain logging when pretty transport initialization fails", async () => {
    vi.stubEnv("LOG_PRETTY", "1");
    transportSpy.mockImplementation(() => {
      throw new Error('unable to determine transport target for "pino-pretty"');
    });

    await expect(import("../../lib/observability/logger.js")).resolves.toBeDefined();
    expect(transportSpy).toHaveBeenCalled();
    expect(loggerFactorySpy).toHaveBeenCalled();
  });
});
