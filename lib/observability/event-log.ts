/**
 * observability/event-log.ts — Structured append-only event log.
 *
 * Separate from audit.log (which rotates). Events here persist for metrics,
 * conflict detection, and state reconstruction.
 * Snapshots every 500 events to bound read cost.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../setup/migrate-layout.js";

const EVENTS_FILE = "events.ndjson";
const SNAPSHOT_FILE = "events-snapshot.json";
const SNAPSHOT_INTERVAL = 500;

export type StructuredEvent = {
  v: number;
  type: string;
  ts: string;
  projectSlug: string;
  issueId: string;
  data: Record<string, unknown>;
};

type Snapshot = {
  eventCount: number;
  ts: string;
  counters: Record<string, number>;
};

function eventsPath(workspaceDir: string): string {
  return path.join(workspaceDir, DATA_DIR, EVENTS_FILE);
}

function snapshotPath(workspaceDir: string): string {
  return path.join(workspaceDir, DATA_DIR, SNAPSHOT_FILE);
}

/**
 * Append a structured event to the log.
 * Triggers snapshot creation every SNAPSHOT_INTERVAL events.
 */
export async function appendEvent(
  workspaceDir: string,
  event: StructuredEvent,
): Promise<void> {
  const filePath = eventsPath(workspaceDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(event) + "\n", "utf-8");

  // Check if snapshot needed
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lineCount = content.split("\n").filter(Boolean).length;
    if (lineCount > 0 && lineCount % SNAPSHOT_INTERVAL === 0) {
      await createSnapshot(workspaceDir, lineCount);
    }
  } catch { /* non-critical */ }
}

/**
 * Read all events from the NDJSON file.
 */
export async function readEvents(workspaceDir: string): Promise<StructuredEvent[]> {
  try {
    const content = await fs.readFile(eventsPath(workspaceDir), "utf-8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((e): e is StructuredEvent => e !== null && e.v !== undefined);
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Read events with snapshot optimization.
 * If a snapshot exists, return snapshot + events after snapshot.
 */
export async function readEventsWithSnapshot(
  workspaceDir: string,
): Promise<{ snapshot: Snapshot | null; events: StructuredEvent[] }> {
  let snapshot: Snapshot | null = null;
  try {
    const raw = await fs.readFile(snapshotPath(workspaceDir), "utf-8");
    snapshot = JSON.parse(raw);
  } catch { /* no snapshot */ }

  const allEvents = await readEvents(workspaceDir);
  const eventsAfterSnapshot = snapshot
    ? allEvents.slice(snapshot.eventCount)
    : allEvents;

  return { snapshot, events: eventsAfterSnapshot };
}

async function createSnapshot(workspaceDir: string, eventCount: number): Promise<void> {
  const events = await readEvents(workspaceDir);
  const counters: Record<string, number> = {};
  for (const event of events.slice(0, eventCount)) {
    counters[event.type] = (counters[event.type] ?? 0) + 1;
  }
  const snapshot: Snapshot = {
    eventCount,
    ts: new Date().toISOString(),
    counters,
  };
  await fs.writeFile(snapshotPath(workspaceDir), JSON.stringify(snapshot, null, 2), "utf-8");
}
