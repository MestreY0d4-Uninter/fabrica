/**
 * projects/io-helpers.ts — Crash-safe filesystem primitives.
 */
import fs from "node:fs/promises";

export async function backupFile(filePath: string): Promise<void> {
  try {
    await fs.copyFile(filePath, filePath + ".bak");
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
}

export async function writeSafe(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + ".tmp";
  const fd = await fs.open(tmpPath, "w");
  try {
    await fd.writeFile(content, "utf-8");
    await fd.datasync();
  } finally {
    await fd.close();
  }
  await fs.rename(tmpPath, filePath);
}

export async function readJsonWithFallback(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath, "utf-8");
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    const bak = await fs.readFile(filePath + ".bak", "utf-8");
    JSON.parse(bak);
    return bak;
  }
}
