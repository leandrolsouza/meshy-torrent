# Primeiro release do Meshy

O candidato inicial é **0.1.0-beta.1 para Windows x64**, com instalador NSIS por
usuário. macOS e Linux continuam configurados no electron-builder, mas precisam de
homologação própria antes de serem anunciados como plataformas deste release.

A beta será distribuída **sem assinatura Authenticode e com atualização manual**,
conforme a decisão atual do projeto. O certificado ficou para uma etapa futura;
a ausência dele não é um bloqueio para gerar este candidato. O atualizador permanece
desabilitado nos pacotes sem assinatura.

## Gerar o candidato

Na raiz do repositório, com Node.js 22.17.0, npm e as ferramentas nativas do Windows:

```sh
npm ci
npm run typecheck
npm run lint
npm run security:audit
npm test -- --runInBand
npm run qa:release
npm run dist:win
```

`dist:win` compila as fontes, prepara o ícone, recompila dependências nativas,
gera o instalador e calcula SHA-256. Pode precisar de rede para baixar Electron,
cabeçalhos e ferramentas do electron-builder. Não executa o instalador nem publica.

Arquivos esperados para esta versão:

- `dist/Meshy-0.1.0-beta.1-win-x64-setup.exe`
- `dist/Meshy-0.1.0-beta.1-win-x64-setup.exe.blockmap`
- `dist/latest.yml`
- `dist/SHA256SUMS`

O checksum inclui instalador, blockmap e manifesto `latest.yml` da versão atual.
O comando falha se arquivos estiverem ausentes ou se versão/SHA-512 do manifesto
não corresponderem ao instalador; instaladores antigos não entram no checksum.
Se futuramente houver assinatura, gere-a durante o build: alterar o instalador
depois invalida o manifesto.
Veja [assinatura e atualizações](AUTO_UPDATES.md).

Para conferir no PowerShell, execute na pasta dos arquivos extraídos:

```powershell
Get-Content SHA256SUMS
Get-FileHash -Algorithm SHA256 .\Meshy-0.1.0-beta.1-win-x64-setup.exe
Get-AuthenticodeSignature .\Meshy-0.1.0-beta.1-win-x64-setup.exe
```

Compare o hash calculado com `SHA256SUMS`. Um checksum não comprova a identidade
do editor; registre separadamente o resultado da assinatura Authenticode.

## Verificação local em 18/10/2026

Preparação executada com Node.js 22.17.0 e Electron 44.7.0:

- `npm run dist:win`: instalador e arquivos de atualização gerados, com SHA-256 conferido
  independentemente com `Get-FileHash`.
- `Get-AuthenticodeSignature`: instalador e executável do app retornaram `NotSigned`.
- Conteúdo de `app.asar`: main, preload, renderer, ícone e licença presentes;
  binários nativos encontrados em `app.asar.unpacked`.
- WebTorrent e `node-datachannel` importados com sucesso usando o executável
  empacotado em modo Node, sem abrir a interface nem acessar a sessão do usuário.
- `npm run typecheck`: aprovado nos três projetos.
- `npm test -- --runInBand`: 99 suítes e 1.595 testes aprovados, incluindo o
  atualizador e a regressão de restauração de metadados sem magnet original.
- `npm run lint`: nenhum erro, com 297 avisos preexistentes; arquivos de código
  alterados também conferidos separadamente, sem erros.
- Prettier dos arquivos alterados e `git diff --check`: aprovados.
- YAML do workflow analisado localmente; execução no GitHub ainda pendente.
- Build isolado com `forceCodeSigning=true` rejeitado por ausência de certificado,
  confirmando a proteção do comando opcional `dist:win:signed`. O workflow da beta
  usa `dist:win` e permite candidatos sem assinatura também por tag.
- Módulos `electron-updater` e `js-yaml` carregados no Electron empacotado em modo
  Node; os três arquivos de `SHA256SUMS` conferidos independentemente.
