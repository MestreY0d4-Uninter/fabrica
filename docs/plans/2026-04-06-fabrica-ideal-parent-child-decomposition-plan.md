# Fabrica — Plano Ideal para Decomposição Parent/Child, Múltiplas PRs e Paralelismo Seguro

> Para Hermes: usar este plano como guia de evolução arquitetural. Não implementar tudo de uma vez. Entregar por fases pequenas, sempre com testes.

Objetivo

Transformar a decomposição de trabalho large/xlarge em um mecanismo de primeira classe no Fabrica, permitindo múltiplas PRs e múltiplos developers em paralelo de forma segura, rastreável e previsível — sem colocar vários agents na mesma issue/branch.

Arquitetura-alvo

- Uma iniciativa grande vira uma issue pai (epic) + N child issues executáveis.
- Cada child issue tem dono único, branch única e PR única.
- O parent não é unidade de codificação; é unidade de coordenação.
- O scheduler despacha children independentes em paralelo e children dependentes em sequência.
- O parent fecha automaticamente quando os children relevantes terminarem.

Princípios

1. 1 child issue = 1 owner = 1 branch = 1 PR.
2. Paralelismo só entre children com fronteiras claras.
3. Stacked PRs quando houver dependência linear.
4. Parent issue é coordenação/visibilidade, não implementação direta.
5. `large/xlarge` não devem ir direto para execução sem plano de decomposição sólido.
6. Não permitir oficialmente múltiplos developers na mesma issue ativa.

Estado atual resumido

Já existe hoje:
- effort sizing: `small | medium | large | xlarge`
- mapeamento para nível: `junior | medior | senior`
- decomposição automática parcial no triage
- labels `decomposition:parent` / `decomposition:child`
- slots e paralelismo por role/level

Lacunas principais atuais:
- decomposição ainda é textual/simples demais
- parent/child automático não usa plenamente o runtime estrutural já existente
- não há dependências explícitas entre children
- não há regra oficial de PR stack / integração
- parent não fecha automaticamente com base nos filhos
- não existe `parallelizability score`

Escopo ideal

Fase A — Canonicalizar parent/child no runtime

Meta
- Fazer parent/child virar estrutura persistida e consultável em todo o pipeline.

Arquivos principais
- `lib/intake/steps/triage.ts`
- `lib/intake/types.ts`
- `lib/projects/types.ts`
- `lib/projects/mutations.ts`
- `lib/projects/index.ts`
- `lib/tools/tasks/task-create.ts`
- `lib/tools/admin/sync-labels.ts`
- `lib/workflow/labels.ts`
- testes em `tests/unit/triage-step.test.ts` e novos testes de runtime

Entregas
1. Persistir automaticamente vínculos parent/child quando o triage criar child issues.
2. Garantir no runtime:
   - `parentIssueId`
   - `childIssueIds`
   - `decompositionMode`
   - `decompositionStatus`
3. Tornar labels de decomposição oficiais e sincronizadas.
4. Adicionar helpers de leitura:
   - `getParentIssueRuntime(...)`
   - `getChildIssueRuntimes(...)`
   - `isParentIssue(...)`
   - `isChildIssue(...)`

Critério de pronto
- Um parent criado automaticamente tem referências canônicas para todos os filhos.
- Cada child aponta canonicamente para o parent.
- A UI/CLI/status consegue inspecionar isso sem depender só do corpo da issue.

Fase B — Substituir chunking por decomposition planning real

Meta
- Parar de quebrar por pedaços de `scope_v1` e passar a quebrar por entregáveis independentes.

Arquivos principais
- `lib/intake/steps/triage.ts`
- `lib/intake/lib/triage-logic.ts`
- possivelmente novo módulo: `lib/intake/lib/decomposition-planner.ts`
- testes novos em `tests/unit/triage-step.test.ts`

Estrutura ideal por child draft
- `title`
- `objective`
- `scope_items`
- `acceptance_criteria`
- `definition_of_done`
- `recommended_level`
- `estimated_effort`
- `parallelizable: boolean`
- `depends_on: string[]`
- `capability_area`

Heurísticas de corte
- capability / bounded context
- backend / CLI / docs / tests / infra / telemetry
- migrations separadas de feature logic
- contratos/interfaces primeiro; consumidores depois

Critério de pronto
- Cada child nasce com escopo próprio e verificável.
- Children deixam de herdar AC/DoD globais indiscriminadamente.
- Há ao menos um teste cobrindo children paralelizáveis e children dependentes.

Fase C — Introduzir no triage o conceito de parallelizability

Meta
- Separar tamanho de paralelizabilidade.

Arquivos principais
- `lib/intake/lib/triage-logic.ts`
- `lib/intake/types.ts`
- `lib/intake/configs/triage-matrix.json` (se fizer sentido expandir)
- testes em `tests/unit/triage-logic.test.ts`

Novo modelo sugerido
- `effort`: small/medium/large/xlarge
- `complexity`: low/medium/high
- `coupling`: low/medium/high
- `parallelizability`: low/medium/high

Sinais úteis
- múltiplos subsistemas distintos
- forte overlap de arquivos estimados
- auth + background jobs + DB + UI no mesmo pedido
- migrations / schema changes
- integrações externas

