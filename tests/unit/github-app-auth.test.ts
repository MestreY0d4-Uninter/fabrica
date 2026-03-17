import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  appCtorSpy,
  requestSpy,
  getInstallationOctokitSpy,
  octokitDefaultsSpy,
} = vi.hoisted(() => ({
  appCtorSpy: vi.fn(),
  requestSpy: vi.fn(),
  getInstallationOctokitSpy: vi.fn(),
  octokitDefaultsSpy: vi.fn(() => "BaseUrlOctokit"),
}));

vi.mock("@octokit/app", () => {
  class FakeApp {
    public octokit = {
      request: requestSpy,
    };

    constructor(public options: Record<string, unknown>) {
      appCtorSpy(options);
    }

    async getInstallationOctokit(installationId: number) {
      return getInstallationOctokitSpy(installationId);
    }
  }

  return { App: FakeApp };
});

vi.mock("@octokit/core", () => ({
  Octokit: {
    defaults: octokitDefaultsSpy,
  },
}));

const ENV_KEYS = [
  "FABRICA_GITHUB_APP_ID_TEST",
  "FABRICA_GITHUB_APP_PRIVATE_KEY_TEST",
  "FABRICA_GITHUB_APP_PRIVATE_KEY_PATH_TEST",
];

let tempDir: string | null = null;

function pluginConfig(overrides: Record<string, unknown> = {}) {
  return {
    providers: {
      github: {
        defaultAuthProfile: "main",
        authProfiles: {
          main: {
            mode: "github-app",
            appIdEnv: "FABRICA_GITHUB_APP_ID_TEST",
            privateKeyEnv: "FABRICA_GITHUB_APP_PRIVATE_KEY_TEST",
            privateKeyPathEnv: "FABRICA_GITHUB_APP_PRIVATE_KEY_PATH_TEST",
            ...overrides,
          },
        },
      },
    },
  };
}

async function importFresh() {
  vi.resetModules();
  return import("../../lib/github/app-auth.js");
}

beforeEach(() => {
  appCtorSpy.mockReset();
  requestSpy.mockReset();
  getInstallationOctokitSpy.mockReset();
  octokitDefaultsSpy.mockClear();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("github app auth", () => {
  it("returns null when the app credentials are incomplete", async () => {
    process.env.FABRICA_GITHUB_APP_ID_TEST = "3087504";
    const mod = await importFresh();

    expect(mod.getGitHubApp(pluginConfig())).toBeNull();
  });

  it("creates and caches a GitHub App from env credentials", async () => {
    process.env.FABRICA_GITHUB_APP_ID_TEST = "3087504";
    process.env.FABRICA_GITHUB_APP_PRIVATE_KEY_TEST = "line-1\\nline-2";
    const mod = await importFresh();

    const first = mod.getGitHubApp(pluginConfig());
    const second = mod.getGitHubApp(pluginConfig());

    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(appCtorSpy).toHaveBeenCalledTimes(1);
    expect(appCtorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "3087504",
        privateKey: "line-1\nline-2",
      }),
    );
  });

  it("loads the private key from a file path and honors baseUrl for GHE", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-app-auth-"));
    const pemPath = path.join(tempDir, "app.pem");
    await fs.writeFile(pemPath, "pem-from-file", "utf-8");
    process.env.FABRICA_GITHUB_APP_ID_TEST = "3087504";
    process.env.FABRICA_GITHUB_APP_PRIVATE_KEY_PATH_TEST = pemPath;
    const mod = await importFresh();

    const app = mod.getGitHubApp(pluginConfig({ baseUrl: "https://ghe.example/api/v3/" }));

    expect(app).toBeTruthy();
    expect(octokitDefaultsSpy).toHaveBeenCalledWith({ baseUrl: "https://ghe.example/api/v3" });
    expect(appCtorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "3087504",
        privateKey: "pem-from-file",
        Octokit: "BaseUrlOctokit",
      }),
    );
  });

  it("prefers direct config values over environment wiring", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-app-auth-direct-"));
    const pemPath = path.join(tempDir, "app.pem");
    await fs.writeFile(pemPath, "pem-from-direct-config", "utf-8");
    process.env.FABRICA_GITHUB_APP_ID_TEST = "ignored-env-app-id";
    process.env.FABRICA_GITHUB_APP_PRIVATE_KEY_TEST = "ignored-env-private-key";
    const mod = await importFresh();

    const app = mod.getGitHubApp(pluginConfig({
      appId: "3087504",
      privateKeyPath: pemPath,
    }));

    expect(app).toBeTruthy();
    expect(appCtorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "3087504",
        privateKey: "pem-from-direct-config",
      }),
    );
  });

  it("fetches the installation octokit for a repository", async () => {
    process.env.FABRICA_GITHUB_APP_ID_TEST = "3087504";
    process.env.FABRICA_GITHUB_APP_PRIVATE_KEY_TEST = "pem";
    requestSpy.mockResolvedValue({ data: { id: 116234708 } });
    getInstallationOctokitSpy.mockResolvedValue({ request: vi.fn() });
    const mod = await importFresh();

    const result = await mod.getGitHubRepoInstallationOctokit(pluginConfig(), {
      owner: "MestreY0d4-Uninter",
      repo: "Fabrica",
    });

    expect(requestSpy).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/installation", {
      owner: "MestreY0d4-Uninter",
      repo: "Fabrica",
    });
    expect(getInstallationOctokitSpy).toHaveBeenCalledWith(116234708);
    expect(result).toEqual({
      installationId: 116234708,
      octokit: { request: expect.any(Function) },
    });
  });

  it("fails closed when installation lookup returns an invalid id", async () => {
    process.env.FABRICA_GITHUB_APP_ID_TEST = "3087504";
    process.env.FABRICA_GITHUB_APP_PRIVATE_KEY_TEST = "pem";
    requestSpy.mockResolvedValue({ data: { id: 0 } });
    getInstallationOctokitSpy.mockResolvedValue({ request: vi.fn() });
    const mod = await importFresh();

    const result = await mod.getGitHubRepoInstallationOctokit(pluginConfig(), {
      owner: "MestreY0d4-Uninter",
      repo: "Fabrica",
    });

    expect(result).toBeNull();
  });
});