- `npm run qa:release`: transferência TCP local real de 4 MiB com pausa, retomada,
  recriação do cliente, restauração de sessão, integridade SHA-256 e remoção mantendo
  o arquivo. Renderer/preload de produção exercitados com serviços e IPC reais,
  temas claro/escuro e pt-BR/en-US. Veja o [escopo e limites](QA_RELEASE.md).
- `npm run security:audit`: aprovado com quatro entradas cobertas pela avaliação
  restrita de aplicabilidade; relatório bruto preservado, com quatro alertas altos.

A primeira execução completa encontrou uma falha intermitente na propriedade 2
de `tests/unit/ipcHandlerOpenDestination.pbt.test.ts`, com seed `1844049217` e
contraexemplo `a.bmp`. O teste reconhecia somente `.mp4`, embora o app já permita
abrir `.bmp`, `.aac` e `.m4a`. A expectativa foi corrigida e os quatro formatos
passaram a ter exemplos fixos, preservando as 100 execuções aleatórias. O código
de abertura de arquivos não foi alterado.

Essas verificações automatizadas não incluem instalação em máquina limpa, execução completa de
`main/index.ts`, swarm público ou atualização entre versões assinadas. O instalador
é um candidato para homologação, ainda não publicado.

Em 18/10/2026, o usuário confirmou que instalou o candidato em sua própria máquina
e que o aplicativo está funcionando. O relato registra instalação e funcionamento
geral nesse ambiente; não comprova os cenários específicos do roteiro abaixo nem
a instalação em máquina limpa.

## Automação

O workflow [Beta Windows x64](../.github/workflows/windows-beta.yml) verifica tipos,
lint, testes, build e `qa:release` em PRs e pushes para `main`/`master`. Execuções
manuais e tags `v*` geram o candidato sem exigir certificado. O workflow registra
o estado Authenticode e guarda os arquivos da atualização e checksums por 14 dias,
além das evidências de homologação. Não instala nem publica o candidato.
Tags precisam corresponder à versão do manifesto, por exemplo `v0.1.0-beta.1`.

A auditoria de produção roda em um job independente com `npm run security:audit`.
Ela preserva o relatório bruto e rejeita alertas altos/críticos, exceto a cadeia
exata coberta pela [avaliação de aplicabilidade](SECURITY_REVIEW.md), com versões,
fontes e prazo fixados. Falha na auditoria impede a liberação pública. O workflow
tem somente permissão de leitura do repositório e não cria GitHub Releases.

