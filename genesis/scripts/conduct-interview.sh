#!/usr/bin/env bash
set -euo pipefail

# Step 4a: Conduct interview via LLM (or deterministic fallback)
# Input: stdin JSON (interview questions + classification + idea)
# Output: JSON with spec_data to stdout
# Uses: llm_task.invoke via lobster (requires CLAWD_URL) or fallback

GENESIS_LOG="${GENESIS_LOG:-$HOME/.openclaw/workspace/logs/genesis.log}"
mkdir -p "$(dirname "$GENESIS_LOG")"
exec 2> >(tee -a "$GENESIS_LOG" >&2)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -n "${1:-}" && -f "${1:-}" ]]; then
  INPUT="$(cat "$1")"
else
  INPUT="$(cat)"
fi
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id')"
echo "=== $(date -Iseconds) | conduct-interview.sh | session=$SESSION_ID ===" >&2
IDEA="$(echo "$INPUT" | jq -r '.raw_idea // .idea // ""')"
TYPE="$(echo "$INPUT" | jq -r '.classification.type // "feature"')"
QUESTIONS="$(echo "$INPUT" | jq -c '.interview.questions // []')"

echo >&2 "[conduct-interview] session=$SESSION_ID type=$TYPE"

# Extract web research context (if available from research step)
RESEARCH="$(echo "$INPUT" | jq -c '.research // {}')"
RESEARCH_CONTEXT=""
if [[ "$(echo "$RESEARCH" | jq 'length')" -gt 0 ]]; then
  TECH="$(echo "$RESEARCH" | jq -r '.technologies // [] | join(", ")')"
  PRACTICES="$(echo "$RESEARCH" | jq -r '.best_practices // [] | join("; ")')"
  PATTERNS="$(echo "$RESEARCH" | jq -r '.architecture_patterns // [] | join(", ")')"
  if [[ -n "$TECH" || -n "$PRACTICES" || -n "$PATTERNS" ]]; then
    RESEARCH_CONTEXT="

Web research findings:
- Technologies: $TECH
- Best practices: $PRACTICES
- Architecture patterns: $PATTERNS

Use these findings to inform your specification — recommend specific technologies and patterns where relevant."
    echo >&2 "[conduct-interview] Injecting web research context into prompt"
  fi
fi

INTERVIEW_CONTEXT=""
QUESTION_LINES="$(echo "$QUESTIONS" | jq -r '
  . as $items
  | if ($items | length) == 0 then empty
    else to_entries[]
      | "- Q\(.key + 1): \(.value.question // "")"
    end
')"
if [[ -n "$QUESTION_LINES" ]]; then
  INTERVIEW_CONTEXT="

Interview questions selected for this request:
$QUESTION_LINES

Use them as the primary structure for the spec. Do not invent extra technical requirements unless clearly implied by the project idea."
fi

# Build a structured prompt for the LLM
PROMPT="You are generating a structured software project specification.

Project idea: $IDEA
Classification: $TYPE
${RESEARCH_CONTEXT}${INTERVIEW_CONTEXT}

Based on this idea, produce a complete spec with these fields:
- title: concise project title
- objective: 1-2 sentence objective
- scope_v1: array of V1 scope items
- out_of_scope: array of items explicitly excluded from V1
- acceptance_criteria: array of testable acceptance criteria.
  IMPORTANT: Each criterion MUST be specific to the project domain and directly verifiable.
  BAD examples (too generic): "Feature works as described", "Tests pass", "MVP is functional"
  GOOD examples (domain-specific): "Counts words correctly including Unicode text", "Identifies the most frequent word", "Accepts both file path and stdin as input"
  Derive each criterion from concrete behaviors described in the project idea. Each must describe a specific, observable behavior — not a generic quality gate.
- definition_of_done: array of DoD items
- constraints: string describing technical constraints
- risks: array of risk items

When requirements are missing, infer conservative defaults and include them as assumptions inside constraints/risks.
Return valid JSON only."

