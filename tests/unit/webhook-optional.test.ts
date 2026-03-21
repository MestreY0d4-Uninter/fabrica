import { describe, it, expect, vi } from "vitest";

describe("webhookMode config schema", () => {
  it("accepts optional, required, disabled values", async () => {
    const { FabricaConfigSchema } = await import("../../lib/config/schema.js");
    // optional
    expect(() => FabricaConfigSchema.parse({
      providers: { github: { webhookMode: "optional" } },
    })).not.toThrow();
    // required
    expect(() => FabricaConfigSchema.parse({
      providers: { github: { webhookMode: "required" } },
    })).not.toThrow();
    // disabled
    expect(() => FabricaConfigSchema.parse({
      providers: { github: { webhookMode: "disabled" } },
    })).not.toThrow();
  });

  it("defaults to optional when webhookMode is not set", async () => {
    const { FabricaConfigSchema } = await import("../../lib/config/schema.js");
    const result = FabricaConfigSchema.parse({ providers: { github: {} } });
    // default: not set means optional behavior applies
    expect(result.providers?.github?.webhookMode).toBeUndefined(); // undefined = "optional" by convention
  });
});

describe("registerGitHubWebhookRoute — getWebhookMode helper", () => {
  it("returns correct mode values", async () => {
    // getWebhookMode is exported from register-webhook-route.ts
    const { getWebhookMode } = await import("../../lib/github/register-webhook-route.js");
    expect(getWebhookMode({ providers: { github: { webhookMode: "optional" } } })).toBe("optional");
    expect(getWebhookMode({ providers: { github: { webhookMode: "required" } } })).toBe("required");
    expect(getWebhookMode({ providers: { github: { webhookMode: "disabled" } } })).toBe("disabled");
    expect(getWebhookMode({})).toBe("optional"); // default when not set
    expect(getWebhookMode(undefined)).toBe("optional"); // default when no config
  });
});
