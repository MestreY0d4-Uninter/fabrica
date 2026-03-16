type TopicParams = {
  botToken?: string;
  slug: string;
  channelId: string;
  error?: string;
};

export function resolveTopicCreationParams(opts: {
  envPath: string;
  envContent: string | null;
  slug: string;
  channelId: string;
}): TopicParams {
  if (opts.envContent === null) {
    return { slug: opts.slug, channelId: opts.channelId, error: `Could not read ${opts.envPath} — .env file missing` };
  }

  const match = opts.envContent.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
  const botToken = match?.[1]?.trim();

  if (!botToken) {
    return { slug: opts.slug, channelId: opts.channelId, error: "TELEGRAM_BOT_TOKEN not found in .env" };
  }

  if (!opts.slug) {
    return { botToken, slug: opts.slug, channelId: opts.channelId, error: "Cannot create topic: project slug is empty" };
  }

  if (!opts.channelId) {
    return { botToken, slug: opts.slug, channelId: opts.channelId, error: "Cannot create topic: channel ID is empty" };
  }

  return { botToken, slug: opts.slug, channelId: opts.channelId };
}
