# Roadmap para o Meshy Torrent 1.0.0

Planejamento criado em **27/10/2026**, a partir da versão **0.1.0-beta.14** de
`package.json`. Os marcos abaixo são planejados; nenhum deles é considerado entregue
por estar neste documento. As versões indicam a sequência de evolução, sem compromisso
de datas. Correções podem continuar saindo na linha beta atual.

## Objetivo da 1.0

Entregar um cliente torrent desktop simples, confiável e organizado para uso diário:
adicionar conteúdo, escolher arquivos, controlar banda e compartilhamento, recuperar
uma sessão e entender problemas sem depender de conhecimento técnico.

A plataforma inicial de lançamento será **Windows x64**, que já possui um fluxo de
empacotamento e homologação. macOS e Linux permanecem como objetivos do projeto, mas
só serão anunciados como suportados após homologação própria. O suporte multiplataforma
da arquitetura não substitui a validação de cada pacote.

## Ponto de partida

Recursos encontrados no código atual, a preservar ao longo dos marcos:

- Entrada por magnet, `.torrent`, arrastar e soltar e associação com o sistema.
- Revisão antes de iniciar, seleção de arquivos, destino por torrent e proteção de espaço.
- Pausa, retomada, remoção, fila reordenável, ações em lote e importação de múltiplas entradas.
- Persistência de sessão, localização de arquivos, movimentação e verificação de integridade.
- Seeding após conclusão, controle individual e limite de seeders simultâneos.
- Limites globais de velocidade, modo leve e agendamento por dia e horário.
- Trackers por torrent e globais, opções DHT/PEX/uTP e detalhes de peers, peças e velocidade.
- Busca na lista, filtros, temas, pt-BR/en-US, notificações e operação na bandeja.
- Atualizador integrado para Windows x64 pelo feed oficial, inclusive em builds sem
  certificado conforme a política atual; assinatura do editor ainda é uma pendência.

Referências: [contratos](../shared/types.ts), [engine](../main/torrentEngine.ts),
[gerenciador](../main/downloadManager.ts), [seeding](SEEDING.md),
[atualizador](../main/updatePolicy.ts) e [homologação](QA_RELEASE.md).
Esta lista registra implementação encontrada, não uma nova execução de testes.

## Sequência dos marcos

| Marco planejado | Resultado para o usuário                                   | Dependência principal          |
| --------------- | ---------------------------------------------------------- | ------------------------------ |
| 0.2.0           | Entradas mais compatíveis e limites da engine conhecidos   | Beta atual                     |
| 0.3.0           | Controle de compartilhamento e prioridade dos arquivos     | 0.2.0                          |
| 0.4.0           | Biblioteca organizada e importação por pasta monitorada    | 0.3.0                          |
| 0.5.0           | Controle explícito da interface de rede                    | Viabilidade em 0.2.0           |
| 0.9.0           | Escopo congelado, experiência revisada e desempenho medido | Marcos funcionais              |
| 1.0.0-rc.N      | Candidato instalado e homologado com evidências            | 0.9.0                          |
| 1.0.0           | Primeira versão estável para Windows x64                   | Aprovação dos critérios finais |

Antes de cada versão final de um marco, publicar betas incrementais conforme necessário.
Não acumular todas as entregas em uma única alteração. Cada item deve gerar uma tarefa
com responsável, critérios de aceite e evidência de validação.

## 0.2.0 — Compatibilidade e decisões técnicas

- [ ] **COMP-01 — Ampliar a leitura de magnets.** Aceitar `btih` hexadecimal e Base32,
      parâmetros em ordens diferentes e múltiplos `xt`, normalizando a identidade antes
      de verificar duplicatas. Manter limites de entrada e validação de URLs.
- [ ] **COMP-02 — Documentar a matriz de compatibilidade.** Exercitar torrents v1,
      privados, híbridos e v2 com fixtures próprias ou de distribuição autorizada.
      Confirmar o que a versão instalada de WebTorrent realmente suporta. Entradas
      incompatíveis devem receber uma mensagem específica antes de ocupar a fila.
- [ ] **TECH-01 — Provar as capacidades necessárias da engine.** Validar prioridade
      de arquivos, limites por torrent e vínculo a uma interface de rede. Exercitar
      também o cliente temporário que resolve metadados, não apenas o downloader.
