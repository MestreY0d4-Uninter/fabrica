import { describe, expect, it } from "vitest";
import { detectMime, jsonResult } from "../../lib/runtime/plugin-sdk-compat.js";

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47,
  0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

describe("plugin-sdk-compat", () => {
  it("jsonResult preserves the payload in both text and details", () => {
    const payload = { ok: true, nested: { count: 2 } };
    const result = jsonResult(payload);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "text",
      text: JSON.stringify(payload, null, 2),
    });
    expect(result.details).toBe(payload);
  });

  it("detectMime prefers sniffed content and falls back to extension", async () => {
    await expect(
      detectMime({ filePath: "/tmp/example.bin", buffer: PNG_HEADER }),
    ).resolves.toBe("image/png");

    await expect(
      detectMime({ filePath: "/tmp/notes.md" }),
    ).resolves.toBe("text/markdown");
  });

  it("detectMime honors header MIME when sniffing and extension are absent", async () => {
    await expect(
      detectMime({ headerMime: "application/pdf; charset=utf-8" }),
    ).resolves.toBe("application/pdf");
  });
});
