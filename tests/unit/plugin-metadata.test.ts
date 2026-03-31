import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const METADATA_PATH = path.join(__dirname, "../../openclaw.plugin.json");

describe("openclaw plugin metadata", () => {
  it("publishes the current control-plane config surface", () => {
    const metadata = JSON.parse(fs.readFileSync(METADATA_PATH, "utf8")) as {
      configSchema?: { properties?: Record<string, any> };
    };
    const props = metadata.configSchema?.properties ?? {};

    expect(props.projectExecution).toBeDefined();
    expect(props.notifications?.properties?.workerStart).toBeDefined();
    expect(props.notifications?.properties?.workerComplete).toBeDefined();
    expect(props.work_heartbeat?.properties?.intervalSeconds).toBeDefined();
    expect(props.telegram?.properties?.projectsForumChatId).toBeDefined();
    expect(props.telegram?.properties?.projectsForumAccountId).toBeDefined();
    expect(props.telegram?.properties?.opsChatId).toBeDefined();
    expect(props.providers?.properties?.github?.properties?.defaultAuthProfile).toBeDefined();
    expect(props.providers?.properties?.github?.properties?.webhookMode).toBeDefined();
    expect(props.providers?.properties?.github?.properties?.authProfiles?.additionalProperties?.properties?.appId).toBeDefined();
    expect(props.providers?.properties?.github?.properties?.authProfiles?.additionalProperties?.properties?.privateKey).toBeDefined();
    expect(props.providers?.properties?.github?.properties?.authProfiles?.additionalProperties?.properties?.privateKeyPath).toBeDefined();
  });
});