- [ ] **DOC-01 — Corrigir informações operacionais desatualizadas.** Alinhar README,
      versão, atualização e limites da homologação com o comportamento do código.

**Aceite:** adicionar a mesma identidade em formatos diferentes não duplica o torrent;
restaurar a sessão preserva essa identidade; formatos não suportados têm diagnóstico
claro. Registrar a viabilidade de TECH-01 antes de prometer controles na interface.
Suporte nativo completo a v2 não é condição da 1.0 se depender de troca de engine;
reconhecimento, diagnóstico e documentação são obrigatórios.

**Áreas:** `shared/validators.ts`, `shared/types.ts`, `main/torrentInput.ts`,
`main/torrentPreparation.ts`, `main/torrentEngine.ts` e fluxo de adição no renderer.

## 0.3.0 — Controle de transferência e compartilhamento

- [ ] **SEED-01 — Estatísticas persistentes.** Exibir bytes enviados, ratio e tempo
      efetivo de seed por torrent. Definir que sessões antigas começam a contabilizar
      upload a partir da migração, sem inventar histórico. Tratar ratio sem download.
- [ ] **SEED-02 — Metas de seeding.** Configurar ratio ou duração globalmente e permitir
      substituição por torrent. Parar o seed quando qualquer meta habilitada for atingida,
      mantendo os dados. Respeitar pausa manual, slots e escolha individual de seed.
- [ ] **FILE-01 — Prioridade por arquivo.** Oferecer não baixar, normal e alta,
      preservando prioridade e seleção após reiniciar. Manter a prioridade da fila de
      torrents como um controle independente.
- [ ] **BAND-01 — Limites por torrent.** Permitir limites próprios de download/upload,
      subordinados ao limite global e ao modo leve/agendado. Definir unidades e o
      significado de ilimitado de forma consistente na interface e na persistência.

**Aceite:** verificar contadores sem duplicação após pause/resume/restart; tempo pausado
não conta como seed; alcançar uma meta não remove arquivos. Em transferência controlada,
observar efeito das prioridades e limites, com tolerância documentada para médias de banda.
Limites individuais nunca autorizam ultrapassar o teto global.

**Áreas:** `shared/types.ts`, `main/downloadManager.ts`, `main/downloadSession.ts`,
`main/torrentEngine.ts`, `main/bandwidthController.ts`, seleção de arquivos e configurações.

## 0.4.0 — Organização e automação local

- [ ] **ORG-01 — Categorias e tags.** Uma categoria e múltiplas tags por torrent,
      criação/renomeação/exclusão, filtros e edição em lote. Remover uma categoria ou
      tag não pode remover o torrent nem seus arquivos.
- [ ] **ORG-02 — Destino por categoria.** Usar a pasta da categoria como sugestão para
      novas adições. Alterar uma categoria não move dados existentes silenciosamente;
      movimentação continua passando pelo fluxo explícito já existente.
- [ ] **AUTO-01 — Pasta monitorada.** Importar `.torrent` de pastas escolhidas, com
      ativação explícita, destino definido e opção de adicionar pausado. Esperar o
      arquivo estabilizar, evitar duplicatas e informar falhas por entrada. Não excluir
      o arquivo de origem automaticamente.

**Aceite:** organização e filtros sobrevivem ao reinício; importação lida com gravação
parcial, duplicatas, perda de acesso e reabertura do app sem adicionar repetidamente.
Importação automática mantém validação de conteúdo, proteção de espaço e fila.

**Áreas:** contratos, configurações, sessão, novo serviço de monitoramento no main,
fluxo de admissão e componentes da lista. A busca existente continua sendo busca na
biblioteca; busca de torrents em fontes externas fica para depois da 1.0.

## 0.5.0 — Interface de rede e conectividade

- [ ] **NET-01 — Escolher a interface de rede.** Oferecer modo automático e vínculo
      explícito a um adaptador disponível, inclusive VPN. Detectar interface removida,
      renomeada ou indisponível sem trocar silenciosamente para outra.
