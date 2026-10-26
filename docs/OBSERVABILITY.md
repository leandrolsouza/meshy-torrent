# Observabilidade local

## Correlação de operações e spans locais

Cada comando de `window.meshy` gera um `traceId` de 32 caracteres hexadecimais e
um `spanId` de 16 no preload, usando Web Crypto. Esses metadados seguem no terceiro
argumento do IPC, separados do payload de negócio. O main valida formato, tamanho
e IDs não nulos; valores inválidos são substituídos por uma nova origem. Os IDs
não concedem autorização e não substituem a validação do remetente ou do payload.

O main cria um span filho por chamada IPC. `AsyncLocalStorage` mantém seu contexto
em chamadas síncronas, promises e timers dos serviços, isolando operações
concorrentes. Quando há contexto ativo, todos os níveis do logger incluem `traceId`, `spanId`,
`parentSpanId` quando houver, `operation` e `cid` (alias de `traceId`). Não são
adicionados payloads, magnets, caminhos ou dados de peers ao contexto.

Spans geram registros `span.end` com duração em milissegundos e resultado mesmo
com debug desativado, incluindo falhas e rate limit. O início (`span.start`) é
registrado em debug. São spans locais persistidos pelo logger; não há exportador
OpenTelemetry ou coletor remoto. Para reconstruir uma operação, procure seu
`traceId` nos logs e associe `parentSpanId` ao `spanId` da etapa anterior.

## Eventos tardios e fila

A engine guarda o contexto por instância de torrent em um `WeakMap`. Seus eventos
recuperam essa origem explicitamente, pois um EventEmitter pode ser acionado por
um recurso de rede criado fora da operação. Pause, resume, remove, detach,
seleção de arquivos e alterações de trackers
atualizam a origem da instância; consultas de polling não a substituem. Eventos de
metadados, conclusão e erro geram spans filhos. Um erro global da engine gera uma
etapa para cada torrent afetado.

Downloads enfileirados guardam o contexto de sua inclusão na fila. Quando um slot
é liberado, a etapa `download.queue.start` continua a operação daquele download,
inclusive seus callbacks e timers, sem herdar a origem do torrent que liberou o
slot. O contexto não é persistido na sessão: downloads restaurados iniciam novas
operações. Instâncias encerradas não retêm contexto em uma tabela global.

## Renderer e compatibilidade

As respostas IPC de chamadas com metadados contêm `traceContext`; chamadores
legados sem metadados mantêm a forma anterior da resposta. O evento
`torrent:error` também inclui o contexto quando sua origem é conhecida. O preload
entrega esse campo ao consumidor sem expor o evento Electron, e o hook de downloads
o inclui no registro do erro no console.

Ao reportar um erro relacionado a uma resposta/evento conhecido, passe seu
`traceContext` para `window.meshy.reportError`. O preload cria outro span na mesma
operação. Não existe um "último ID" global, pois isso associaria incorretamente
falhas de operações concorrentes. Erros globais do renderer sem uma origem explícita
iniciam uma nova operação.
Snapshots periódicos agregados de progresso não recebem um único `traceId`, pois
podem conter downloads de várias operações.

```ts
const response = await window.meshy.pause(infoHash);
if (!response.success) {
    window.meshy.reportError({
        message: response.error,
        source: 'pause',
        ...(response.traceContext ? { traceContext: response.traceContext } : {}),
    });
}
```

## Eventos de erro estruturados

O logger de escopo entrega uma mensagem e um objeto de contexto ao destino do
log. Campos aninhados permanecem objetos; a formatação textual padrão do
electron-log apresenta esses campos no arquivo. Novos registros estruturados
incluem `schemaVersion: 1` e `event` (`application.log` quando não especificado).
O contexto ativo acrescenta os IDs de correlação ao mesmo objeto e tem precedência
sobre IDs informados em campos livres. Chamadas legadas com argumentos variádicos
continuam aceitas.

Os eventos de diagnóstico seguem estes nomes:

| Evento                 | Origem e campos                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `ipc.operation.failed` | Falha tratada por `failWithLog`: `channel`, `errorCode` e `error`.                            |
| `renderer.error`       | Report do renderer: `channel`, `source` e `error`, incluindo `componentStack` quando enviada. |
| `trace.exception`      | Exceção síncrona ou rejeição durante um span: `error` e contexto ativo.                       |

`errorCode` é o código público devolvido ao renderer. `error` preserva o diagnóstico
interno sanitizado: `type` (derivado de `Error.name`), `message`, `stack`, `code`,
`errno`, `syscall`, `cause` e `errors` de `AggregateError`, quando disponíveis.
Por exemplo, dois erros com a mesma mensagem podem conservar `error.code` distintos
como `EACCES` e `ENOENT`. A resposta IPC mantém somente o código público e o
contexto de correlação já previsto no contrato.

