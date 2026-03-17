import type {
  CanonicalStack,
  Classification,
  DeliveryTarget,
  PipelineMetadata,
  Research,
} from "../types.js";
import {
  detectStackFromDeliveryTarget,
  detectStackFromText,
  normalizeStackHint,
} from "./stack-detection.js";

type Reference = Research["references"][number];

const STACK_REFERENCE_MAP: Record<CanonicalStack, Reference[]> = {
  nextjs: [
    { title: "Next.js Documentation", url: "https://nextjs.org/docs" },
    { title: "React Documentation", url: "https://react.dev/" },
  ],
  "node-cli": [
    { title: "Node.js Documentation", url: "https://nodejs.org/docs/latest/api/" },
    { title: "TypeScript Handbook", url: "https://www.typescriptlang.org/docs/" },
  ],
  express: [
    { title: "Express Documentation", url: "https://expressjs.com/" },
    { title: "Node.js Documentation", url: "https://nodejs.org/docs/latest/api/" },
  ],
  fastapi: [
    { title: "FastAPI Documentation", url: "https://fastapi.tiangolo.com/" },
    { title: "Pydantic Documentation", url: "https://docs.pydantic.dev/latest/" },
  ],
  flask: [
    { title: "Flask Documentation", url: "https://flask.palletsprojects.com/" },
    { title: "Werkzeug Documentation", url: "https://werkzeug.palletsprojects.com/" },
  ],
  django: [
    { title: "Django Documentation", url: "https://docs.djangoproject.com/" },
  ],
  "python-cli": [
    { title: "Python argparse", url: "https://docs.python.org/3/library/argparse.html" },
    { title: "Typer Documentation", url: "https://typer.tiangolo.com/" },
  ],
  go: [
    { title: "Go Documentation", url: "https://go.dev/doc/" },
    { title: "Go Modules Reference", url: "https://go.dev/ref/mod" },
  ],
  java: [
    { title: "Spring Boot Reference", url: "https://docs.spring.io/spring-boot/documentation.html" },
    { title: "Maven Getting Started", url: "https://maven.apache.org/guides/getting-started/" },
  ],
};