- [ ] **NET-02 — Bloquear transferências fora da interface escolhida.** Cobrir peers,
      trackers, DHT, PEX, uTP, fontes HTTP e resolução de metadados, incluindo os caminhos
      de resolução DNS utilizados. Interface indisponível interrompe a atividade afetada
      e apresenta orientação clara; restauração não pode ignorar o vínculo salvo.
- [ ] **NET-03 — Porta e diagnóstico de conectividade.** Expor porta de escuta e estado
      de mapeamento quando suportados pela engine. Distinguir porta local aberta de
      acessibilidade externa; não anunciar teste externo sem evidência.

**Aceite:** capturar o tráfego em ambiente controlado ao conectar/desconectar a VPN,
reiniciar o app e preparar magnets. Nenhum tráfego de transferência ou descoberta deve
escapar pela interface alternativa. O vínculo não promete anonimato e seu alcance deve
estar explicado na interface e no guia de uso.

**Risco principal:** a engine pode não permitir aplicar o vínculo a todos os transportes.
TECH-01 deve resolver isso cedo. Se exigir alteração estrutural, registrar alternativas,
impacto e decisão de escopo antes de implementar. Até existir prova completa, não expor
um controle que prometa proteção parcial. Qualquer retirada de NET-01/NET-02 da 1.0
exige revisão explícita deste roadmap; não conta como entrega concluída.

**Áreas:** engine, preparação, transports HTTP/UDP, política de rede, settings e IPC.
Proxy SOCKS e blocklists ficam fora deste marco.

## 0.9.0 — Estabilização e experiência de uso

- [ ] **UX-01 — Revisar os fluxos completos.** Adição, seleção, prioridades, seed,
      organização, recuperação, bandeja e mensagens de erro em pt-BR/en-US. Validar
      teclado, foco, leitor de tela, contraste e escalas de 100%, 150% e 200%.
- [ ] **PERF-01 — Registrar uma referência reproduzível.** Medir inicialização,
      CPU/memória por processo, latência de ações e atualização da lista no mesmo
      hardware, com a mesma rede e fixtures. Usar o monitoramento já existente.
- [ ] **PERF-02 — Validar carga e duração.** Catálogo de 500 torrents majoritariamente
      inativos, um torrent com 1.000 arquivos e até 10 downloads simultâneos, respeitando
      o limite atual. Executar uma sessão de 8 horas com download, seed e bandeja,
      além de ciclos de pause/resume e reinício.
- [ ] **REL-01 — Exercitar falhas reais.** Queda/retorno de rede, suspensão do sistema,
      destino indisponível, disco cheio, encerramento inesperado e migração da beta.
- [ ] **DIST-01 — Definir a distribuição estável.** Buscar assinatura Authenticode,
      validar o instalador e o atualizador. Se não houver certificado, registrar uma
      decisão explícita de distribuição sem assinatura e seus efeitos antes do RC.

**Metas iniciais de homologação, ainda não medidas:** ações locais de filtro, seleção e
abertura de detalhes com resposta p95 de até 200 ms no hardware de referência; nenhuma
perda de dados/sessão, crash ou crescimento contínuo de memória na sessão de 8 horas.
Anexar séries temporais de recursos e definir tetos de CPU/memória a partir de PERF-01
antes da aprovação de PERF-02. Qualquer ajuste nas metas deve ser justificado e registrado.

Congelar funcionalidades ao concluir este marco. Recursos novos passam para o backlog
pós-1.0; o caminho até a estável fica dedicado a correções, documentação e homologação.

## 1.0.0-rc.N e 1.0.0 — Critérios de lançamento

- [ ] Todos os itens obrigatórios dos marcos anteriores concluídos ou removidos por
      decisão de escopo registrada, com impacto descrito e sem promessas pendentes na UI.
- [ ] Nenhum defeito aberto que cause perda/corrupção de dados, exposição indevida pela
      interface de rede, falha de instalação ou bloqueio de um fluxo essencial sem solução.
- [ ] Auditoria de produção aprovada pela política vigente; avaliações de aplicabilidade
      com evidência atual e dentro do prazo, sem ampliar exceções apenas para liberar.
- [ ] Tipos, lint, testes, build, QA de transferência/renderer e empacotamento aprovados
      no mesmo commit candidato. Registrar avisos preexistentes e impedir novos erros.