A serialização usa uma lista de campos de diagnóstico, sem repassar a instância
original de Error ou propriedades extras como payloads e credenciais. Causas e
falhas agregadas são tratadas recursivamente, com limite de profundidade e marcador
para ciclos. Getters personalizados são omitidos; o accessor nativo de stack do
V8 pode ser lido quando `name` e `message` são strings sem accessors. Valores
lançados que não são Error recebem `type: NonError`, preservando os campos
reconhecidos sem executar `toString` do objeto. Stacks inexistentes não são criadas.

URLs, caminhos, e-mails, IPs e campos sensíveis continuam passando pela redação,
inclusive dentro de causas e erros agregados. A política e seus limites estão em
[LOCAL_DATA_SECURITY.md](LOCAL_DATA_SECURITY.md). Logs históricos permanecem no
formato em que foram gravados.

## Métricas de desfecho IPC

O wrapper `main/ipcMetrics.ts` envolve toda chamada nos canais registrados, antes
da autorização e do rate limit. Um único `finally` registra contagem e latência
com relógio monotônico (`performance.now()`), inclusive quando o callback lança
sincronamente ou sua promise rejeita. Falhas tratadas por `failWithLog` também
marcam a chamada como exceção. A classificação fica em contexto assíncrono por
chamada, isolado de operações concorrentes e aninhadas.

O snapshot de `app:get-metrics` e os novos registros de `metrics.ndjson` incluem
`ipcOutcomes` (totais por classe) e `outcomesByChannel` (classes por canal):

| Classe         | Significado                                                               |
| -------------- | ------------------------------------------------------------------------- |
| `success`      | O handler retornou `success: true`.                                       |
| `error`        | O handler retornou `success: false`, como em validação ou falha esperada. |
| `exception`    | Exceção síncrona, rejeição ou erro tratado por `failWithLog`.             |
| `rate_limited` | O limite do canal bloqueou a execução do handler.                         |
| `unauthorized` | O remetente/frame não foi autorizado; não consome a cota do canal.        |

Cada chamada encerrada ocupa exatamente uma classe. A soma de `ipcOutcomes` é
`ipcCallCount`; a soma das classes diferentes de `success` é `ipcErrorCount`.
`callsByChannel`, `errorsByChannel` e `avgLatencyByChannel` também incluem os
bloqueios. Para analisar erros de serviço, separe `exception`/`error` dos
bloqueios de autorização e sobrecarga.

As classes e canais são fixos; mensagens, payloads e IDs não viram dimensões de
métricas. Os mapas retornados são cópias e não permitem alterar os contadores
internos. Registros históricos no NDJSON podem não conter os novos mapas e não
são reclassificados. A própria consulta `app:get-metrics` termina depois de obter
seu snapshot, portanto aparece somente na consulta seguinte. Chamadas ainda em
execução não entram nos contadores de desfecho.

## Golden Signals e indicadores de produto

O mesmo snapshot de `app:get-metrics` e `metrics.ndjson` inclui os sinais abaixo.
Os campos anteriores continuam disponíveis.

| Sinal       | Campos                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------- |
| Latência    | `latency.ipcByChannel`, `queueWaitMs`, `metadataResolutionMs` e `metadataPreparationMs`.     |
| Tráfego     | `traffic` com bytes recebidos/enviados, taxas em `series`, contadores em `downloads`.        |
| Erros       | Desfechos IPC e `errorCauses` separados por IPC, engine, renderer e downloads.               |
| Saturação   | Memória do main e `operational.queue`, `eventLoop` e `disk`.                                 |
| Diagnóstico | Contagens por estado em `operational.states` e por diagnóstico em `operational.diagnostics`. |

Os histogramas são acumulados desde o início do processo, usam memória constante
e retornam contagem, soma, mínimo, máximo, buckets cumulativos e p50/p95/p99.
Os percentis são aproximações pelo limite superior da faixa, limitado ao máximo
observado. As faixas em ms são: 1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500,
5000, 10000, 30000, 60000, 300000, 900000 e 3600000, mais overflow. Sem observações,
extremos e percentis são `null`; nenhuma duração individual é retida.

A espera na fila termina quando o download ocupa um slot; remoções e pausas antes
disso não são tratadas como início. `metadataResolutionMs` mede episódios no estado
`resolving-metadata`. O fluxo de preparação da interface, anterior à criação do
download, é medido separadamente em `metadataPreparationMs`, por `magnet`, `file`
ou `buffer`, incluindo seu cleanup. Ambos distinguem `resolved`, `failed` e
`cancelled`. Tempos usam relógio monotônico.

Bytes vêm dos eventos reais `download` e `upload` dos torrents da engine. Progresso
em disco, velocidade estimada e metadados da prévia não são convertidos em tráfego.
`downloads` registra inclusões, inícios, conclusões e transições para falha. Início
e conclusão contam uma vez por download observado, mesmo com progress/done/seed
repetidos ou pause/resume. Remover e adicionar novamente cria outro ciclo. A sessão
restaurada é baseline: não reproduz eventos históricos. Uma transferência restaurada
ativa pode concluir nesta execução sem um novo início; arquivos já completos não
fabricam conclusões. A espera de itens restaurados começa na observação atual.

