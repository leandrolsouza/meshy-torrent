# Roadmap do Meshy Torrent após a 1.0.0

Proposta criada em **27/10/2026**, complementar ao [roadmap até a 1.0](ROADMAP.md).
O aplicativo ainda está em **0.1.0-beta.14**; todos os marcos deste documento são
futuros e dependem da estabilização da 1.0. As versões representam uma ordem proposta,
sem datas fixas e sem indicar funcionalidades já implementadas.

## Direção do produto

Depois de consolidar o download e o compartilhamento na 1.0, evoluir em três frentes:
**consumir conteúdo durante o download**, **automatizar tarefas repetidas** e
**gerenciar o cliente de outros dispositivos**. Manter o aplicativo desktop útil
sem cadastro obrigatório ou dependência de um serviço em nuvem.

Streaming será o primeiro diferencial visível. Automação e controle remoto ampliam
o uso para bibliotecas recorrentes e computadores que permanecem ligados. O suporte
a outras plataformas terá sua própria homologação, sem depender da conclusão de
todos os recursos desktop.

## Visão das versões

| Linha proposta            | Foco                             | Resultado principal                                              |
| ------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| 1.0.x e patches seguintes | Manutenção contínua              | Corrigir falhas e preservar dados, segurança e atualização       |
| 1.1.0                     | Reprodução antecipada            | Começar a assistir ou ouvir antes de concluir                    |
| 1.2.0                     | RSS e regras                     | Receber novos conteúdos automaticamente, com controle            |
| 1.3.0                     | Criação e compartilhamento       | Criar um torrent próprio e distribuir os arquivos                |
| 1.4.0                     | macOS e Linux                    | Entregar pacotes e integração homologados por plataforma         |
| 1.5.0                     | Web UI e API                     | Controlar o app pelo navegador do celular ou de outro computador |
| 1.6.0                     | Rede e compatibilidade avançadas | Ampliar protocolos e opções sem enfraquecer controles existentes |
| 1.7.0                     | Busca por provedores             | Encontrar torrents em fontes configuradas pelo usuário           |
| 2.0.0, se necessária      | Evolução estrutural              | Viabilizar mudanças incompatíveis com migração explícita         |

As versões 1.x devem preservar os contratos públicos suportados e migrar sessões e
configurações automaticamente. Mudanças incompatíveis nesses contratos podem exigir
uma versão principal. Não reservar 2.0 apenas pela quantidade de funcionalidades.

## Manutenção contínua — 1.0.x e patches das linhas seguintes

- [ ] **MAINT-01 — Consolidar o retorno da estável.** Triar relatos com versão,
      plataforma e passos reproduzíveis, priorizando perda de dados, crash,
      instalação, atualização e regressões de transferência.
- [ ] **MAINT-02 — Manter a base atualizada.** Revisar dependências, runtime Electron,
      auditoria e avaliações de aplicabilidade. Repetir homologações afetadas por
      mudanças da engine ou das dependências nativas.
- [ ] **MAINT-03 — Preservar referências de desempenho.** Comparar recursos e fluxos
      com as medições da 1.0, incluindo bibliotecas grandes e sessões prolongadas.

**Aceite:** cada correção inclui reprodução e validação proporcionais ao impacto;
o pacote aprovado recebe notas de versão e atualização testada. Nenhuma funcionalidade
nova bloqueia a entrega de uma correção urgente. O ritmo de patches acompanha os
problemas encontrados, sem esperar pela próxima versão de funcionalidades.

## 1.1.0 — Download sequencial e reprodução antecipada

- [ ] **MEDIA-01 — Validar a experiência com a engine atual.** Provar priorização de
      peças, leitura parcial e reposicionamento durante a reprodução. Definir e
      publicar uma matriz inicial de formatos/codecs efetivamente homologados.
- [ ] **MEDIA-02 — Oferecer download sequencial.** Permitir ativação por torrent,
      informar o efeito sobre a ordem das peças e preservar seleção e limites de banda.
- [ ] **MEDIA-03 — Reproduzir áudio e vídeo no aplicativo.** Controles de reprodução,
      volume, posição e buffer, com mensagens para falta de dados ou formato incompatível.
      Evitar prometer reprodução imediata quando o swarm não entrega dados suficientes.
- [ ] **MEDIA-04 — Preservar o download ao fechar o player.** Encerrar a reprodução
      libera os recursos temporários e devolve a prioridade normal das peças.

**Aceite:** reproduzir antes da conclusão, avançar para uma região ainda não baixada,
pausar/retomar e lidar com perda de peers. Comparar o arquivo final com a origem e
validar o vínculo de rede da 1.0 durante todo o fluxo. Caso seja necessário um servidor
local, restringir o acesso à sessão do player e aos arquivos daquele torrent.

