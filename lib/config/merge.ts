/**
 * config/merge.ts — Deep merge for Fabrica config layers.
 *
 * Merge semantics:
 * - Objects: recursively merge (sparse override)
 * - Arrays: replace entirely (no merging array elements)
 * - `false` for a role: marks it as disabled
 * - Primitives: override
 */
import type { FabricaConfig, RoleOverride } from "./types.js";
import type { StateConfig, TransitionTarget } from "../workflow/index.js";

// ---------------------------------------------------------------------------
// Traced merge (type, exported for consumers)
// ---------------------------------------------------------------------------

export type MergeTrace = Record<string, string>;

/**
 * Merge a config overlay on top of a base config.
 * Returns a new config — does not mutate inputs.
 *
 * When `traceOpts` is provided the returned object also carries a
 * `_trace` property (a dotted-path → layer-name map).  Callers that
 * only need the plain config can ignore it; `mergeConfigWithTrace`
 * strips it before returning.
 */
export function mergeConfig(
  base: FabricaConfig,
  overlay: FabricaConfig,
  traceOpts?: { baseLabel: string; overlayLabel: string },
): FabricaConfig & { _trace?: MergeTrace } {
  const merged: FabricaConfig = {};

  // Merge roles
  if (base.roles || overlay.roles) {
    merged.roles = { ...base.roles };
    if (overlay.roles) {
      for (const [roleId, overrideValue] of Object.entries(overlay.roles)) {
        if (overrideValue === false) {
          // Disable role
          merged.roles[roleId] = false;
        } else if (merged.roles[roleId] === false) {
          // Re-enable with override
          merged.roles[roleId] = overrideValue;
        } else {
          // Merge role override on top of base role
          const baseRole = merged.roles[roleId];
          merged.roles[roleId] = mergeRoleOverride(
            typeof baseRole === "object" ? baseRole : {},
            overrideValue,
          );
        }
      }
    }
  }

  // Merge workflow
  if (base.workflow || overlay.workflow) {
    merged.workflow = {
      initial: overlay.workflow?.initial ?? base.workflow?.initial,
      reviewPolicy: overlay.workflow?.reviewPolicy ?? base.workflow?.reviewPolicy,
      testPolicy: overlay.workflow?.testPolicy ?? base.workflow?.testPolicy,
      roleExecution: overlay.workflow?.roleExecution ?? base.workflow?.roleExecution,
      maxWorkersPerLevel: overlay.workflow?.maxWorkersPerLevel ?? base.workflow?.maxWorkersPerLevel,
      states: mergeWorkflowStates(base.workflow?.states, overlay.workflow?.states),
    };
    // Clean up undefined initial
    if (merged.workflow.initial === undefined) {
      delete merged.workflow.initial;
    }
  }

  // Merge timeouts
  if (base.timeouts || overlay.timeouts) {
    merged.timeouts = { ...base.timeouts, ...overlay.timeouts };
  }

  if (base.instance || overlay.instance) {
    merged.instance = { ...base.instance, ...overlay.instance };
  }

  if (traceOpts) {
    const { baseLabel, overlayLabel } = traceOpts;
    const trace: MergeTrace = {};

    // Trace workflow fields
    if (merged.workflow) {
      for (const key of ["initial", "reviewPolicy", "testPolicy", "roleExecution", "maxWorkersPerLevel"] as const) {
        if (merged.workflow[key] !== undefined) {
          const fromOverlay = overlay.workflow?.[key] !== undefined;
          trace[`workflow.${key}`] = fromOverlay ? overlayLabel : baseLabel;
        }
      }
    }

    // Trace timeout fields
    if (merged.timeouts) {
      for (const [key, value] of Object.entries(merged.timeouts)) {
        if (value !== undefined) {
          const fromOverlay = overlay.timeouts?.[key as keyof typeof overlay.timeouts] !== undefined;
          trace[`timeouts.${key}`] = fromOverlay ? overlayLabel : baseLabel;
        }
      }
    }

    // Trace role fields
    if (merged.roles) {
      for (const [roleId, roleValue] of Object.entries(merged.roles)) {
        if (roleValue === false) {
          trace[`roles.${roleId}`] = overlay.roles?.[roleId] === false ? overlayLabel : baseLabel;
          continue;
        }
        if (typeof roleValue === "object") {
          for (const key of ["defaultLevel", "levels", "completionResults"] as const) {
            if (roleValue[key] !== undefined) {
              const overlayRole = overlay.roles?.[roleId];
              const fromOverlay = typeof overlayRole === "object" && overlayRole?.[key] !== undefined;
              trace[`roles.${roleId}.${key}`] = fromOverlay ? overlayLabel : baseLabel;
            }
          }
        }
      }
    }

    return Object.assign(merged, { _trace: trace });
  }

  return merged;
}

function mergeWorkflowStates(
  base: Record<string, StateConfig> | undefined,
  overlay: Record<string, StateConfig> | undefined,
): Record<string, StateConfig> | undefined {
  if (!base && !overlay) return undefined;
  const merged: Record<string, StateConfig> = { ...(base ?? {}) };
  for (const [stateKey, overrideState] of Object.entries(overlay ?? {})) {
    const baseState = merged[stateKey];
    merged[stateKey] = mergeStateConfig(baseState, overrideState);
  }
  return merged;
}

function mergeStateConfig(
  base: StateConfig | undefined,
  overlay: StateConfig,
): StateConfig {
  if (!base) {
    return {
      ...overlay,
      on: overlay.on ? { ...overlay.on } : undefined,
    };
  }

  return {
    ...base,
    ...overlay,
    on: mergeTransitionMap(base.on, overlay.on),
  };
}

function mergeTransitionMap(
  base: Record<string, TransitionTarget> | undefined,
  overlay: Record<string, TransitionTarget> | undefined,
): Record<string, TransitionTarget> | undefined {
  if (!base && !overlay) return undefined;
  return {
    ...(base ?? {}),
    ...(overlay ?? {}),
  };
}

function mergeRoleOverride(
  base: RoleOverride,
  overlay: RoleOverride,
): RoleOverride {
  return {
    ...base,
    ...overlay,
    // Models: merge (don't replace)
    models: base.models || overlay.models
      ? { ...base.models, ...overlay.models }
      : undefined,
    // Emoji: merge (don't replace)
    emoji: base.emoji || overlay.emoji
      ? { ...base.emoji, ...overlay.emoji }
      : undefined,
    // Arrays replace entirely
    ...(overlay.levels ? { levels: overlay.levels } : {}),
    ...(overlay.completionResults ? { completionResults: overlay.completionResults } : {}),
  };
}

// ---------------------------------------------------------------------------
// Backward-compatible traced merge wrapper
// ---------------------------------------------------------------------------

/**
 * Thin wrapper around `mergeConfig` that strips the internal `_trace`
 * property and returns the classic `{ merged, trace }` shape.
 *
 * Kept for backward compatibility — no call-site changes required.
 */
export function mergeConfigWithTrace(
  base: FabricaConfig,
  overlay: FabricaConfig,
  baseLabel: string,
  overlayLabel: string,
): { merged: FabricaConfig; trace: MergeTrace } {
  const result = mergeConfig(base, overlay, { baseLabel, overlayLabel });
  const trace = (result as any)._trace ?? {};
  delete (result as any)._trace;
  return { merged: result, trace };
}