const DELIVERY_REFERENCE_MAP: Partial<Record<DeliveryTarget, Reference[]>> = {
  cli: [
    { title: "Nix.dev", url: "https://nix.dev/" },
    { title: "direnv", url: "https://direnv.net/" },
  ],
  api: [
    { title: "OWASP API Security Top 10", url: "https://owasp.org/API-Security/" },
  ],
  "web-ui": [
    { title: "MDN Web Docs", url: "https://developer.mozilla.org/" },
  ],
};

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueReferences(values: Reference[]): Reference[] {
  const seen = new Set<string>();
  const refs: Reference[] = [];
  for (const ref of values) {
    const title = ref.title.trim();
    const url = ref.url.trim();
    if (!title || !url) continue;
    const key = `${title}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ title, url });
  }
  return refs;
}

function maybeReference(
  condition: boolean,
  reference: Reference,
): Reference[] {
  return condition ? [reference] : [];
}

function inferStack(metadata: PipelineMetadata, rawIdea: string, deliveryTarget: DeliveryTarget): {
  stack: CanonicalStack | "";
  confidence: "high" | "low";
} {
  const explicit = normalizeStackHint(metadata.stack_hint ?? "");
  if (explicit) {
    return { stack: explicit, confidence: "high" };
  }

  const detected = detectStackFromText(rawIdea);
  if (detected) {
    return { stack: detected, confidence: "high" };
  }

  return {
    stack: detectStackFromDeliveryTarget(deliveryTarget),
    confidence: "low",
  };
}

function detectEnvironmentSignals(rawIdea: string): string[] {
  const lowered = rawIdea.toLowerCase();
  const technologies: string[] = [];

  if (/\bnix\b/.test(lowered)) {
    technologies.push("Nix for reproducible, isolated development environments");
  }
  if (/\bflakes?\b/.test(lowered)) {
    technologies.push("Nix Flakes for pinned environment definitions and lockfiles");
  }
  if (/\bdevcontainer\b/.test(lowered)) {
    technologies.push("Dev Containers for editor-integrated reproducible environments");
  }
  if (/\bdirenv\b/.test(lowered)) {
    technologies.push("direnv for automatic environment activation per project");
  }
  if (/\bgithub actions?\b/.test(lowered)) {
    technologies.push("GitHub Actions for CI verification of environment reproducibility");
  }

  return technologies;
}

export function buildResearch(
  rawIdea: string,
  classification: Classification | undefined,
  metadata: PipelineMetadata,
): {
  research: Research;
  stackHint: CanonicalStack | null;
  stackConfidence: "high" | "low" | null;
} {
  const deliveryTarget = classification?.delivery_target ?? metadata.delivery_target ?? "unknown";
  const { stack, confidence } = inferStack(metadata, rawIdea, deliveryTarget);

  const technologies = uniqueStrings([
    ...detectEnvironmentSignals(rawIdea),
    stack === "go" ? "Go for single-binary cross-platform CLI distribution" : "",
    stack === "node-cli" ? "Node CLI stack for TypeScript/JavaScript command-line tooling" : "",
    stack === "python-cli" ? "Python CLI stack for rapid scripting and automation" : "",
    stack === "nextjs" ? "Next.js for web-first product delivery" : "",
    stack === "express" ? "Express for lightweight HTTP/API services" : "",
    stack === "fastapi" ? "FastAPI for typed Python APIs" : "",
  ]);

  const bestPractices = uniqueStrings([
    deliveryTarget === "cli" ? "Keep commands idempotent and document exit codes for automation" : "",
    deliveryTarget === "cli" ? "Prefer explicit config and lockfiles over implicit host state" : "",
    /\bnix\b/i.test(rawIdea) ? "Validate reproducibility in CI with the same environment definition used locally" : "",
    /\bflakes?\b/i.test(rawIdea) ? "Keep flake inputs pinned and review lockfile changes explicitly" : "",
    stack === "go" ? "Model subcommands and configuration as explicit packages to keep the CLI testable" : "",
    stack === "node-cli" ? "Use a typed command parser and keep CLI handlers isolated from side effects" : "",
  ]);

  const architecturePatterns = uniqueStrings([
    deliveryTarget === "cli" ? "Command dispatcher with isolated subcommand handlers" : "",
    deliveryTarget === "cli" ? "Config/lock/runtime separation to keep environment resolution deterministic" : "",
    /\bnix\b/i.test(rawIdea) ? "Declarative environment definition plus generated helper artifacts" : "",
  ]);

  const references = uniqueReferences([
    ...(stack ? STACK_REFERENCE_MAP[stack] ?? [] : []),
    ...(deliveryTarget !== "unknown" ? DELIVERY_REFERENCE_MAP[deliveryTarget] ?? [] : []),
    ...maybeReference(/\bflakes?\b/i.test(rawIdea), {
      title: "Nix Flakes",
      url: "https://nix.dev/concepts/flakes",
    }),
    ...maybeReference(/\bcontainers?\b|\bdevcontainer\b/i.test(rawIdea), {
      title: "Development Containers Specification",
      url: "https://containers.dev/",
    }),
  ]);

  const summaryParts = [
    deliveryTarget !== "unknown" ? `delivery target ${deliveryTarget}` : "",
    stack ? `suggested stack ${stack}` : "",
    technologies.length ? `${technologies.length} technology signals` : "",
  ].filter(Boolean);

  const research: Research = {
    status: technologies.length || bestPractices.length || architecturePatterns.length || references.length ? "ok" : "skipped",
    summary: summaryParts.length ? `Initial research synthesized from deterministic signals: ${summaryParts.join(", ")}.` : "No strong research signals detected yet.",
    technologies,
    best_practices: bestPractices,
    architecture_patterns: architecturePatterns,
    references,
  };

  return {
    research,
    stackHint: stack || null,
    stackConfidence: stack ? confidence : null,
  };
}
