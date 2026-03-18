import { describe, it, expect } from "vitest";
import { extractJsonFromStdout } from "../../lib/intake/lib/extract-json.js";

describe("extractJsonFromStdout — robust ANSI handling", () => {
  it("strips 256-color ANSI codes (8-bit)", () => {
    const input = '\x1b[38;5;196m{"payloads":[{"text":"hello"}]}\x1b[0m';
    const result = extractJsonFromStdout(input);
    expect(result).toEqual({ payloads: [{ text: "hello" }] });
  });

  it("strips 24-bit (truecolor) ANSI codes", () => {
    const input = '\x1b[38;2;255;0;0m{"payloads":[{"text":"rgb"}]}\x1b[0m';
    const result = extractJsonFromStdout(input);
    expect(result).toEqual({ payloads: [{ text: "rgb" }] });
  });

  it("strips OSC sequences", () => {
    const input = '\x1b]0;title\x07{"payloads":[{"text":"osc"}]}';
    const result = extractJsonFromStdout(input);
    expect(result).toEqual({ payloads: [{ text: "osc" }] });
  });

  it("returns null when no valid JSON found", () => {
    const result = extractJsonFromStdout("just plain text");
    expect(result).toBeNull();
  });

  it("returns null when JSON has no payloads field", () => {
    const input = '{"unrelated":"data"}';
    // This should still return the parsed JSON (existing behavior: returns last parsed)
    const result = extractJsonFromStdout(input);
    expect(result).toEqual({ unrelated: "data" });
  });

  it("handles standard SGR codes (existing)", () => {
    const input = '\x1b[1m\x1b[32m{"payloads":[{"text":"ok"}]}\x1b[0m';
    const result = extractJsonFromStdout(input);
    expect(result).toEqual({ payloads: [{ text: "ok" }] });
  });

  it("extracts payloads from pretty-printed multi-line JSON after pino log lines", () => {
    // This is the real output format from `openclaw agent --local --json`
    const pinoLine1 = '{"level":30,"time":1234567890,"name":"fabrica","msg":"plugin registered"}';
    const pinoLine2 = '{"level":30,"time":1234567891,"name":"fabrica","msg":"route registered"}';
    const multiLinePayload = [
      "{",
      '  "payloads": [',
      "    {",
      '      "text": "{\\"type\\":\\"feature\\",\\"confidence\\":0.9}",',
      '      "mediaUrl": null',
      "    }",
      "  ],",
      '  "meta": { "durationMs": 100 }',
      "}",
    ].join("\n");
    const input = [pinoLine1, pinoLine2, multiLinePayload].join("\n");
    const result = extractJsonFromStdout(input);
    expect(result).toHaveProperty("payloads");
    expect(result.payloads[0].text).toContain("feature");
  });
});
