export function buildForumTopicArtifactId(channelId: string, messageThreadId: number): string {
  return `telegram:${channelId}:${messageThreadId}`;
}
