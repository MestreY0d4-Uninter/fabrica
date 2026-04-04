import { describe, it, expect, vi } from "vitest";
import { verifyInstallabilitySmoke } from "../../scripts/verify-installability.mjs";

describe("verify-installability script", () => {
  it("fails closed when fabrica doctor exits non-zero", () => {
    const exec = vi
      .fn()
      .mockReturnValueOnce({ status: 0, output: '[{"filename":"pkg.tgz"}]' })
      .mockReturnValueOnce({ status: 0, output: "installed" })
      .mockReturnValueOnce({ status: 0, output: "Status: loaded" })
      .mockReturnValueOnce({ status: 2, output: "doctor failed" });

    const existsSync = vi.fn(() => true);
    const rmSync = vi.fn();

    expect(() =>
      verifyInstallabilitySmoke({
        exec,
        fsImpl: { existsSync, rmSync },
        now: () => 123,
        homedir: "/home/tester",
        cwd: "/workspace",
        timeoutMs: 5000,
      })
    ).toThrow(/fabrica doctor/);
  });

  it("applies timeout to pack/install/inspect/doctor and cleans tarball + profile dir", () => {
    const exec = vi
      .fn()
      .mockReturnValueOnce({ status: 0, output: '[{"filename":"pkg.tgz"}]' })
      .mockReturnValueOnce({ status: 0, output: "installed" })
      .mockReturnValueOnce({ status: 0, output: "Status: loaded" })
      .mockReturnValueOnce({ status: 0, output: "doctor ok" });

    const existsSync = vi.fn(() => true);
    const rmSync = vi.fn();

    verifyInstallabilitySmoke({
      exec,
      fsImpl: { existsSync, rmSync },
      now: () => 999,
      homedir: "/home/tester",
      cwd: "/workspace",
      timeoutMs: 7000,
    });

    expect(exec).toHaveBeenCalledTimes(4);
    expect(exec).toHaveBeenNthCalledWith(1, "npm", ["pack", "--json"], { timeoutMs: 7000 });
    expect(exec).toHaveBeenNthCalledWith(
      2,
      "openclaw",
      ["--profile", "fabrica-install-smoke-999", "plugins", "install", "--dangerously-force-unsafe-install", "pkg.tgz"],
      { timeoutMs: 7000 }
    );
    expect(exec).toHaveBeenNthCalledWith(
      3,
      "openclaw",
      ["--profile", "fabrica-install-smoke-999", "plugins", "inspect", "fabrica"],
      { timeoutMs: 7000 }
    );
    expect(exec).toHaveBeenNthCalledWith(
      4,
      "openclaw",
      ["--profile", "fabrica-install-smoke-999", "fabrica", "doctor", "--help"],
      { timeoutMs: 7000 }
    );

    expect(rmSync).toHaveBeenCalledWith("pkg.tgz", { force: true });
    expect(rmSync).toHaveBeenCalledWith("/home/tester/.openclaw-fabrica-install-smoke-999", {
      recursive: true,
      force: true,
    });
  });
});
