/**
 * Step 4: Generate structured specification from spec_data.
 * Validates, enriches with delivery-target-specific ACs and auth gates.
 * Important: inferred "hybrid" targets must not automatically force both UI and API
 * acceptance criteria. That contamination was causing CLI ideas with optional roadmap
 * mentions to scaffold as web/API products.
 */
import type { PipelineStep, GenesisPayload, Spec, DeliveryTarget } from "../types.js";
import { crossValidateDeliveryTarget, detectDeliveryTargetFromText, normalizeDeliveryTarget } from "../lib/delivery-target.js";

const AUTH_REGEX = /\b(login|autentic|senha|perfil|permiss|acesso|rbac|admin)\b/i;

export const generateSpecStep: PipelineStep = {
  name: "generate-spec",

  shouldRun: (payload) => !!payload.spec_data || !!payload.interview?.spec_data,

  async execute(payload, ctx): Promise<GenesisPayload> {
    const sd = payload.spec_data ?? payload.interview?.spec_data;
    if (!sd) throw new Error("No spec_data found in payload");

    const type = payload.classification?.type ?? "feature";

    ctx.log(`Generating spec for session ${payload.session_id} (type=${type})`);

    // Base fields
    const title = (sd.title || payload.raw_idea).slice(0, 120);
    const objective = sd.objective || "See raw idea";
    let scope_v1 = sd.scope_v1?.length ? sd.scope_v1 : [payload.raw_idea];
    let out_of_scope = sd.out_of_scope?.length ? sd.out_of_scope : ["To be defined during implementation"];
    let acs = sd.acceptance_criteria?.length ? [...sd.acceptance_criteria] : ["Feature works as described in the objective"];
    let dod = sd.definition_of_done?.length ? [...sd.definition_of_done] : ["Code reviewed and merged", "Tests pass", "QA contract passes"];
    const constraints = sd.constraints || "None specified";
    const risks = sd.risks ?? [];

    // Resolve delivery target
    const rawTarget = sd.delivery_target ?? payload.classification?.delivery_target ?? payload.metadata?.delivery_target;
    let deliveryTarget: DeliveryTarget;
    if (!rawTarget || rawTarget === "unknown") {
      deliveryTarget = detectDeliveryTargetFromText(payload.raw_idea);
    } else {
      const normalized = normalizeDeliveryTarget(rawTarget);
      deliveryTarget = crossValidateDeliveryTarget(normalized, payload.raw_idea);
    }

    // Auto-append delivery-target-specific ACs
    const acsJoined = acs.join(" ").toLowerCase();

    switch (deliveryTarget) {
      case "web-ui":
        if (!/\b(tela|p[aá]gina|ui|interface|dashboard|fluxo)\b/i.test(acsJoined)) {
          acs.push("Existe ao menos uma tela funcional do fluxo principal, navegavel de ponta a ponta.");
        }
        break;
      case "api":
        if (!/\b(api|endpoint|rota|route|http|rest)\b/i.test(acsJoined)) {
          acs.push("Existe ao menos um endpoint/API funcional do fluxo principal, com resposta valida.");
        }
        break;
      case "cli":
        if (!/\b(cli|terminal|comando|linha de comando|console)\b/i.test(acsJoined)) {
          acs.push("Existe ao menos um comando CLI funcional do fluxo principal.");
        }
        break;
      case "hybrid":
        // Hybrid is too ambiguous to auto-impose UI/API obligations. Those criteria must
        // come from the user's stated scope or a later clarification step.
        break;
    }

    // Auth gate: if signal but no evidence, auto-append
    const signalText = `${payload.raw_idea} ${objective}`.toLowerCase();
    const evidenceText = `${objective} ${scope_v1.join(" ")} ${acs.join(" ")}`.toLowerCase();
    const authSignal = AUTH_REGEX.test(signalText);
    let authEvidence = AUTH_REGEX.test(evidenceText);

    if (authSignal && !authEvidence) {
      acs.push("Usuarios autenticados conseguem iniciar sessao com credenciais validas.");
      acs.push("Acoes criticas exigem autorizacao por perfil (ex.: admin/operador/leitura).");
      dod.push("Existe teste cobrindo autorizacao por perfil em ao menos um fluxo critico.");
      authEvidence = true;
    }

    // Build constraints string with delivery target
    const fullConstraints = constraints !== "None specified"
      ? `${constraints} Delivery target: ${deliveryTarget}.`
      : `Delivery target: ${deliveryTarget}.`;

    const spec: Spec = {
      title, type, objective,
      scope_v1, out_of_scope, acceptance_criteria: acs, definition_of_done: dod,
      constraints: fullConstraints, risks, delivery_target: deliveryTarget,
    };

    ctx.log(`Spec: title='${title}', scope=${scope_v1.length} items, ACs=${acs.length}, DoD=${dod.length}`);

    return {
      ...payload,
      step: "spec",
      spec,
      metadata: {
        ...payload.metadata,
        auth_gate: { signal: authSignal, evidence: authEvidence },
      },
    };
  },
};