Regras sugeridas
- `large + high parallelizability` => decompor e paralelizar
- `large + low parallelizability` => decompor parcialmente ou serializar
- `xlarge` => exigir decomposition plan validado antes de dispatch

Critério de pronto
- O sistema não usa mais `large` como sinônimo automático de “paralelizar”.
- A decisão de split passa a levar em conta acoplamento real.

Fase D — Scheduler por issue family

Meta
- Despachar filhos respeitando dependências.

Arquivos principais
- `lib/services/tick.ts`
- `lib/services/queue-scan.ts`
- `lib/projects/slots.ts`
- `lib/projects/types.ts`
- possivelmente novo módulo: `lib/services/family-scheduler.ts`
- testes novos de integração/heartbeat

Comportamento ideal
- Parent epic não entra na fila normal de developer.
- Children entram na fila normal.
- Scheduler só pega child `ready`.
- Child com predecessor pendente não é despachado.
- Children independentes podem ocupar slots paralelos.

Regras sugeridas
- `family.maxParallelChildren`
- `child.dependsOn`
- `child.readyForDispatch`

Critério de pronto
- O sistema consegue rodar 2–4 child issues em paralelo quando apropriado.
- Dependências são respeitadas sem intervenção manual.

Fase E — Estratégia oficial de múltiplas PRs

Meta
- Tornar “uma PR por child” o fluxo nativo para trabalho grande.

Arquivos principais
- `defaults/fabrica/prompts/developer.md`
- `defaults/fabrica/prompts/reviewer.md`
- `defaults/fabrica/prompts/tester.md`
- `lib/dispatch/message-builder.ts`
- `lib/tools/worker/work-finish.ts`
- `lib/services/worker-completion.ts`
- possivelmente `lib/dispatch/*`

Regras ideais
1. Child issue abre PR própria.
2. Parent issue não abre PR final de implementação, salvo fase de integração explícita.
3. Se houver dependência linear:
   - suportar stacked PRs com branch base do child anterior
   - ou serialização explícita no scheduler
4. O comentário do parent lista:
   - child issue
   - branch
   - PR
   - status

Critério de pronto
- Parent mostra mapa vivo de execução.
- PRs grandes monolíticas deixam de ser o padrão para large/xlarge.

Fase F — Fechamento automático do parent

Meta
- Parent refletir o estado consolidado da família.

Arquivos principais
- `lib/services/worker-completion.ts`
- `lib/services/tick.ts`
- `lib/projects/mutations.ts`
- possivelmente novo módulo: `lib/services/parent-closure.ts`

Comportamento ideal
- todos os children obrigatórios `Done` => parent `Done`
- child bloqueado/refining => parent sinaliza bloqueio
- parent recebe resumo final consolidado

Critério de pronto
- O parent não precisa ser fechado manualmente.
- O parent vira o dashboard do épico.

Fase G — Uso mais inteligente de senioridade

Meta
- Colocar senioridade onde ela gera mais retorno.

Regra recomendada
- parent / decomposition planning: senior
- child complexa e acoplada: senior
- child padrão: medior
- child pequena/local: junior

Arquivos principais
- `lib/intake/lib/triage-logic.ts`
- `lib/intake/steps/triage.ts`
- prompts e docs

Critério de pronto
- Nem toda child de um epic large/xlarge precisa de senior.
- O throughput melhora sem reduzir qualidade.

Anti-objetivos

Não fazer:
- múltiplos developers na mesma issue ativa
- múltiplos developers na mesma branch
- múltiplos developers na mesma PR
- decomposição cega por quantidade de bullets
- parent e children competindo pela mesma fila de execução como se fossem equivalentes

Ordem ideal de implementação

1. Fase A — canonicalizar parent/child no runtime
2. Fase B — planner de decomposição real
3. Fase C — parallelizability/coupling no triage
4. Fase D — scheduler por issue family
5. Fase E — fluxo oficial de múltiplas PRs
6. Fase F — fechamento automático do parent
7. Fase G — refino fino de senioridade

Plano de rollout recomendado

Entrega 1
- Fase A
- testes de runtime parent/child

Entrega 2
- Fase B
- planner novo + testes

Entrega 3
- Fase C
- parallelizability score

Entrega 4
- Fase D
- family scheduler

Entrega 5
- Fase E + F
- PR strategy + fechamento automático

Entrega 6
- Fase G
- otimização de level assignment

Métricas de sucesso

Produto
- % de large/xlarge que viram child issues boas automaticamente
- tempo médio até primeira PR em tarefas grandes
- número médio de arquivos por PR em tasks grandes
- taxa de merge conflict em tasks grandes
- taxa de retrabalho/reopen em tasks grandes

Sistema
- número de children paralelas bem-sucedidas por epic
- número de epics fechados automaticamente sem intervenção manual
- número de families que precisaram fallback humano

Qualidade
- tempo de review por PR grande vs PR child
- throughput por semana em iniciativas grandes
- taxa de regressão pós-merge

Recomendação final

A direção ideal do Fabrica não é “mais de um developer na mesma task”, e sim “um parent epic coordenando múltiplas child issues independentes, cada uma com owner, branch e PR próprios, com paralelismo controlado por dependências e baixo overlap”.