A [execução 39144212334](https://github.com/leandrolsouza/meshy-torrent/actions/runs/39144212334),
do commit `58d3f8e`, falhou no teste de symlink/junction e no comando bruto de auditoria.
O teste simulava `lstat` comparando caminhos textualmente, sem considerar a
canonicalização de `realpath` no Windows. Foi substituído por uma junction real
em diretório temporário próprio, conferindo a rejeição e a preservação dos arquivos.
A revisão atual da auditoria aplica a política restrita acima. Uma nova execução
remota com essas correções ainda é necessária; o QA não chegou a rodar naquele job.

O `format:check` global possui pendências preexistentes. A automação confere a
formatação da infraestrutura de release; não afirma que todo o repositório está
formatado. Trate a dívida restante em alteração própria.

## Homologação em máquina limpa

Use uma VM Windows x64 sem Node.js, npm ou checkout do projeto. Registre versão do
Windows, commit, hash do instalador, resultado e evidências para cada cenário.
Use somente conteúdo de teste próprio ou autorizado.

- [ ] Instalar sem privilégios de administrador, inclusive em caminho com espaços.
- [ ] Abrir pelo atalho e confirmar nome, versão e ícone.
- [ ] Adicionar magnet e `.torrent`, revisar arquivos e escolher a pasta.
- [ ] Abrir magnet e `.torrent` pelo sistema com o app fechado e já aberto.
- [ ] Baixar até concluir e comparar a integridade dos arquivos com a origem.
- [ ] Confirmar upload/seeding com outro peer de teste.
- [ ] Pausar, retomar, encerrar e reabrir sem perder progresso, seleção ou fila.
- [ ] Testar vários downloads e respeitar limites de velocidade e simultaneidade.
- [ ] Interromper e restabelecer a rede; conferir recuperação e mensagens.
- [ ] Testar pasta sem acesso e falta de espaço em um volume descartável.
- [ ] Remover mantendo arquivos e remover excluindo arquivos de teste.
- [ ] Conferir bandeja, encerramento e liberação dos processos.
- [ ] Reinstalar sobre o candidato anterior preservando a sessão de teste.
- [ ] Desinstalar e conferir atalhos e associações, preservando os downloads.
- [ ] Homologar atualização entre duas versões assinadas, incluindo confirmação,
      modo bandeja e restauração da sessão, conforme [AUTO_UPDATES.md](AUTO_UPDATES.md).

O último item só se aplica quando a assinatura e o atualizador forem ativados.
O teste local automatizado não comprova seeding contínuo pelo Meshy: atualmente
a engine encerra as conexões ao concluir, conforme detalhado em [QA_RELEASE.md](QA_RELEASE.md).

As suítes Jest usam mocks de Electron/WebTorrent; não substituem esses testes.
Um instalador gerado com sucesso também não comprova que o app inicia ou baixa.

## Segurança e pendências

Em 18/10/2026, `npm audit --omit=dev --json` retornou quatro entradas de severidade
alta na cadeia `webtorrent → torrent-discovery → bittorrent-tracker → ip`. Elas
derivam do mesmo [aviso GHSA-2p57-rm9w-gvfp](https://github.com/advisories/GHSA-2p57-rm9w-gvfp),
relativo à classificação de endereços por `ip.isPublic`, sem versão corrigida
indicada no aviso consultado.

Na árvore instalada, `bittorrent-tracker@11.2.3` importa `ip` em
`lib/server/parse-udp.js` e usa `toString`; a busca nos consumidores não encontrou
chamadas a `ip.isPublic`. Essa observação estática ajuda a avaliar aplicabilidade,
mas não elimina o alerta nem equivale a uma auditoria completa de segurança.
O downgrade para WebTorrent 0.7.3 sugerido pelo npm não foi aplicado. A avaliação
explícita dos caminhos usados e a exceção técnica temporária estão registradas em
[SECURITY_REVIEW.md](SECURITY_REVIEW.md). Os quatro alertas permanecem visíveis no
relatório bruto; a verificação restrita não os declara corrigidos.

Também é necessário revisar os fluxos de IPC, abertura/exclusão de arquivos,
metadados não confiáveis e privacidade dos logs antes da liberação pública.

## Liberar a publicação

- [ ] Tipos, testes, lint e build do commit candidato aprovados.
- [ ] Workflow executado no GitHub e logs revisados.
- [x] Avaliação explícita registrada para o aviso de `ip`, com exceção restrita e prazo.
- [ ] Auditoria do commit final aprovada dentro do prazo da avaliação.
- [ ] Homologação em máquina limpa concluída com o instalador final.
- [ ] Confirmar que a beta sem assinatura mantém a atualização manual.
- [ ] Licença, autoria e avisos de terceiros conferidos no pacote final.
- [ ] [Notas da versão](releases/0.1.0-beta.1.md) atualizadas com resultados reais.
- [ ] Tag, commit e arquivos finais correspondem; checksums calculados após o build final.
- [ ] Criar o GitHub Release como **pre-release** e anexar instalador, blockmap,
      `latest.yml` e `SHA256SUMS` da mesma execução.

O atualizador está integrado, com instruções em [AUTO_UPDATES.md](AUTO_UPDATES.md).
Enquanto não houver certificado, o candidato permanece com instalação manual e
informa essa limitação na interface.
