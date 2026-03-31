import { describe, expect, it, vi, beforeEach } from "vitest";
import type { GenesisPayload, StepContext } from "../../lib/intake/types.js";

const { mockAuditLog, mockRegisterExecute, mockCreateTaskExecute } = vi.hoisted(() => ({
  mockAuditLog: vi.fn(),
  mockRegisterExecute: vi.fn(),
  mockCreateTaskExecute: vi.fn(),
}));

vi.mock("../../lib/audit.js", () => ({
  log: mockAuditLog,
}));

vi.mock("../../lib/intake/steps/receive.js", () => ({
  receiveStep: {
    name: "receive",
    shouldRun: () => true,
    execute: async (payload: GenesisPayload) => ({ ...payload, step: "receive" }),
  },
}));

vi.mock("../../lib/intake/steps/classify.js", () => ({
  classifyStep: { name: "classify", shouldRun: () => false, execute: vi.fn() },
}));
vi.mock("../../lib/intake/steps/research.js", () => ({
  researchStep: { name: "research", shouldRun: () => false, execute: vi.fn() },
}));
vi.mock("../../lib/intake/steps/interview.js", () => ({
  interviewStep: { name: "interview", shouldRun: () => false, execute: vi.fn() },
}));
vi.mock("../../lib/intake/steps/conduct-interview.js", () => ({
  conductInterviewStep: { name: "conduct-interview", shouldRun: () => false, execute: vi.fn() },
}));
vi.mock("../../lib/intake/steps/generate-spec.js", () => ({
  generateSpecStep: { name: "generate-spec", shouldRun: () => false, execute: vi.fn() },
}));
vi.mock("../../lib/intake/steps/map-project.js", () => ({
  mapProjectStep: { name: "map-project", shouldRun: () => false, execute: vi.fn() },
}));
vi.mock("../../lib/intake/steps/impact.js", () => ({
  impactStep: { name: "impact", shouldRun: () => false, execute: vi.fn() },
}));
vi.mock("../../lib/intake/steps/scaffold.js", () => ({
  scaffoldStep: { name: "scaffold", shouldRun: () => false, execute: vi.fn() },
  scaffoldPassthroughStep: { name: "scaffold-passthrough", shouldRun: () => false, execute: vi.fn() },
}));
vi.mock("../../lib/intake/steps/provision-repo.js", () => ({
  provisionRepoStep: { name: "provision-repo", shouldRun: () => false, execute: vi.fn() },
}));
vi.mock("../../lib/intake/steps/register.js", () => ({
  registerStep: {
    name: "register",
    shouldRun: () => true,
    execute: (payload: GenesisPayload, ctx: StepContext) => mockRegisterExecute(payload, ctx),
  },
}));
vi.mock("../../lib/intake/steps/qa-contract.js", () => ({
  qaContractStep: { name: "qa-contract", shouldRun: () => false, execute: vi.fn() },
}));
vi.mock("../../lib/intake/steps/security-review.js", () => ({
  securityReviewStep: { name: "security-review", shouldRun: () => false, execute: vi.fn() },
}));
vi.mock("../../lib/intake/steps/create-task.js", () => ({
  createTaskStep: {
    name: "create-task",
    shouldRun: () => true,
    execute: (payload: GenesisPayload, ctx: StepContext) => mockCreateTaskExecute(payload, ctx),
  },
}));
vi.mock("../../lib/intake/steps/triage.js", () => ({
  triageStep: { name: "triage", shouldRun: () => false, execute: vi.fn() },
}));

import { runPipeline } from "../../lib/intake/pipeline.js";

function makePayload(overrides: Partial<GenesisPayload> = {}): GenesisPayload {
  return {
    session_id: "pipeline-telegram-artifacts",
    timestamp: "2026-03-31T16:00:00Z",
    step: "init",
    raw_idea: "Criar projeto",
    answers: {},
    metadata: {
      source: "telegram-dm-bootstrap",
      factory_change: false,
      channel_id: "6951571380",
    },
    ...overrides,
  };
}

function makeCtx(): StepContext {
  return {
    runCommand: vi.fn(),
    log: vi.fn(),
    homeDir: "/home/test",
    workspaceDir: "/home/test/.openclaw/workspace",
  };
}

describe("runPipeline Telegram artifact tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces a created Telegram topic as an artifact when a later step fails", async () => {
    mockRegisterExecute.mockResolvedValue({
      ...makePayload(),
      step: "register",
      metadata: {
        source: "telegram-dm-bootstrap",
        factory_change: false,
        project_registered: true,
        project_topic_created: true,
        channel_id: "-1003709213169",
        message_thread_id: 501,
      },
    });
    mockCreateTaskExecute.mockRejectedValue(new Error("synthetic create-task failure"));

    const result = await runPipeline(makePayload(), makeCtx());

    expect(result.success).toBe(false);
    expect(result.artifacts).toEqual([
      { type: "forum_topic", id: "telegram:-1003709213169:501" },
    ]);
    expect(mockAuditLog).toHaveBeenCalledWith(
      "/home/test/.openclaw/workspace",
      "pipeline_orphaned_artifacts",
      expect.objectContaining({
        artifacts: [{ type: "forum_topic", id: "telegram:-1003709213169:501" }],
      }),
    );
  });

  it("includes partial forum-topic artifacts attached to a failing register step", async () => {
    const err = new Error("synthetic register failure") as Error & {
      artifacts?: Array<{ type: "forum_topic"; id: string }>;
    };
    err.artifacts = [{ type: "forum_topic", id: "telegram:-1003709213169:502" }];
    mockRegisterExecute.mockRejectedValue(err);

    const result = await runPipeline(makePayload(), makeCtx());

    expect(result.success).toBe(false);
    expect(result.artifacts).toEqual([
      { type: "forum_topic", id: "telegram:-1003709213169:502" },
    ]);
    expect(mockAuditLog).toHaveBeenCalledWith(
      "/home/test/.openclaw/workspace",
      "pipeline_orphaned_artifacts",
      expect.objectContaining({
        artifacts: [{ type: "forum_topic", id: "telegram:-1003709213169:502" }],
      }),
    );
  });
});
