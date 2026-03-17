/**
 * Step 6: Impact analysis.
 * Estimates change scope for both greenfield and existing projects.
 */
import type { PipelineStep, GenesisPayload, Impact } from "../types.js";

export const impactStep: PipelineStep = {
  name: "impact-analysis",

  shouldRun: (payload) => !!payload.spec,

  async execute(payload, ctx): Promise<GenesisPayload> {
    const spec = payload.spec!;
    const map = payload.project_map;
    const isGreenfield = map?.is_greenfield ?? !payload.metadata?.repo_url;

    ctx.log(`Impact analysis: greenfield=${isGreenfield}`);

    let impact: Impact;

    if (isGreenfield) {
      // Estimate from scope items
      const scopeItems = spec.scope_v1.length;
      const estimatedFiles = Math.max(3, scopeItems * 2);
      impact = {
        is_greenfield: true,
        affected_files: [],
        affected_modules: [],
        new_files_needed: spec.scope_v1.map((s, i) => `module-${i + 1}`),
        risk_areas: spec.risks,
        estimated_files_changed: estimatedFiles,
        confidence: "high",
      };
    } else {
      // Keyword-match spec against mapped symbols and modules
      const symbols = map?.symbols ?? [];
      const modules = map?.modules ?? [];
      const specText = `${spec.title} ${spec.objective} ${spec.scope_v1.join(" ")}`.toLowerCase();
      const affected = symbols
        .filter(s => specText.includes(s.name.toLowerCase()))
        .map(s => s.file);
      const unique = [...new Set(affected)];
      const affectedModules = modules.filter((moduleName) => specText.includes(moduleName.toLowerCase()));
      const confidence =
        map?.confidence === "low" || (!unique.length && !affectedModules.length)
          ? "low"
          : "high";

      impact = {
        is_greenfield: false,
        affected_files: unique,
        affected_modules: [...new Set(affectedModules)],
        new_files_needed: [],
        risk_areas: spec.risks,
        estimated_files_changed: Math.max(1, unique.length || affectedModules.length),
        confidence,
      };
    }

    return {
      ...payload,
      step: "impact",
      impact,
    };
  },
};
