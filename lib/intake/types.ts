/**
 * intake/types.ts — Pipeline payload types for the Genesis pipeline.
 *
 * The pipeline flows a single GenesisPayload through all steps.
 * Each step enriches the payload with its output.
 */

// ---------------------------------------------------------------------------
// Enums / Literals
// ---------------------------------------------------------------------------

export type IdeaType = "feature" | "bugfix" | "refactor" | "research" | "infra";

export type DeliveryTarget = "web-ui" | "api" | "cli" | "hybrid" | "unknown";

export type CanonicalStack =
  | "nextjs"
  | "node-cli"
  | "express"
  | "fastapi"
  | "flask"
  | "django"
  | "python-cli"
  | "go"
  | "java";

export type TriagePriority = "P0" | "P1" | "P2" | "P3";

export type TriageEffort = "small" | "medium" | "large" | "xlarge";

export type GenesisAnswers = Record<string, string>;

export type GenesisAnswersJson = Record<string, unknown>;

export type GenesisPhase = "discover" | "commit";

export type GenesisSessionContract = {
  version: number;
  discover_complete: boolean;
  persisted_at: string;
  input_fingerprint: string;
  phase: GenesisPhase;
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type Classification = {
  type: IdeaType;
  confidence: number;
  alternatives?: Array<{ type: IdeaType; confidence: number }>;
  reasoning: string;
  delivery_target: DeliveryTarget;
};

// ---------------------------------------------------------------------------
// Research (optional)
// ---------------------------------------------------------------------------

export type Research = {
  status?: "ok" | "skipped" | "degraded";
  summary?: string;
  technologies: string[];
  best_practices: string[];
  architecture_patterns: string[];
  references: Array<{
    title: string;
    url: string;
  }>;
};

// ---------------------------------------------------------------------------
// Interview
// ---------------------------------------------------------------------------

export type InterviewQuestion = {
  id: string;
  question: string;
  required: boolean;
  follow_up_if_vague?: string | null;
};

export type Interview = {
  questions: InterviewQuestion[];
  guidelines: string;
  spec_data?: SpecData;
};

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

export type SpecData = {
  project_slug?: string;
  title: string;
  objective: string;
  scope_v1: string[];
  out_of_scope: string[];
  acceptance_criteria: string[];
  definition_of_done: string[];
  constraints: string;
  risks: string[];
  delivery_target?: DeliveryTarget;
};

export type Spec = {
  title: string;
  type: IdeaType;
  objective: string;
  scope_v1: string[];
  out_of_scope: string[];
  acceptance_criteria: string[];
  definition_of_done: string[];
  constraints: string;
  risks: string[];
  delivery_target: DeliveryTarget;
};

// ---------------------------------------------------------------------------
// Project Map
// ---------------------------------------------------------------------------

export type ProjectMap = {
  version: string;
  project: string;
  root: string | null;
  repo_url?: string | null;
  is_greenfield: boolean;
  remote_only?: boolean;
  confidence?: "high" | "low";
  project_slug?: string | null;
  project_kind?: string | null;
  archived?: boolean;
  modules?: string[];
  note?: string | null;
  stats: {
    languages: string[];
    symbol_count: number;
    files_scanned?: number;
  };
  symbols: Array<{
    name: string;
    kind: string;
    file: string;
    line?: number;
  }>;
};

// ---------------------------------------------------------------------------
// Impact Analysis
// ---------------------------------------------------------------------------

export type Impact = {
  is_greenfield: boolean;
  affected_files: string[];
  affected_modules: string[];
  new_files_needed: string[];
  risk_areas: string[];
  estimated_files_changed: number;
  confidence?: "high" | "low";
};

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

export type Scaffold = {
  created: boolean;
  reason?: string;
  stack?: CanonicalStack;
  repo_url?: string;
  repo_local?: string;
  project_slug?: string;
  files_created?: string[];
};

export type ScaffoldPlan = {
  version: 1;
  owner: string;
  repo_name: string;
  repo_url: string;
  repo_local: string;
  project_slug: string;
  stack: CanonicalStack;
  objective: string;
  delivery_target: DeliveryTarget;
  repo_target_source: string;
};

export type RepositoryProvisioningMode = "greenfield" | "remote_only" | "existing_local";

export type RepositoryProvisioning = {
  ready: boolean;
  provider: "github" | "gitlab" | "unknown";
  mode: RepositoryProvisioningMode;
  repo_url?: string | null;
  repo_local?: string | null;
  default_branch?: string | null;
  created?: boolean;
  cloned?: boolean;
  seeded?: boolean;
  reason?: string;
};

// ---------------------------------------------------------------------------
// QA Contract
// ---------------------------------------------------------------------------

export type QaContract = {
  gates: string[];
  acceptance_tests: string[];
  script_content: string;
};

// ---------------------------------------------------------------------------
// Security Review
// ---------------------------------------------------------------------------

export type SecurityReview = {
  audit_ran: boolean;
  score?: number;
  findings: string[];
  spec_security_notes: string[];
  recommendation: string;
};

// ---------------------------------------------------------------------------
// Issue (from create-task)
// ---------------------------------------------------------------------------

export type CreatedIssue = {
  number: number;
  url: string;
  created_at: string;
};

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

export type Triage = {
  priority: TriagePriority;
  effort: TriageEffort;
  target_state: string;
  project_slug: string | null;
  project_channel_id: string | null;
  labels_applied: string[];
  issue_number: number;
  ready_for_dispatch: boolean;
  errors: string[];
};

// ---------------------------------------------------------------------------
// Auth Gate Metadata
// ---------------------------------------------------------------------------

export type AuthGate = {
  signal: boolean;
  evidence: boolean;
};

// ---------------------------------------------------------------------------
// Pipeline Metadata
// ---------------------------------------------------------------------------

export type PipelineMetadata = {
  source: string;
  repo_url?: string | null;
  repo_path?: string | null;
  repo_target?: string | null;
  repo_target_source?: string | null;
  project_name?: string | null;
  project_slug?: string | null;
  project_kind?: string | null;
  stack_hint?: string | null;
  stack_confidence?: "high" | "low" | null;
  research_summary?: string | null;
  command?: string | null;
  timeout_ms?: number | null;
  answers_json?: GenesisAnswersJson | null;
  genesis_contract?: GenesisSessionContract | null;
  factory_change: boolean;
  delivery_target?: DeliveryTarget;
  auth_gate?: AuthGate;
  project_registered?: boolean;
  message_thread_id?: number;
  channel_id?: string | null;
  scaffold_plan?: ScaffoldPlan | null;
  repo_provisioned?: boolean;
  needs_spec_refinement?: boolean;
  needs_human_security?: boolean;
};

// ---------------------------------------------------------------------------
// Full Pipeline Payload
// ---------------------------------------------------------------------------

export type GenesisPayload = {
  session_id: string;
  timestamp: string;
  step: string;
  raw_idea: string;
  answers: GenesisAnswers;
  dry_run?: boolean;

  metadata: PipelineMetadata;

  // Enriched by steps:
  classification?: Classification;
  research?: Research;
  interview?: Interview;
  spec_data?: SpecData;
  spec?: Spec;
  project_map?: ProjectMap;
  impact?: Impact;
  scaffold?: Scaffold;
  provisioning?: RepositoryProvisioning;
  project_registered?: boolean;
  qa_contract?: QaContract;
  security?: SecurityReview;
  issues?: CreatedIssue[];
  triage?: Triage;
};

// ---------------------------------------------------------------------------
// Pipeline Artifacts
// ---------------------------------------------------------------------------

/**
 * Artifact created during the pipeline that should be tracked for cleanup
 * if the pipeline fails partway through (e.g. repo created but project not registered).
 *
 * Note: "forum_topic" is defined for future use. deriveArtifacts() does not yet
 * derive forum topics because topic IDs are available only after registerStep completes.
 * If registerStep itself fails after topic creation, the topic would be orphaned but
 * is not currently tracked here.
 */
export type PipelineArtifact = {
  type: "github_repo" | "gitlab_repo" | "forum_topic" | "github_issue";
  id: string;
};

// ---------------------------------------------------------------------------
// Step interface
// ---------------------------------------------------------------------------

export type StepContext = {
  /** Run external commands via OpenClaw gateway */
  runCommand: (
    cmd: string,
    args: string[],
    opts?: { timeout?: number; cwd?: string; env?: Record<string, string | undefined> },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Create a provider for issue/label side-effects in the current repository context. */
  createIssueProvider?: (
    opts: {
      repoPath?: string;
      repo?: string;
      projectSlug?: string | null;
      provider?: "github" | "gitlab";
      providerProfile?: string;
    },
  ) => Promise<{
    provider: import("../providers/provider.js").IssueProvider;
    type: "github" | "gitlab";
  }>;
  /** Logger */
  log: (msg: string) => void;
  /** Home directory */
  homeDir: string;
  /** Workspace directory (OpenClaw agent workspace) */
  workspaceDir: string;
  /** Optional runtime for channel-aware operations during intake. */
  runtime?: import("openclaw/plugin-sdk").PluginRuntime;
  /** Optional full OpenClaw config for channel actions during intake. */
  config?: Record<string, unknown>;
  /** Optional Fabrica plugin config for intake decisions. */
  pluginConfig?: Record<string, unknown>;
};

export type PipelineStep = {
  name: string;
  /** Returns true if this step should run for the given payload */
  shouldRun: (payload: GenesisPayload) => boolean;
  /** Execute the step, returning the enriched payload */
  execute: (payload: GenesisPayload, ctx: StepContext) => Promise<GenesisPayload>;
};
