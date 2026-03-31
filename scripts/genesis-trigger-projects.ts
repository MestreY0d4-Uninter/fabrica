type UpdateResult = { success: boolean; error?: string };

export async function updateProjectTopic(_opts: {
  workspaceDir: string;
  slug: string;
  channelId: string;
  messageThreadId: number;
}): Promise<UpdateResult> {
  return {
    success: false,
    error: "Post-hoc Telegram topic patching has been removed. Topic association must happen inside project registration.",
  };
}
