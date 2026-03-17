import {
  FileFabricaRunStore,
  FileGitHubEventStore,
  defaultFabricaRunStorePath,
  defaultGitHubEventStorePath,
} from "./file-event-store.js";
import type { FabricaRunStore, GitHubEventStore } from "./event-store.js";
import { createSqliteGitHubStores, defaultGitHubSqlitePath } from "./sqlite-event-store.js";

export type GitHubStoreBackend = "sqlite" | "file";

export type GitHubStoreBundle = {
  eventStore: GitHubEventStore;
  runStore: FabricaRunStore;
  backend: GitHubStoreBackend;
};

type StoreFactoryLogger = {
  info?(msg: string): void;
  warn?(msg: string): void;
};

export async function createGitHubStores(
  workspaceDir: string,
  opts?: {
    backend?: GitHubStoreBackend;
    logger?: StoreFactoryLogger;
  },
): Promise<GitHubStoreBundle> {
  const preferred = opts?.backend ?? "sqlite";
  if (preferred === "sqlite") {
    try {
      const dbPath = await defaultGitHubSqlitePath(workspaceDir);
      const stores = await createSqliteGitHubStores(dbPath);
      return { ...stores, backend: "sqlite" };
    } catch (error) {
      opts?.logger?.warn?.(
        `GitHub SQLite store unavailable, falling back to file store: ${(error as Error).message}`,
      );
    }
  }

  const eventPath = await defaultGitHubEventStorePath(workspaceDir);
  const runPath = await defaultFabricaRunStorePath(workspaceDir);
  return {
    eventStore: new FileGitHubEventStore(eventPath),
    runStore: new FileFabricaRunStore(runPath),
    backend: "file",
  };
}
