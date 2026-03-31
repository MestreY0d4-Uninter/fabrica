import { describe, expect, it } from "vitest";
import { detectMime, jsonResult } from "../../lib/runtime/plugin-sdk-compat.js";

const VALID_PNG_SAMPLE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00,
  0x02, 0x00, 0x01, 0xe2, 0x26, 0x05, 0x9b, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);
const TRUNCATED_PNG_HEADER = Buffer.from([
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
      detectMime({ filePath: "/tmp/example.bin", buffer: VALID_PNG_SAMPLE }),
    ).resolves.toBe("image/png");

    await expect(
      detectMime({ filePath: "/tmp/notes.md" }),
    ).resolves.toBe("text/markdown");
  });

  it("falls back to extension when sniffing throws", async () => {
    await expect(
      detectMime({
        filePath: "/tmp/truncated.txt",
        buffer: TRUNCATED_PNG_HEADER,
      }),
    ).resolves.toBe("text/plain");
  });

  it("detectMime honors header MIME when sniffing and extension are absent", async () => {
    await expect(
      detectMime({ headerMime: "application/pdf; charset=utf-8" }),
    ).resolves.toBe("application/pdf");
  });
});