SCHEMA='{"type":"object","properties":{"title":{"type":"string"},"objective":{"type":"string"},"scope_v1":{"type":"array","items":{"type":"string"}},"out_of_scope":{"type":"array","items":{"type":"string"}},"acceptance_criteria":{"type":"array","items":{"type":"string"}},"definition_of_done":{"type":"array","items":{"type":"string"}},"constraints":{"type":"string"},"risks":{"type":"array","items":{"type":"string"}}},"required":["title","objective","scope_v1","acceptance_criteria","definition_of_done"]}'

# Try LLM via openclaw agent --local (workaround for broken llm_task.invoke)
LLM_RESULT=""
if command -v openclaw &>/dev/null; then
  echo >&2 "[conduct-interview] Trying LLM via openclaw agent --local..."
  LLM_RAW="$(timeout 120 openclaw agent --local \
    -m "$(printf '%s\n\nIMPORTANT: Return ONLY valid JSON matching this schema, no markdown fences, no explanation:\n%s' "$PROMPT" "$SCHEMA")" \
    --session-id "genesis-interview-${SESSION_ID}" \
    --json 2>/dev/null || true)"
  # Extract the text payload from openclaw agent response
  if [[ -n "$LLM_RAW" ]]; then
    LLM_TEXT="$(echo "$LLM_RAW" | jq -r '.payloads[0].text // empty' 2>/dev/null || true)"
    # Strip markdown fences if present
    LLM_TEXT="$(echo "$LLM_TEXT" | sed '/^```/d; /^json$/d')"
    if [[ -n "$LLM_TEXT" ]]; then
      LLM_RESULT="$LLM_TEXT"
    fi
  fi
fi

# Check if LLM returned valid JSON with required fields
if echo "$LLM_RESULT" | jq -e '.title and .scope_v1 and (.acceptance_criteria | length > 0)' &>/dev/null 2>&1; then
  SPEC_DATA="$(echo "$LLM_RESULT" | jq '.')"
  echo >&2 "[conduct-interview] LLM spec generated successfully"
