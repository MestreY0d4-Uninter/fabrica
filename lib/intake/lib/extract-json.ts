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

  if (parsed.length === 0) {
    // Fallback: try parsing from the first '{' in the whole output
    const idx = stripped.indexOf("{");
    if (idx < 0) return null;
    try {
      return JSON.parse(stripped.slice(idx));
    } catch {
      return null;
    }
  }

  // Prefer the object with `payloads` (agent response), then the last one
  const withPayloads = parsed.slice().reverse().find((o: any) => o?.payloads);
  return withPayloads ?? parsed[parsed.length - 1];
}
