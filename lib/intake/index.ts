/**
 * intake/index.ts — Public API for the Genesis intake pipeline.
 */
export { runPipeline, type PipelineResult } from "./pipeline.js";
export type {
  GenesisPayload,
  StepContext,
  PipelineStep,
  Classification,
  Research,
  Spec,
  ProjectMap,
  Impact,
  Scaffold,
  ScaffoldPlan,
  QaContract,
  SecurityReview,
  Triage,
  DeliveryTarget,
  CanonicalStack,
  IdeaType,
  GenesisAnswers,
  GenesisAnswersJson,
  GenesisPhase,
  GenesisSessionContract,
  PipelineMetadata,
} from "./types.js";