else
  echo >&2 "[conduct-interview] LLM unavailable or failed, using type-aware deterministic fallback"

  # Type-aware deterministic fallback
  TITLE="$(echo "$IDEA" | cut -c1-80)"

  case "$TYPE" in
    feature)
      SCOPE='["Implementação base da funcionalidade conforme descrito","Integração com fluxo existente do projeto","Interface/API funcional para o caso de uso principal"]'
      OOS='["Integrações com terceiros não mencionados na ideia","Otimizações avançadas de performance","Internacionalização e suporte multi-idioma"]'
      ACS='["Feature implementa o comportamento descrito na ideia","Funcionalidades principais são acessíveis e funcionam end-to-end","Usuário consegue atingir o objetivo descrito","Sem erros críticos — testes básicos passam"]'
      DOD='["Código revisado e aprovado","Testes passando (unitários e integração)","Documentação mínima presente (README ou inline)","PR merged no branch principal"]'
      CONSTRAINTS_TEXT="Tipo: feature. Classificação automática — validar escopo com stakeholder se necessário."
      RISKS='["Escopo pode precisar refinamento após análise detalhada do código existente","Requisitos implícitos podem surgir durante implementação","Dependências externas podem afetar timeline"]'
      ;;
    bugfix)
      SCOPE='["Identificar a causa raiz do problema descrito","Implementar correção no componente afetado","Verificar que o comportamento esperado é restaurado"]'
      OOS='["Refatoração de código adjacente não relacionado ao bug","Otimizações de performance além da correção","Novos testes de regressão para módulos não afetados"]'
      ACS='["Bug não reproduz mais nos cenários descritos","Comportamento correto é restaurado conforme esperado","Testes de regressão existentes continuam passando","Sem efeitos colaterais em funcionalidades adjacentes"]'
      DOD='["Código revisado e aprovado","Fix verificado manualmente e por testes automatizados","Teste de regressão adicionado para o cenário do bug","PR merged no branch principal"]'
      CONSTRAINTS_TEXT="Tipo: bugfix. Priorizar correção mínima — evitar mudanças não relacionadas."
      RISKS='["Causa raiz pode ser diferente do sintoma descrito","Correção pode revelar outros bugs latentes","Ambiente de reprodução pode diferir do ambiente reportado"]'
      ;;
    refactor)
      SCOPE='["Refatorar o módulo/componente especificado na ideia","Melhorar a métrica indicada (legibilidade, performance, manutenibilidade)","Manter compatibilidade com código consumidor"]'
      OOS='["Mudança de comportamento ou API pública","Otimizações além do escopo da refatoração","Migração de dependências ou frameworks"]'
      ACS='["Código refatorado segue padrões e convenções do projeto","Todos os testes existentes continuam passando sem alteração","Complexidade ou duplicação reduzida conforme objetivo","Sem mudança de comportamento observável"]'
      DOD='["Código revisado e aprovado","Testes passando — nenhuma regressão","Métricas de qualidade melhoradas (se mensuráveis)","PR merged no branch principal"]'
      CONSTRAINTS_TEXT="Tipo: refactor. Zero mudança de comportamento — só melhoria estrutural."
      RISKS='["Refatoração pode revelar code smells mais profundos","Testes insuficientes podem mascarar regressões","Scope creep — tentação de melhorar além do necessário"]'
      ;;
    research)
      SCOPE='["Investigar a tecnologia ou abordagem proposta","Documentar achados, comparações e trade-offs","Apresentar recomendação clara e acionável"]'
      OOS='["Implementação completa da solução recomendada","Testes extensivos em produção","Decisões que requerem input de stakeholders não disponíveis"]'
      ACS='["Pesquisa possui escopo claro e delimitado","Pelo menos 3 alternativas investigadas com pros/cons","Achados documentados de forma estruturada","Recomendação final é acionável — próximos passos claros"]'
      DOD='["Findings postados como comentário na issue","Task de implementação criada para a abordagem recomendada","Referências e fontes documentadas","Issue de pesquisa fechada"]'
      CONSTRAINTS_TEXT="Tipo: research. Foco em análise — implementação é responsabilidade da task resultante."
      RISKS='["Escopo de pesquisa pode expandir além do previsto","Informações podem estar desatualizadas","Recomendação pode precisar de validação com equipe"]'
      ;;
    infra)
      SCOPE='["Configurar/implantar a infraestrutura descrita","Validar funcionamento no ambiente alvo","Documentar procedimentos de manutenção"]'
      OOS='["Suporte e monitoramento 24/7","Otimizações futuras de custo","Migração de dados legados"]'
      ACS='["Ambiente está configurado e operacional conforme descrito","Serviços e ferramentas funcionam corretamente","Documentação de setup e manutenção presente","Rollback possível em caso de problemas"]'
      DOD='["Infra provisionada e validada","Documentação de operação presente","Acesso configurado para equipe relevante","PR merged (se IaC) ou procedimento documentado"]'
      CONSTRAINTS_TEXT="Tipo: infra. Garantir reversibilidade — sempre ter plano de rollback."
      RISKS='["Configuração pode diferir entre ambientes (dev/staging/prod)","Credenciais e acessos podem não estar disponíveis","Custo pode ser diferente do estimado"]'
      ;;
    *)
      SCOPE='["Implementação conforme descrito na ideia"]'
      OOS='["Funcionalidades e integrações não mencionadas"]'
      ACS='["Sistema funciona conforme descrito na ideia","Testes passam"]'
      DOD='["Código revisado e aprovado","Testes passando","PR merged"]'
      CONSTRAINTS_TEXT="Tipo: $TYPE."
      RISKS='["Escopo pode precisar refinamento"]'
      ;;
  esac

  SPEC_DATA="$(jq -n \
    --arg title "$TITLE" \
    --arg objective "$IDEA" \
    --argjson scope "$SCOPE" \
    --argjson oos "$OOS" \
    --argjson acs "$ACS" \
    --argjson dod "$DOD" \
    --arg constraints "$CONSTRAINTS_TEXT" \
    --argjson risks "$RISKS" \
    '{
      title: $title,
      objective: $objective,
      scope_v1: $scope,
      out_of_scope: $oos,
      acceptance_criteria: $acs,
      definition_of_done: $dod,
      constraints: $constraints,
      risks: $risks
    }')"
fi

# Output merged session state with spec_data
echo "$INPUT" | jq \
  --argjson spec_data "$SPEC_DATA" \
  '. + {
    step: "interview_complete",
    spec_data: $spec_data,
    interview: ((.interview // {}) + {spec_data: $spec_data})
  }'
