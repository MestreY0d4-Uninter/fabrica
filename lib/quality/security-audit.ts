/**
 * Security audit — spec-level security review.
 *
 * Port of genesis/scripts/security-review.sh.
 * Pattern-matches spec text for security concerns,
 * cross-validates auth gate, and produces recommendation.
 */
import type { SecurityReview, Spec, AuthGate } from "../intake/types.js";

// ---------------------------------------------------------------------------
// Security patterns
// ---------------------------------------------------------------------------

type SecurityPattern = {
  pattern: RegExp;
  note: string;
};

const SECURITY_PATTERNS: SecurityPattern[] = [
  { pattern: /\b(login|autentic|autenticação|authentication|sign.?in)\b/i, note: "Authentication detected — enforce bcrypt/argon2, session management, rate limiting on login." },
  { pattern: /\b(senha|password|credential)\b/i, note: "Password handling detected — use bcrypt/argon2, never store plaintext, enforce minimum complexity." },
  { pattern: /\b(api|endpoint|rota|route)\b/i, note: "API detected — validate all inputs, implement rate limiting, use parameterized queries." },
  { pattern: /\b(database|banco de dados|sql|query|consulta)\b/i, note: "Database access detected — use parameterized queries, prevent SQL injection, restrict DB permissions." },
  { pattern: /\b(upload|envio de arquivo|file.?upload)\b/i, note: "File upload detected — validate file types and sizes, scan for malware, store outside webroot." },
  { pattern: /\b(payment|pagamento|cart[aã]o|credit.?card|stripe|pci)\b/i, note: "Payment processing detected — PCI DSS compliance required, never store card numbers, use tokenization." },
  { pattern: /\b(email|e-mail|smtp|sendgrid|mailgun)\b/i, note: "Email functionality detected — sanitize inputs to prevent header injection, validate addresses." },
  { pattern: /\b(jwt|token|bearer|oauth)\b/i, note: "Token-based auth detected — validate signatures, check expiration, use short-lived tokens." },
  { pattern: /\b(admin|administra[çc][aã]o|backoffice|painel)\b/i, note: "Admin functionality detected — enforce RBAC, implement audit logging, require MFA." },
  { pattern: /\b(webhook|callback|hook)\b/i, note: "Webhook detected — validate signatures, implement replay protection, use HTTPS only." },
  { pattern: /\b(secret|encrypt|criptograf|cifr|chave|key.?management)\b/i, note: "Secrets/encryption detected — use env vars or vault, never hardcode, rotate keys regularly." },
  { pattern: /\b(cors|cross.?origin|csrf|xss)\b/i, note: "Cross-origin/XSS concern — configure CORS strictly, implement CSRF protection, sanitize outputs." },
  { pattern: /\b(session|sess[aã]o|cookie)\b/i, note: "Session management detected — set secure/httpOnly/sameSite flags, implement timeout, prevent fixation." },
];

// ---------------------------------------------------------------------------
// Spec security review
// ---------------------------------------------------------------------------

/**
 * Run a security review on the spec content.
 * Returns findings, security notes, and a recommendation.
 */
export function reviewSpecSecurity(opts: {
  spec: Spec;
  rawIdea: string;
  authGate?: AuthGate;
}): SecurityReview {
  const { spec, rawIdea, authGate } = opts;

  // Combine all spec text for pattern matching
  const specText = [
    spec.title,
    spec.objective,
    ...spec.scope_v1,
    ...spec.acceptance_criteria,
    ...spec.definition_of_done,
    spec.constraints,
    ...spec.risks,
    rawIdea,
  ].join(" ");

  // Detect security patterns
  const notes: string[] = [];
  for (const { pattern, note } of SECURITY_PATTERNS) {
    if (pattern.test(specText)) {
      notes.push(note);
    }
  }

  // Auth gate cross-validation
  if (authGate?.signal && !authGate?.evidence) {
    notes.push("Potential contract drift: auth signal detected without explicit acceptance evidence. Review spec for missing auth requirements.");
  }

  // Recommendation
  const recommendation = calculateRecommendation(notes, authGate);

  return {
    audit_ran: true,
    findings: [],
    spec_security_notes: notes,
    recommendation,
  };
}

/**
 * Run supplemental native parsing over external audit text, when available.
 *
 * Fabrica no longer shells out to SecureClaw. This helper is intentionally
 * non-invasive and only augments an existing review when the caller already has
 * machine-readable or textual findings from another source.
 */
export async function runExternalAudit(
  review: SecurityReview,
  runCommand: (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
): Promise<SecurityReview> {
  try {
    const result = await runCommand("true", [], { timeout: 1000 });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (result.exitCode !== 0 || !output) {
      return review;
    }

    const findings = output
      .split("\n")
      .filter(line => /[🔴🟠🟡]/.test(line))
      .map(line => line.trim());

    const scoreMatch = output.match(/Security Score:\s*(\d+)/);
    const score = scoreMatch ? parseInt(scoreMatch[1], 10) : undefined;

    if (findings.length === 0 && score == null) {
      return review;
    }

    return {
      ...review,
      audit_ran: true,
      score,
      findings,
    };
  } catch {
    // Supplemental audit unavailable — continue without
    return review;
  }
}

function calculateRecommendation(notes: string[], authGate?: AuthGate): string {
  if (authGate?.signal && !authGate?.evidence) return "HIGH security sensitivity";
  if (notes.length > 3) return "HIGH security sensitivity";
  if (notes.length >= 1) return "MODERATE security sensitivity";
  return "LOW security sensitivity";
}
