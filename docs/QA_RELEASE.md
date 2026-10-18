# Homologação automatizada do candidato

Execute na raiz, com a árvore de dependências preparada para Electron:

```sh
npm run qa:release
```

O comando compila o aplicativo e os auxiliares de `scripts/qa/`, executa os cenários
abaixo e retorna código diferente de zero em falha ou timeout. Para executar somente
a transferência, sem compilar o renderer nem abrir uma janela Electron:

```sh
npm run qa:transfer
```

São usados o runtime Electron e os serviços reais do main. Não há mocks de
WebTorrent, engine ou download manager. A transferência usa um adaptador simples
de persistência JSON em disco; a interface usa ElectronStore real e o preload e
renderer compilados do projeto.

## Transferência local

1. Gera um arquivo próprio aleatório de 4 MiB e um torrent privado.
2. Inicia dois clientes WebTorrent sem trackers, DHT, PEX, LSD, uTP, UPnP ou NAT-PMP.
3. Conecta manualmente o downloader ao seeder por TCP em `127.0.0.1`.
4. Confirma recebimento de dados, pausa com encerramento das conexões e retomada.
5. Salva a sessão, destrói o cliente e recria os serviços a partir do arquivo salvo.
6. Restaura o torrent, reconecta ao peer e aguarda a conclusão.
7. Compara SHA-256 do conteúdo recebido com a origem e remove o torrent mantendo dados.

Esse cenário detectou um defeito em `main/downloadManager.ts`: sessões que
continham somente `torrentFileBase64`, sem magnet ou caminho do `.torrent`, eram
exibidas como ativas sem recriar o torrent na engine. A restauração agora deriva a
identidade pelo infoHash e prioriza os metadados salvos. O teste de regressão em
`tests/integration/session-persistence.test.ts` cobre estados ativo, pausado e na fila.

## Interface isolada

O auxiliar abre uma janela Electron oculta de 1200 × 800, com perfil descartável,
preload e renderer de produção, serviços reais e handlers IPC do aplicativo.
Mantém sandbox, context isolation e Node desabilitado no renderer. Usa o estado
de atualização sem assinatura e a versão de `package.json` fornecidos pelo auxiliar.

Confere carregamento, leitura de configurações, lista vazia, atualização manual,
tema aplicado, ausência de Node exposto e ausência de rolagem horizontal da página.
Captura a tela em `vs-code-dark` e `vs-code-light`, para `pt-BR` e `en-US`, após a
transição de cores. As quatro capturas foram inspecionadas visualmente na validação
local. A execução automatizada não substitui uma avaliação de acessibilidade e uso
por teclado.

## Evidências e isolamento

Cada execução cria uma pasta única `.build-resources/qa/run-*` e imprime seu caminho.
Ela contém relatórios `transfer-report.json` e `renderer-report.json`, logs,
capturas PNG, o arquivo de teste e sessões próprias. As pastas são ignoradas pelo
Git e preservadas para inspeção; o comando não limpa execuções anteriores.

O perfil habitual do Meshy e seus downloads não são usados. A integração de magnets
do sistema é bloqueada no auxiliar; nenhuma associação é registrada. A rede da
transferência fica restrita a peers locais, sem descoberta pública.

Em 18/10/2026, a execução local com Electron 44.7.0 passou os dois cenários. A suíte
Jest também passou: 97 suítes, 1.561 testes. O workflow Windows passou a executar
`qa:release` e guardar apenas relatórios, capturas e logs por 14 dias; sua execução
no GitHub ainda precisa ser confirmada.

## O que falta homologar

Este auxiliar não executa `main/index.ts` nem o instalador, não testa uma instalação
em máquina limpa, atalhos, bandeja, associações do sistema, desinstalação, instalação
por cima da beta ou entrega de atualização pelo GitHub. Esses cenários continuam
no [roteiro de release](RELEASE.md).

Também faltam swarm público, recuperação de rede externa, disco cheio, permissões,
concorrência e desempenho com vários torrents na execução desktop real. A engine
atual encerra as conexões ao concluir (`main/torrentEngine.ts`, listener `done`);
o seeder usado pelo auxiliar é outro cliente WebTorrent. Portanto, o resultado
não comprova upload/seeding contínuo pelo Meshy após a conclusão.

Os quatro alertas altos de dependências registrados no roteiro de release continuam
pendentes de correção ou avaliação explícita. A beta permanece sem assinatura e com
atualização manual por decisão do projeto; a homologação automática do atualizador
assinado fica para quando houver certificado.
