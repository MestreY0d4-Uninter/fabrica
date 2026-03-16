export type GenesisArgs = {
  rawIdea: string;
  stackHint?: string;
  projectName?: string;
  channelId: string;
  dryRun: boolean;
  error?: string;
};

const DEFAULT_CHANNEL_ID = "-1003709213169";

export function parseGenesisArgs(args: string[]): GenesisArgs {
  const dryRun = args.includes("--dry-run");

  const flagPairs = ["--stack", "--name", "--channel-id"] as const;
  const skipIdxs = new Set<number>();

  for (const flag of flagPairs) {
    const idx = args.indexOf(flag);
    if (idx !== -1) {
      if (idx + 1 >= args.length || args[idx + 1].startsWith("--")) {
        return { rawIdea: "", channelId: "", dryRun, error: `${flag} requires a value` };
      }
      skipIdxs.add(idx);
      skipIdxs.add(idx + 1);
    }
  }
  if (args.indexOf("--dry-run") !== -1) skipIdxs.add(args.indexOf("--dry-run"));

  const rawIdea = args
    .filter((a, i) => !a.startsWith("--") && !skipIdxs.has(i))
    .join(" ")
    .trim();

  if (!rawIdea) {
    return { rawIdea: "", channelId: "", dryRun, error: "Raw idea is required" };
  }

  const stackIdx = args.indexOf("--stack");
  const stackHint = stackIdx !== -1 ? args[stackIdx + 1] : undefined;

  const nameIdx = args.indexOf("--name");
  const projectName = nameIdx !== -1 ? args[nameIdx + 1] : undefined;

  const channelIdx = args.indexOf("--channel-id");
  const rawChannelId = channelIdx !== -1
    ? args[channelIdx + 1]
    : (process.env.FABRICA_PROJECTS_CHANNEL_ID || DEFAULT_CHANNEL_ID);

  if (isNaN(parseInt(rawChannelId, 10))) {
    const channelError = channelIdx !== -1
      ? "--channel-id must be a numeric value"
      : "channel ID (from FABRICA_PROJECTS_CHANNEL_ID or default) must be a numeric value";
    return { rawIdea, channelId: "", dryRun, error: channelError };
  }

  return { rawIdea, stackHint, projectName, channelId: rawChannelId, dryRun };
}
