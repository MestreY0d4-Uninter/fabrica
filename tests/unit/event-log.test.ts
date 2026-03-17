import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  appendEvent,
  readEvents,
  readEventsWithSnapshot,
  type StructuredEvent,
} from "../../lib/observability/event-log.js";

import { DATA_DIR } from "../../lib/setup/migrate-layout.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabrica-eventlog-"));
  await fs.mkdir(path.join(tmpDir, DATA_DIR), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("appendEvent", () => {
  it("appends NDJSON entry to events.ndjson", async () => {
    await appendEvent(tmpDir, {
      v: 1,
      type: "label_transition",
      ts: "2026-03-17T10:00:00Z",
      projectSlug: "test",
      issueId: "1",
      data: { from: "To Do", to: "Doing" },
    });

    const content = await fs.readFile(
      path.join(tmpDir, DATA_DIR, "events.ndjson"),
      "utf-8",
    );
    const event = JSON.parse(content.trim());
    expect(event.type).toBe("label_transition");
    expect(event.v).toBe(1);
  });
});

describe("readEvents", () => {
  it("reads all events from NDJSON file", async () => {
    for (let i = 0; i < 3; i++) {
      await appendEvent(tmpDir, {
        v: 1, type: "test_event", ts: new Date().toISOString(),
        projectSlug: "p", issueId: String(i), data: {},
      });
    }

    const events = await readEvents(tmpDir);
    expect(events).toHaveLength(3);
  });

  it("returns empty array when file does not exist", async () => {
    const events = await readEvents(tmpDir);
    expect(events).toEqual([]);
  });
});

describe("snapshot", () => {
  it("creates snapshot after 500 events", async () => {
    for (let i = 0; i < 501; i++) {
      await appendEvent(tmpDir, {
        v: 1, type: "test_event", ts: new Date().toISOString(),
        projectSlug: "p", issueId: String(i), data: {},
      });
    }

    const snapshotPath = path.join(tmpDir, DATA_DIR, "events-snapshot.json");
    const exists = await fs.access(snapshotPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf-8"));
    expect(snapshot.eventCount).toBe(500);
  });
});