**Limites da primeira entrega:** sem transcodificação, casting ou promessa de suporte
a qualquer formato. Falha de reprodução não deve impedir baixar e abrir o arquivo
completo pelo fluxo existente. Casting pode entrar em versão posterior após homologação.

## 1.2.0 — RSS com regras e automação

- [ ] **RSS-01 — Gerenciar feeds.** Adicionar, editar, remover e atualizar feeds,
      exibindo itens, data da última consulta e falhas de atualização.
- [ ] **RSS-02 — Configurar regras.** Filtrar por texto e, opcionalmente, expressão
      regular com execução limitada; escolher categoria, tags, destino e iniciar
      pausado ou automaticamente.
- [ ] **RSS-03 — Simular antes de ativar.** Mostrar quais itens uma regra selecionaria
      e pedir escolha explícita entre importar o histórico ou somente novos itens.
- [ ] **RSS-04 — Manter histórico persistente.** Evitar duplicatas após reiniciar,
      permitir nova tentativa de falhas e explicar por que uma entrada foi ignorada.

**Aceite:** validar feeds indisponíveis ou malformados, itens repetidos, mudança de URL,
regras inválidas e reinício durante uma importação. Reutilizar fila, proteção de espaço,
limites de importação e políticas de acesso a URLs. Consultas usam intervalo limitado,
timeouts e espera progressiva em falhas; o aplicativo precisa estar em execução.

**Dependências:** categorias e admissão automatizada previstas na 1.0. Remover uma regra
ou feed não remove torrents já adicionados. Não oferecer execução arbitrária de scripts
como parte desta versão.

## 1.3.0 — Criar torrents e compartilhar arquivos próprios

- [ ] **SHARE-01 — Criar a partir de arquivo ou pasta.** Informar nome, trackers,
      comentário e modo privado, validando as combinações suportadas.
- [ ] **SHARE-02 — Mostrar progresso e cancelamento.** Calcular metadados sem bloquear
      a interface, tratar arquivos alterados durante a leitura e não deixar um
      `.torrent` parcial apresentado como concluído.
- [ ] **SHARE-03 — Exportar e iniciar seed.** Salvar `.torrent`, copiar magnet quando
      compatível e oferecer seed inicial explícito dos arquivos existentes.

**Aceite:** outro cliente recebe o conteúdo criado e o resultado tem integridade
verificada. Cancelamento preserva os arquivos de origem. Torrents privados mantêm
as restrições de descoberta e não oferecem magnet como substituto autossuficiente
dos metadados privados. Regras de ratio e seed continuam sendo respeitadas.

## 1.4.0 — macOS e Linux homologados

- [ ] **PLAT-01 — Definir a matriz oficial.** Registrar versões mínimas dos sistemas,
      arquiteturas e formatos de pacote que terão suporte, conforme ambientes disponíveis.
- [ ] **PLAT-02 — Homologar macOS.** Instalação, assinatura/notarização conforme a
      distribuição adotada, módulos nativos, permissões, integração com magnets e
      `.torrent`, bandeja e ciclo de vida de janelas.
- [ ] **PLAT-03 — Homologar Linux.** Pacotes escolhidos, dependências nativas,
      integração desktop e disponibilidade do armazenamento seguro nos ambientes
      suportados. Não introduzir fallback silencioso para dados sensíveis em texto puro.
- [ ] **PLAT-04 — Definir atualização por plataforma.** O atualizador hoje está
      limitado a Windows x64. Implementar e testar o caminho de cada plataforma ou
      documentar a atualização pelo gerenciador de pacotes/instalador adotado.

**Aceite:** instalar em ambiente limpo, atualizar de uma versão de teste, transferir
e semear dados, restaurar sessão e validar rede/VPN em cada combinação anunciada.
Windows mantém sua regressão. macOS e Linux podem ser liberados separadamente;
arquiteturas não homologadas não entram na matriz por inferência.

Esta frente pode ser antecipada conforme disponibilidade de ambientes e responsáveis.
Ela não precisa esperar pela criação de torrents ou RSS.

## 1.5.0 — Web UI, API e controle pelo celular

- [ ] **REMOTE-01 — Definir o acesso.** Serviço desativado por padrão, configuração
      explícita de endereço/porta e autenticação. Começar por acesso local/LAN;
      acesso pela internet depende de configuração documentada de transporte seguro.
- [ ] **REMOTE-02 — Publicar uma API versionada.** Listagem, adição, pausa, retomada,
      seed e consulta de progresso, com validação e limites de requisições próprios.
      IPC interno não deve virar uma API de rede automaticamente.
- [ ] **REMOTE-03 — Entregar Web UI responsiva.** Acompanhar transferências e executar
      as ações principais pelo navegador do celular, sem exigir um aplicativo móvel nativo.
