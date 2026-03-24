/**
 * roles/registry.ts — Single source of truth for all worker roles.
 *
 * Adding a new role? Just add an entry here. Everything else derives from this.
 *
 * Each role defines:
 * - Identity (id, displayName)
 * - Levels and models
 * - Emoji for announcements
 * - Valid completion results
 * - Session key matching
 * - Notification preferences
 */
import type { RoleConfig } from "./types.js";

export const ROLE_REGISTRY: Record<string, RoleConfig> = {
  developer: {
    id: "developer",
    displayName: "DEVELOPER",
    levels: ["junior", "medior", "senior"],
    defaultLevel: "medior",
    models: {
      junior: "openai-codex/gpt-5.3-codex-spark",
      medior: "openai-codex/gpt-5.3-codex",
      senior: "openai-codex/gpt-5.4",
    },
    emoji: {
      junior: "⚡",
      medior: "🔧",
      senior: "🧠",
    },
    fallbackEmoji: "🔧",
    completionResults: ["done", "blocked"],
    sessionKeyPattern: "developer",
    notifications: { onStart: true, onComplete: true },
  },

  tester: {
    id: "tester",
    displayName: "TESTER",
    levels: ["junior", "medior", "senior"],
    defaultLevel: "medior",
    models: {
      junior: "openai-codex/gpt-5.3-codex-spark",
      medior: "openai-codex/gpt-5.4",
      senior: "openai-codex/gpt-5.4",
    },
    emoji: {
      junior: "⚡",
      medior: "🔍",
      senior: "🧠",
    },
    fallbackEmoji: "🔍",
    completionResults: ["pass", "fail", "fail_infra", "refine", "blocked"],
    sessionKeyPattern: "tester",
    notifications: { onStart: true, onComplete: true },
  },

  architect: {
    id: "architect",
    displayName: "ARCHITECT",
    levels: ["junior", "senior"],
    defaultLevel: "junior",
    models: {
      junior: "openai-codex/gpt-5.4",
      senior: "openai-codex/gpt-5.4",
    },
    emoji: {
      junior: "📐",
      senior: "🏗️",
    },
    fallbackEmoji: "🏗️",
    completionResults: ["done", "blocked"],
    sessionKeyPattern: "architect",
    notifications: { onStart: true, onComplete: true },
  },

  reviewer: {
    id: "reviewer",
    displayName: "REVIEWER",
    levels: ["junior", "senior"],
    defaultLevel: "junior",
    models: {
      junior: "openai-codex/gpt-5.4",
      senior: "openai-codex/gpt-5.4",
    },
    emoji: {
      junior: "👁️",
      senior: "🔬",
    },
    fallbackEmoji: "👁️",
    completionResults: ["approve", "reject", "blocked"],
    sessionKeyPattern: "reviewer",
    notifications: { onStart: true, onComplete: true },
  },
};
