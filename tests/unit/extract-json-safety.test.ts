import { describe, it, expect } from "vitest";
import { extractJsonFromStdout } from "../../lib/intake/lib/extract-json.js";

describe("extractJsonFromStdout safety", () => {
  it("strips __proto__ keys from parsed objects", () => {
    const malicious = '{"__proto__": {"polluted": true}, "name": "test"}';
    const result = extractJsonFromStdout(malicious);
    expect(result).toBeDefined();
    expect((result as any).__proto__?.polluted).toBeUndefined();
    expect((result as any).name).toBe("test");
  });

  it("strips constructor and prototype keys", () => {
    const malicious = '{"constructor": {"evil": true}, "prototype": {"bad": true}, "ok": 1}';
    const result = extractJsonFromStdout(malicious);
    expect(result).toBeDefined();
    expect((result as any).constructor?.evil).toBeUndefined();
    expect((result as any).ok).toBe(1);
  });

  it("strips dangerous keys from nested arrays", () => {
    const malicious = '[{"__proto__": {"x": 1}, "name": "a"}]';
    const result = extractJsonFromStdout(malicious);
    if (Array.isArray(result)) {
      expect((result[0] as any).__proto__?.x).toBeUndefined();
      expect((result[0] as any).name).toBe("a");
    }
  });

  it("does not use first-{ last-resort parser (returns null for garbled input)", () => {
    const garbled = "some random text { not really json } more text";
    const result = extractJsonFromStdout(garbled);
    expect(result).toBeNull();
  });
});