- [ ] **REMOTE-04 — Controlar operações sensíveis.** Revogar sessões/tokens, proteger
      credenciais, restringir origens e separar permissões de consulta e alteração.
      Destinos remotos devem usar pastas autorizadas; nunca expor filesystem arbitrário.

**Aceite:** testar autenticação, revogação, acesso sem permissão, origens indevidas,
desconexão/reconexão e concorrência com o desktop. Remoção de dados exige confirmação
e autorização. O serviço não abre portas no roteador automaticamente.

**Limite:** o computador executando o Meshy continua sendo necessário. Servidor sem
interface gráfica, contas em nuvem e aplicativos móveis nativos ficam fora deste marco.

## 1.6.0 — Rede avançada e formatos de torrent

- [ ] **ADVNET-01 — Avaliar proxy SOCKS por transporte.** Definir o alcance para peers,
      trackers, DHT, fontes HTTP, DNS e resolução de metadados. Se um transporte não
      puder cumprir a política, bloqueá-lo ou não oferecer aquela configuração.
- [ ] **ADVNET-02 — Blocklists opcionais.** Importar listas, mostrar a origem e permitir
      desfazer a configuração; atualizações externas exigem ativação explícita.
      Explicar que filtragem de IP não garante anonimato ou conteúdo seguro.
- [ ] **COMP-03 — Ampliar suporte a v2/híbridos, se necessário.** Retomar a matriz da
      1.0 e verificar suporte real da engine. Considerar identidade, duplicatas,
      persistência, criação, streaming e interoperabilidade, além da leitura do arquivo.

**Aceite:** captura de tráfego confirma as políticas configuradas e sua combinação
com interface/VPN. Testes de sessão antiga e fixtures v1/v2/híbridas confirmam ausência
de colisões ou perda de seleção e histórico. Uma troca de engine precisa de avaliação
própria; mudanças incompatíveis não devem ser escondidas em uma versão 1.x.

## 1.7.0 — Busca externa por provedores

- [ ] **SEARCH-01 — Definir provedores suportados.** Começar com fontes selecionadas
      e documentadas, com ativação pelo usuário e manutenção identificada.
- [ ] **SEARCH-02 — Buscar e revisar resultados.** Exibir origem, nome e informações
      disponibilizadas pela fonte, sem apresentar contagens como garantia de disponibilidade.
      Adicionar sempre pelo fluxo de validação e revisão do app.
- [ ] **SEARCH-03 — Isolar falhas.** Aplicar timeout, cancelamento, limites de resposta
      e tratamento de fonte indisponível sem impedir o uso dos demais provedores.

**Aceite:** resultados duplicados, respostas malformadas e URLs incompatíveis não
contornam a política de rede nem travam a interface. Nenhum resultado é baixado só
por aparecer na busca. A primeira entrega não instala código arbitrário de terceiros.

## 2.0.0 — Decisão de arquitetura, quando houver necessidade

Avaliar uma versão principal quando a demanda ou as limitações medidas justificarem
mudanças incompatíveis. Candidatos à avaliação: engine alternativa, separação de um
serviço sem interface para NAS/servidor e gerenciamento de múltiplas instâncias.
Essas opções são hipóteses, não funcionalidades comprometidas.

Antes de aprovar essa frente, registrar o problema observado, alternativas, custos,
impacto em compatibilidade, plano de migração e recuperação. Comprovar transferência,
seed, desempenho e políticas de rede em um protótipo. Arquitetura modular adicional
deve resolver uma necessidade demonstrada; não é requisito para avançar nas versões 1.x.

## Critérios comuns e revisão das prioridades

Cada marco exige tarefas com responsável, critérios de aceite e evidências, seguindo
o acompanhamento do [roadmap da 1.0](ROADMAP.md). Contratos, persistência, IPC,
interface e traduções devem evoluir juntos quando forem afetados. Aplicar testes,
tipos, lint, build e QA proporcionais à alteração, além de homologação do pacote.

Manter atualizações estáveis separadas de betas e testar migração da versão anterior.
Revisar também avisos de terceiros, acessibilidade e custo de recursos dos novos fluxos.

Após cada release, comparar a prioridade seguinte com relatos de uso, defeitos,
capacidade de manutenção e provas de viabilidade. Registrar mudanças de ordem aqui.
Um recurso só é concluído após cumprir o aceite; marcar uma investigação como
concluída não significa entregar o recurso investigado.

A primeira decisão após a 1.0 será consolidar os patches necessários e validar
**MEDIA-01** antes de iniciar a interface de reprodução. Isso mantém o investimento
alinhado ao diferencial proposto sem interromper a manutenção da versão estável.
