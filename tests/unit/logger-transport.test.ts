import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prettyFactorySpy = vi.fn();
const loggerFactorySpy = vi.fn(() => ({
  child: vi.fn().mockReturnThis(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("pino", () => {
  const pinoMock = Object.assign(loggerFactorySpy, {
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

vi.mock("pino-pretty", () => ({
  default: prettyFactorySpy,
}));

describe("logger transport", () => {
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    prettyFactorySpy.mockReset();
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

    expect(prettyFactorySpy).not.toHaveBeenCalled();
  });

  it("creates a direct pretty stream when LOG_PRETTY=1", async () => {
    vi.stubEnv("LOG_PRETTY", "1");
    prettyFactorySpy.mockReturnValue({ write: vi.fn() });

    await expect(import("../../lib/observability/logger.js")).resolves.toBeDefined();

    expect(prettyFactorySpy).toHaveBeenCalledWith({
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    });
    expect(loggerFactorySpy).toHaveBeenCalled();
  });

  it("falls back to plain logging when pretty stream initialization fails", async () => {
    vi.stubEnv("LOG_PRETTY", "1");
    prettyFactorySpy.mockImplementation(() => {
      throw new Error('unable to initialize pino-pretty');
    });

    await expect(import("../../lib/observability/logger.js")).resolves.toBeDefined();
    expect(prettyFactorySpy).toHaveBeenCalled();
    expect(loggerFactorySpy).toHaveBeenCalled();
  });
});
