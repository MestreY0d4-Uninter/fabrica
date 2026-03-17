import { z } from "zod";

export const githubEventStatusSchema = z.enum(["pending", "processing", "success", "failed", "skipped"]);
export type GitHubEventStatus = z.infer<typeof githubEventStatusSchema>;

export const githubEventRecordSchema = z.object({
  deliveryId: z.string().min(1),
  eventName: z.string().min(1),
  action: z.string().min(1).nullable().optional(),
  installationId: z.number().int().positive().nullable(),
  repositoryId: z.number().int().positive().nullable(),
  prNumber: z.number().int().positive().nullable(),
  headSha: z.string().min(1).nullable(),
  receivedAt: z.string().min(1),
  processedAt: z.string().min(1).nullable(),
  status: githubEventStatusSchema,
  attemptCount: z.number().int().nonnegative().default(0),
  nextAttemptAt: z.string().min(1).nullable().default(null),
  lastErrorAt: z.string().min(1).nullable().default(null),
  deadLetter: z.boolean().default(false),
  runId: z.string().min(1).nullable().default(null),
  issueRuntimeId: z.string().min(1).nullable().default(null),
  checkRunId: z.number().int().positive().nullable().default(null),
  sessionKey: z.string().min(1).nullable().default(null),
  payload: z.unknown(),
  error: z.string().nullable(),
});
export type GitHubEventRecord = z.infer<typeof githubEventRecordSchema>;

export const fabricaRunStateSchema = z.enum([
  "planned",
  "running",
  "waiting_review",
  "tests_running",
  "gate",
  "repairing",
  "passed",
  "failed",
  "aborted",
]);
export type FabricaRunState = z.infer<typeof fabricaRunStateSchema>;

export const fabricaRunSchema = z.object({
  runId: z.string().min(1),
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  prNumber: z.number().int().positive(),
  headSha: z.string().min(1),
  issueRuntimeId: z.string().min(1).nullable(),
  state: fabricaRunStateSchema,
  checkRunId: z.number().int().positive().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type FabricaRun = z.infer<typeof fabricaRunSchema>;

export type GitHubEventMetadata = Pick<
  GitHubEventRecord,
  "installationId" | "repositoryId" | "prNumber" | "headSha"
>;
