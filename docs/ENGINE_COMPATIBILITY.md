# Compatibilidade e capacidades da engine

Referência examinada: WebTorrent 3.0.21 e parse-torrent 11.0.24 da árvore instalada.
O comando abaixo gera fixtures próprias em memória, sem tráfego de rede:

```sh
node scripts/qa/compatibility.mjs
```

| Entrada    | Resultado observado no parser                         | Limite da evidência                                       |
| ---------- | ----------------------------------------------------- | --------------------------------------------------------- |
| v1         | Aceita os metadados e identifica um arquivo           | Não testa transferência ou interoperabilidade             |
| v1 privado | Aceita os metadados e reconhece o sinalizador privado | Não comprova comportamento de descoberta em swarm privado |
| híbrido    | Aceita os campos v1 e identifica o arquivo            | Não comprova validação, descoberta ou transferência v2    |
| v2 puro    | Rejeita arquivo sem `info.pieces` e magnet sem `btih` | Não há suporte v2 demonstrado                             |

O Meshy identifica magnets v2 puros e arquivos com `info.meta version = 2` sem
`info.pieces` antes de criar o cliente temporário e informa que são incompatíveis.
O reconhecimento do arquivo é uma inspeção limitada de bencode, não uma validação
completa: metadados malformados podem receber outro erro. Um híbrido é processado
pela identidade e peças v1; a presença dos campos v2 não comprova sua integridade
nem garante interoperabilidade v2. As fixtures são sintéticas, não uma homologação
com outro cliente. A matriz deve ser ampliada com transferência real autorizada.

## Investigação de TECH-01

- `node_modules/webtorrent/lib/file.js` encaminha `file.select(priority)` à seleção
  por intervalo de peças. `node scripts/qa/engine-selections.mjs` exercita a classe
  interna instalada: intervalos adjacentes são unidos e recebem a maior prioridade.
  Portanto, controles por arquivo precisam tratar também peças compartilhadas e a
  união de intervalos.
- `node_modules/webtorrent/index.js` cria grupos de limitação no cliente, e
  `lib/torrent.js` os entrega aos peers. A API examinada expõe limites globais;
  não foi demonstrado um limite por torrent combinado ao teto global.
- Não foi identificado um controle único de interface aplicável a todos os
  transportes. O downloader e o cliente temporário de `main/torrentPreparation.ts`
  são instâncias distintas. Vincular apenas conexões TCP não demonstraria cobertura
  de trackers, DHT, uTP, DNS e fontes HTTP.

Essas observações e o ensaio de seleção não são, por si só, provas de comportamento
de rede. A versão instalada deve ser reavaliada quando as dependências mudarem.

Em 27/10/2026, `npm run qa:transfer` inicialmente excedeu o tempo de espera dentro
do sandbox. `node scripts/qa/local-tcp-probe.mjs` identificou `EACCES` ao conectar
em loopback nesse ambiente. Fora dessa restrição, a homologação passou: transferência
privada local, pausa, restauração, seed, envio e comparação SHA-256 de 4 MiB. O
relatório da execução fica em `.build-resources/qa/run-XrHt5o/transfer-report.json`.

O comando `node scripts/metadata-smoke.mjs` compila e executa o serviço real de
preparação com cliente WebTorrent injetado e peer TCP local. Na mesma data, passou:
resolveu um magnet privado, recebeu tráfego de protocolo, não recebeu blocos de
conteúdo e encerrou o cliente antes de publicar a revisão. O relatório está em
`.build-resources/qa/metadata-UCfJdK/metadata-report.json`. O contador de tráfego
do torrent inclui metadados e cabeçalhos; o ensaio verifica blocos pelo contador do
protocolo de peças. Ambos usam descoberta e transportes externos desabilitados e
não substituem testes de swarm público, outros clientes ou vínculo de interface.

Em 27/10/2026, `node scripts/qa/priority-transfer.mjs` executou uma transferência
TCP local com arquivos próprios, alinhados em peças, e um arquivo não selecionado
separando os dois intervalos. Com prioridade 10 para um deles e 0 para o outro,
sete das primeiras oito peças verificadas pertenciam ao arquivo prioritário; o
arquivo intermediário recebeu zero bytes. Duas execuções passaram. Na segunda,
512 KiB de conteúdo foram verificados em 4.023 ms com o limite global de 128 KiB/s;
o relatório está em `.build-resources/qa/priority-prdf2J/priority-report.json`.
O resultado demonstra preferência nesse cenário, não ordem absoluta ou limites
individuais; as peças compartilhadas e a união de intervalos exigem mais estudo.

Em 27/10/2026, `node scripts/qa/bandwidth-transfer.mjs` transferiu dois torrents
privados simultâneos pelo mesmo cliente, com teto global de 128 KiB/s. Os 512 KiB
foram verificados em 4.019 ms. Passar `downloadLimit: 2048` na adição de um torrent
não aplicou esse limite: só aquele torrent exigiria 128 segundos nessa velocidade.
Essa propriedade não consta em `TorrentOptions`; o teste não exclui alternativas
que exijam alterações internas ou uma engine diferente. O relatório está em
`.build-resources/qa/bandwidth-ukUgm3/bandwidth-report.json`. Duas execuções passaram;
uma amostra curta não estabelece precisão de limite em redes reais.

Os ensaios de banda e de metadados também registraram escuta TCP em `::` e saída
em `127.0.0.1` para os peers locais. No caso de metadados foi usado um cliente
injetado com descoberta desabilitada; no caso de banda, um cliente downloader
WebTorrent diretamente. O relatório da preparação está em
`.build-resources/qa/metadata-K1HrmN/metadata-report.json`. A escuta curinga e a
saída selecionada pelo sistema são evidências TCP limitadas: não demonstram o
comportamento de trackers, DHT, PEX, uTP, DNS ou fontes HTTP, nem o isolamento de VPN.

**Decisão para os marcos seguintes:** prioridade exige tratar intervalos sobrepostos
e adjacentes; limites individuais exigem uma solução adicional que também respeite o
teto global; e a seleção de interface exige investigação estrutural de cada caminho
de rede, inclusive a preparação temporária. Não apresentar isolamento de interface
na UI até que esses caminhos sejam controlados e testados. O item TECH-01 permanece
aberto para comprovar a solução e o tráfego de todos os transportes.
