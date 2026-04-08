# Future Improvements

Este arquivo registra apenas melhorias futuras não bloqueantes após o fechamento da milestone `0.2.41`.

Status atual:
- A Fabrica está suficientemente madura para divulgação.
- Os itens abaixo são evolução/tuning, não pendências críticas.

## 1. Calibração fina de budgets e thresholds

Objetivo:
- ajustar budgets de retry e escalonamento com mais dados reais

Exemplos:
- quantos retries permitir por subcausa de QA
- quando escalar mais cedo para `Refining`
- quando considerar falta de progresso material

Motivo:
- a arquitetura já está pronta; agora o ganho vem de tuning operacional

## 2. Melhor preservação histórica de métricas por stack

Objetivo:
- evitar perda de contexto quando projetos são limpos do `projects.json`

Problema atual:
- parte das métricas históricas pode cair em `unknown` após limpeza total do runtime vivo

Melhoria futura:
- persistir stack/metadata histórica no audit ou em agregado dedicado

## 3. Materialidade mais forte quando não houver head SHA disponível

Objetivo:
- melhorar decisão de retry útil mesmo quando o provider/runtime não expõe head SHA confiável

Exemplos de sinais alternativos:
- mudança estruturada da QA Evidence
- mudança dos gates faltantes
- mudança do diff/PR body canônica

## 4. Mais calibração com cenários médios e pesados

Objetivo:
- ampliar confiança em stacks mais complexas

Cenários sugeridos:
- Node CLI rica com múltiplos subcommands
- APIs com auth + banco
- projetos com maior churn de review/fix

## 5. Redução adicional de churn de edição exata

Objetivo:
- diminuir casos em que o worker fica preso em `edit failed` repetidos

Contexto:
- isso apareceu mais em projetos médios/pesados do que nos fluxos simples

## 6. Evolução opcional do contrato de QA

Objetivo:
- deixar a QA Evidence ainda mais estruturada e fácil de validar

Possível caminho futuro:
- enriquecer o contrato de `scripts/qa.sh`
- produzir saída canônica mais fácil de comparar e persistir

Observação:
- só vale fazer se o formato atual continuar gerando atrito relevante

## 7. Uso mais profundo do `doctor_issue` como insumo automático

Objetivo:
- aproveitar ainda mais o doctor na tomada de decisão automática

Exemplos futuros:
- acionar snapshots adicionais em gatilhos específicos
- derivar score de severidade de thrash
- enriquecer comentários/auditoria operacional

## 8. Dashboard/telemetria mais sofisticados

Objetivo:
- melhorar visualização agregada para operação contínua

Observação:
- não é prioridade agora
- o nível atual de observabilidade já é suficiente para operar e divulgar

## Itens explicitamente não prioritários agora

Estes itens foram considerados, mas não são recomendados neste momento:
- adicionar novo label/estado de workflow só para QA (`Fix QA`, `Repair Evidence`)
- redesign amplo do workflow
- telemetria pesada sem necessidade operacional real

## Conclusão

Os itens acima são follow-ups de qualidade e calibração.

Nenhum deles impede o uso/divulgação atual da Fabrica em `0.2.41`.
