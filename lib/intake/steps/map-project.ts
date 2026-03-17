import type { GenesisPayload, PipelineStep } from "../types.js";
import { buildProjectMap, resolveProjectTarget } from "../lib/project-map.js";

export const mapProjectStep: PipelineStep = {
  name: "map-project",

  shouldRun: (payload) => !!payload.spec,

  async execute(payload, ctx): Promise<GenesisPayload> {
    const resolved = await resolveProjectTarget(payload, ctx.workspaceDir, ctx.homeDir);
    const projectMap = await buildProjectMap(resolved);

    ctx.log(
      `Project mapped: greenfield=${projectMap.is_greenfield}, remote_only=${projectMap.remote_only ?? false}, slug=${resolved.project_slug ?? "none"}`,
    );

    return {
      ...payload,
      step: "map-project",
      project_map: projectMap,
      metadata: {
        ...payload.metadata,
        repo_url: resolved.repo_url,
        repo_path: resolved.repo_path,
        project_name: resolved.project_name,
        project_slug: resolved.project_slug,
        project_kind: resolved.project_kind,
        repo_target_source: resolved.repo_target_source,
      },
    };
  },
};
