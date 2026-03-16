import { acquireLock, releaseLock } from "../lib/projects/io.js";
import { DATA_DIR } from "../lib/setup/migrate-layout.js";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

type UpdateResult = { success: boolean; error?: string };

export async function updateProjectTopic(opts: {
  workspaceDir: string;
  slug: string;
  channelId: string;
  messageThreadId: number;
}): Promise<UpdateResult> {
  await acquireLock(opts.workspaceDir);
  try {
    const filePath = join(opts.workspaceDir, DATA_DIR, "projects.json");
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const project = projects?.[opts.slug];

    if (!project) {
      return { success: false, error: `Project "${opts.slug}" not found in projects.json` };
    }

    const channels = project.channels as Array<Record<string, unknown>> | undefined;
    if (!channels) {
      return { success: false, error: `Project "${opts.slug}" has no channels` };
    }

    const match = channels.find(
      (ch) => ch.channel === "telegram" && String(ch.channelId) === String(opts.channelId),
    );

    if (!match) {
      return { success: false, error: `No telegram channel with ID ${opts.channelId} found for "${opts.slug}"` };
    }

    match.messageThreadId = opts.messageThreadId;
    const tmpPath = filePath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    await rename(tmpPath, filePath);
    return { success: true };
  } finally {
    await releaseLock(opts.workspaceDir);
  }
}
