/**
 * Extract the agent-response JSON from stdout that may contain ANSI codes and
 * pino log lines (one JSON object per line) before the actual response JSON.
 *
 * Strategy: strip ALL ANSI escape sequences (SGR, 256-color, truecolor, OSC),
 * split by newline, try each line as JSON (from the last line backwards).
 * Return the first object that has a `payloads` field (agent response),
 * falling back to the last parseable JSON object.
 * Returns null if no valid JSON found.
 */

// Comprehensive ANSI strip: SGR, 8-bit, 24-bit, cursor, OSC, CSI
const ANSI_REGEX = /\x1b(?:\[[0-9;]*[A-Za-z]|\].*?(?:\x07|\x1b\\)|\[[0-9;]*m)/g;

export function extractJsonFromStdout(stdout: string): any {
  const stripped = stdout.replace(ANSI_REGEX, "");

  const lines = stripped.split("\n").filter((l) => l.trim().startsWith("{"));
  const parsed: any[] = [];

  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line.trim()));
    } catch {
      // skip non-JSON or malformed lines
    }
  }

  // Prefer the object with `payloads` (agent response) from per-line parse
  const withPayloads = parsed.slice().reverse().find((o: any) => o?.payloads);
  if (withPayloads) return withPayloads;

  // Try to find a multi-line JSON block (e.g., pretty-printed response object).
  // Scan backward for a line that is just '{' and try parsing from there.
  const lineArray = stripped.split("\n");
  for (let i = lineArray.length - 1; i >= 0; i--) {
    if (lineArray[i]!.trim() === "{") {
      const candidate = lineArray.slice(i).join("\n");
      try {
        const obj = JSON.parse(candidate);
        return obj;
      } catch {
        continue;
      }
    }
  }

  if (parsed.length > 0) return parsed[parsed.length - 1];

  // Last resort: try parsing from the first '{' in the whole output
  const idx = stripped.indexOf("{");
  if (idx < 0) return null;
  try {
    return JSON.parse(stripped.slice(idx));
  } catch {
    return null;
  }
}