- [ ] Homologação do instalador em máquina limpa, instalação por cima da beta, migrações,
      associações de arquivos/magnets, bandeja, encerramento e desinstalação concluída.
- [ ] Transferência autorizada em swarm público e interoperabilidade com outro cliente
      verificadas, incluindo upload após conclusão e integridade dos dados recebidos.
- [ ] Atualização real entre versões de teste homologada, sem oferecer versões beta/RC
      aos usuários do canal estável. Confirmar comportamento do feed e dos manifestos.
- [ ] Workflow preparado para RC e release estável: o job atual publica somente tags beta.
      Separar canais, validar versão/tag e impedir publicação antes das verificações.
- [ ] README, guia de uso, matriz de plataformas/formatos, problemas conhecidos e notas
      de versão consistentes com o candidato. Notas de release permanecem em inglês.
- [ ] Teste de campo de pelo menos 14 dias do RC final, com relatos triados e sem bloqueios.
      Alteração funcional ou correção de bloqueio gera novo RC e reinicia esse período.

Comandos existentes para a homologação, executados a partir da raiz:

```sh
npm run typecheck
npm run lint
npm run security:audit
npm test -- --runInBand
npm run qa:release
npm run dist:win
```

Conferir também Prettier nos arquivos alterados e `git diff --check`. A checagem global
de formatação possui dívida registrada em [RELEASE.md](RELEASE.md), a revisar no marco
de estabilização. `qa:release` já compila; `dist:win` volta a compilar para empacotar.
Esses comandos não comprovam sozinhos os cenários manuais, desempenho ou publicação.

O fluxo de distribuição deve seguir [RELEASE.md](RELEASE.md),
[AUTO_UPDATES.md](AUTO_UPDATES.md), [SECURITY_REVIEW.md](SECURITY_REVIEW.md) e
[QA_RELEASE.md](QA_RELEASE.md), atualizados quando o canal estável for implementado.

## Depois da 1.0

O [roadmap pós-1.0](ROADMAP_POST_1_0.md) detalha as versões propostas de 1.1 a 1.7,
manutenção contínua e os critérios para uma eventual 2.0. A tabela abaixo resume
os recursos que não bloqueiam a primeira versão estável.

| Recurso                                     | Motivo para adiar                                                                 | Pré-requisito                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| Download sequencial e reprodução antecipada | Experiência própria de buffering, busca e formatos; amplia a superfície de testes | Prioridade de peças e prova de streaming        |
| RSS com regras                              | Automação externa exige deduplicação, histórico e tratamento seguro de feeds      | Admissão automatizada e organização estáveis    |
| Web UI/API e controle por celular           | Introduz autenticação, autorização e serviço de rede                              | Modelo de acesso remoto e revisão de segurança  |
| Busca externa integrada                     | Exige manutenção de provedores/plugins e novas entradas externas                  | Arquitetura de provedores e política de fontes  |
| Criação de torrents                         | Amplia o uso para publicação e distribuição de conteúdo                           | Fluxo de metadados e seed inicial               |
| macOS e Linux homologados                   | Precisam de pacotes, integração e QA específicos                                  | Responsáveis, ambientes e matriz de suporte     |
| Proxy SOCKS e blocklists                    | Cada transporte precisa respeitar a política escolhida                            | Controle de rede validado                       |
| Suporte completo a v2, se ausente na engine | Pode exigir migração estrutural                                                   | Matriz de compatibilidade e avaliação de engine |

Streaming é o primeiro diferencial proposto no planejamento pós-1.0. A sequência
deve ser reavaliada com relatos de uso e demanda; os marcos continuam sem datas fixas
e dependem da validação técnica e dos critérios de entrega do documento complementar.

## Acompanhamento

Cada tarefa deve registrar: ID deste documento, responsável, status, dependências,
escopo, critérios de aceite, riscos e links para alteração e evidências. Usar os estados
planejado, em andamento, bloqueado e concluído. Marcar o checkbox somente após validar
o aceite; percentuais de cobertura ou quantidade de testes não substituem o resultado.

A próxima entrega recomendada é **0.2.0**, começando por COMP-01 e TECH-01. Ao concluir
cada marco, atualizar este documento com a versão entregue, os resultados e eventuais
mudanças de escopo. Este planejamento não altera a versão do aplicativo nem publica releases.
