import { describe, expect, it } from "vitest";
import { detectMime, jsonResult } from "../../lib/runtime/plugin-sdk-compat.js";

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47,
  0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

describe("plugin-sdk-compat", () => {
  it("jsonResult preserves the payload in both text and details", () => {
    expect(jsonResult({ ok: true, nested: { count: 2 } })).toEqual({
      content: [
        {
          type: "text",
          text: '{\n  "ok": true,\n  "nested": {\n    "count": 2\n  }\n}',
        },
      ],
      details: { ok: true, nested: { count: 2 } },
    });
  });

  it("detectMime prefers sniffed content and falls back to extension", async () => {
    await expect(
      detectMime({ filePath: "/tmp/example.bin", buffer: PNG_HEADER }),
    ).resolves.toBe("image/png");

    await expect(
      detectMime({ filePath: "/tmp/notes.md" }),
    ).resolves.toBe("text/markdown");
  });
});
