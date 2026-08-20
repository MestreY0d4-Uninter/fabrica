export function isGatewayServerProcess(argv: string[] = process.argv): boolean {
  const cliArgs = argv.slice(2);
  // An explicit command is authoritative.  The service marker is useful for
  // the gateway's process supervisor, but must not turn commands such as
  // `openclaw plugins doctor` into gateway runtime (which would enable
  // gateway-only telemetry and warnings).
  if (cliArgs[0] && cliArgs[0] !== "gateway") return false;
  if (cliArgs[0] === "gateway" && cliArgs[1] && !cliArgs[1].startsWith("-")) return false;
  if (process.env.OPENCLAW_SERVICE_KIND === "gateway") return true;
  if (cliArgs[0] !== "gateway") return false;
  const next = cliArgs[1];
  return !next || next.startsWith("-");
}

export function isExplicitCliTelemetryEnabled(): boolean {
  return process.env.FABRICA_ENABLE_CLI_TELEMETRY === "true";
}
