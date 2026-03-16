/**
 * Extract the agent-response JSON from stdout that may contain ANSI codes and
 * pino log lines (one JSON object per line) before the actual response JSON.
 *
 * Strategy: strip ANSI, split by newline, try each line as JSON (from the
 * last line backwards). Return the first object that has a `payloads` field
 * (agent response), falling back to the last parseable JSON object.
 */
export function extractJsonFromStdout(stdout: string): any {
  // Strip ANSI escape codes
  const stripped = stdout.replace(/\x1b\[[0-9;]*m/g, "");

  // Split into lines and try to parse each one as JSON (last → first priority)
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
    if (idx < 0) throw new Error("No JSON object found in stdout");
    return JSON.parse(stripped.slice(idx));
  }

  // Prefer the object with `payloads` (agent response), then the last one
  const withPayloads = parsed.findLast?.((o: any) => o?.payloads) ?? parsed.slice().reverse().find((o: any) => o?.payloads);
  return withPayloads ?? parsed[parsed.length - 1];
}