`series` guarda até 180 pontos, normalmente a cada 10 segundos (cerca de 30 minutos);
`operational` é o último ponto. Taxas usam deltas de bytes e chamadas encerradas
divididos pelo tempo monotônico decorrido. A primeira taxa é `null`. Cada ponto
inclui contadores de inícios/conclusões, ocupação, estados e diagnósticos como
`stalled`, `no-peers` e `trackers-error`. O snapshot completo é persistido a cada
cinco minutos e no encerramento normal. O NDJSON mantém a rotação existente de
1 MiB com um arquivo `.old`; uma linha pode ultrapassar o limite antes da próxima
rotação. Contadores reiniciam com o processo; registros antigos não são recalculados.

Slots incluem adições pendentes, além de downloads ativos; seeders têm gauge próprio.
`slotUtilization` é uma fração e pode superar 1 após reduzir o limite, enquanto os
downloads anteriores ainda estão ativos. Event loop usa `eventLoopUtilization` e
`monitorEventLoopDelay` do Node com resolução de 20 ms, convertido para ms; seus
percentis cobrem o intervalo desde a amostra anterior. Sem observações, são `null`.

Disco é sondado assincronamente a cada 30 segundos, no destino configurado e nas
pastas dos downloads, com até quatro consultas simultâneas e sem sobreposição de
varreduras. Retorna mínimos de bytes livres/razão livre e contagens de destinos
consultados, indisponíveis e abaixo da margem existente de 64 MiB. Não soma capacidade
de pastas no mesmo volume nem exporta seus caminhos. Capacidade desconhecida é
`null`, acompanhada por indisponibilidade; `sampledAt` permite verificar a idade da
sondagem. A coleta não muda as regras de admissão ou proteção contra falta de disco.

As causas usam categorias fixas: validação, duplicidade, ausência, timeout,
cancelamento, espaço em disco, filesystem, permissão, rede, política de rede,
engine indisponível, memória, rate limit, autorização e `unknown`. Códigos conhecidos
também são procurados em causas e erros agregados sanitizados; texto livre não é
inferido como causa. Falhas sem código reconhecido permanecem `unknown` e podem
ser investigadas nos logs correlacionados. As fontes são independentes: o mesmo
incidente pode gerar um erro de engine e uma falha IPC. Erros da engine são coletados
uma vez por evento, independentemente de quantas janelas estejam abertas.

Somente contagens e classes fixas são exportadas: sem hashes, nomes, caminhos,
peers ou mensagens como dimensões. `collectionErrorCount` separa falhas do coletor;
falhas individuais de disco aparecem em `unavailableDestinations`. Sondagens que
falham não substituem amostras anteriores por valores de saúde inventados.

## Verificação

```sh
npm test -- --runInBand
npm run typecheck
npm run lint
npm run build
node scripts/release-smoke.mjs --renderer-only
```

`tests/integration/operationTracing.test.ts` verifica isolamento concorrente,
continuidade em serviços, falhas, metadados inválidos, eventos tardios até a janela
e fila. Esses testes usam mocks de Electron/WebTorrent.
`tests/unit/preload.test.ts` verifica o transporte e a continuidade explícita de
reports. O auxiliar de renderer verifica a geração e o retorno dos IDs no preload
de produção em sandbox e perfil isolado, com IPC real.
`tests/unit/ipcMetrics.test.ts` e `tests/integration/ipcMetrics.test.ts` verificam
classificação de desfechos, contagem única, isolamento concorrente, relógio
monotônico e exposição dos novos mapas pelo IPC.
`tests/integration/ipcErrorLogging.test.ts` verifica o diagnóstico no destino
electron-log, os caminhos com e sem logger de escopo, a redação e a resposta IPC
sem stack, causa ou códigos internos. A suíte de redação também cobre erros
agregados, ciclos, accessors e a preservação do contexto como objeto.
`tests/unit/metricHistogram.test.ts`, `metricsGoldenSignals.test.ts`,
`operationalMetrics.test.ts` e `tests/integration/goldenSignals.test.ts` verificam
histogramas, taxas, reservas de slots, fila, metadados, restauração, contagem única,
privacidade e cleanup. A integração usa mocks de WebTorrent. O auxiliar de renderer
também consulta métricas pelo IPC real e verifica os sensores nativos de disco e
event loop do Electron em perfil isolado.

O adaptador UDP preserva as assinaturas com offset e normalizada usadas pelo Node
ao reenviar sua fila após o bind. O teste com socket nativo verifica conclusão de
envios locais e callbacks; isso não comprova entrega dos datagramas nem comunicação
com trackers externos.
