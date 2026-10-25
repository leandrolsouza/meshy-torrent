# Destinos de rede fornecidos por torrents

A política se aplica a trackers HTTP(S)/UDP, fontes de metadados (`xs`) e web seeds
recebidos por magnets, arquivos `.torrent`, configurações e sessão restaurada.
Endereços privados, loopback, link-local, multicast, reservados e nomes locais
conhecidos são rejeitados. Credenciais na autoridade da URL também são rejeitadas;
passkeys em path/query continuam aceitas. URLs rejeitadas nos metadados são filtradas
antes de iniciar a descoberta ou criar a conexão.

A proteção de credenciais em logs, arquivos locais e migração de perfis antigos é
descrita em [LOCAL_DATA_SECURITY.md](LOCAL_DATA_SECURITY.md).

## Validação e conexão

- `shared/validators.ts` usa `ipaddr.js` para classificar IPv4/IPv6, incluindo IPv4
  mapeado em IPv6. O parser WHATWG também canonicaliza IPv4 abreviado, decimal e
  hexadecimal em URLs UDP, como já faz a biblioteca de trackers.
- `main/torrentNetworkPolicy.ts` consulta todos os endereços retornados pelo
  resolvedor do sistema. Respostas vazias, erros e conjuntos que contenham qualquer
  endereço não público falham. A checagem acontece em cada resolução de conexão,
  sem cache de autorização por hostname.
- `main/torrentHttpTransport.ts` fornece agents HTTP/HTTPS com esse lookup. O socket
  recebe o próprio endereço validado, mantendo hostname/Host e verificação TLS do
  destino original. O transporte não aceita agents, dispatchers ou overrides de
  hostname da biblioteca. Redirecionamentos são manuais: cada destino passa pela
  mesma política, com até cinco saltos, sem downgrade HTTPS para HTTP. Cabeçalhos de
  autenticação/cookies são removidos entre origens. Sinais de cancelamento são
  preservados e cada resposta tem limite de 8 MiB.
- `main/torrentUdpTransport.ts` resolve e valida o hostname antes de cada datagrama
  do tracker e envia ao IP literal validado. Encerrar o socket cancela logicamente
  envios com DNS pendente, inclusive antes do primeiro bind.

Essas decisões seguem a orientação de
[prevenção de SSRF da OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).
A política não altera o fetch global, o atualizador ou as conexões BitTorrent de
peers, DHT e descoberta local. Essas conexões têm semântica própria e continuam
sujeitas às configurações da engine e à proteção de rede do sistema operacional.

## Integração e manutenção

`electron.vite.config.ts` inclui WebTorrent, torrent-discovery e bittorrent-tracker
no bundle do main para substituir seus imports de `cross-fetch-ponyfill` pelo
transporte HTTP protegido e, exclusivamente no cliente de tracker UDP, `dgram`
pelo adaptador UDP. As demais dependências e módulos nativos permanecem externos.
O teste de build verifica que os quatro consumidores e os dois adaptadores entram
no bundle e executa o preload com os recursos disponíveis no sandbox.

Ao atualizar essas bibliotecas, revise os pontos de import e todos os novos
transportes de saída. Chamadas diretas às bibliotecas fora desse build não recebem
automaticamente os adaptadores. `ipaddr.js` 2.5.0 e `node-fetch` 3.3.2 foram
declarados diretamente, reutilizando as versões já resolvidas na árvore de
produção. A avaliação do aviso do pacote `ip` permanece separada em
[SECURITY_REVIEW.md](SECURITY_REVIEW.md); sua exceção não autoriza destinos de rede.

## Verificação

```sh
npm test -- --runInBand --runTestsByPath tests/unit/networkAddressValidation.test.ts tests/unit/torrentNetworkPolicy.test.ts tests/unit/torrentHttpTransport.test.ts tests/unit/torrentUdpTransport.test.ts tests/unit/torrentNetworkSecurity.test.ts tests/unit/networkLifecycle.test.ts tests/integration/electron-build.test.ts
npm run typecheck
npm run lint
npm run build
npm run qa:transfer
```

Os testes Jest usam DNS, HTTP e sockets simulados; verificam destinos privados,
respostas A/AAAA mistas, rebinding, redirecionamentos, pinagem do IP, cancelamento e
integração do build sem acessar trackers externos. `qa:transfer` é a homologação
TCP local real da engine, com conteúdo próprio e rede pública desativada. Não
substitui testes de instalação desktop ou de swarm público.
