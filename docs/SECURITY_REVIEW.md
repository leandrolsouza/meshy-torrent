# Avaliação de aplicabilidade de dependências — beta Windows

Avaliação técnica de 18/10/2026 para a cadeia resolvida no `package-lock.json`.
O relatório bruto de produção continua com **quatro entradas altas e nenhum
alerta crítico**. São quatro entradas propagadas do mesmo aviso, não quatro falhas
independentes. A vulnerabilidade não foi corrigida nem removida da dependência.

## Aviso e versões

O [GHSA-2p57-rm9w-gvfp / CVE-2024-29415](https://github.com/advisories/GHSA-2p57-rm9w-gvfp)
descreve classificação incorreta de alguns endereços em `ip.isPublic`, que pode
permitir SSRF quando essa classificação é usada para autorizar destinos de rede.
Na consulta de 18/10/2026, o aviso cobre `ip <= 2.0.1` e não indica versão corrigida.

| Pacote               | Versão resolvida | Origem da entrada no npm audit |
| -------------------- | ---------------- | ------------------------------ |
| `webtorrent`         | 3.0.21           | `torrent-discovery`            |
| `torrent-discovery`  | 11.0.21          | `bittorrent-tracker`           |
| `bittorrent-tracker` | 11.2.3           | `ip`                           |
| `ip`                 | 2.0.1            | GHSA-2p57-rm9w-gvfp            |

`npm view` confirmou que as versões publicadas de WebTorrent, bittorrent-tracker e
ip ainda são as usadas pelo projeto. O downgrade para WebTorrent 0.7.3 sugerido pelo
npm não foi aplicado: substituiria a engine por uma versão antiga e incompatível.

## Caminhos revisados e conclusão

- `main/torrentEngine.ts` e `main/torrentPreparation.ts` criam clientes WebTorrent.
  O aplicativo não importa `ip` diretamente nem inicia um servidor de tracker.
- `torrent-discovery/index.js` importa `Client` de `bittorrent-tracker` e usa esse
  cliente para descoberta de peers.
- `bittorrent-tracker/index.js` também importa e exporta `Server`. Por isso, o módulo
  de servidor e `ip` podem ser carregados e entram no pacote, mesmo usando o cliente.
- A busca em WebTorrent, torrent-discovery e bittorrent-tracker identificou somente
  o import de `ip` em `bittorrent-tracker/lib/server/parse-udp.js`. Ele chama
  `ipLib.toString`; não chama `isPublic`, `isPrivate` ou `address`.
- A implementação de `ip.toString` converte uma representação de endereço em texto;
  não chama o classificador `isPublic` afetado pelo aviso.

**Conclusão técnica:** não foi identificado uso da função afetada nos caminhos
revisados do cliente Meshy Torrent. A exceção temporária se limita à aplicabilidade deste
aviso nesta cadeia e nestas fontes. Não equivale a declarar as bibliotecas livres
de vulnerabilidades nem a avaliar todos os possíveis destinos de rede do cliente.

## Verificação reproduzível e prazo

```sh
npm ls ip bittorrent-tracker torrent-discovery webtorrent
npm audit --omit=dev --json
npm run security:audit
```

`npm audit` continua retornando código de falha pelos quatro alertas. O comando
`security:audit` consulta o mesmo relatório e o preserva integralmente em
`.build-resources/security/audit-production.json`. A política versionada em
[`security/audit-policy.json`](../security/audit-policy.json) permite somente:

- o aviso exato e suas quatro entradas, com a mesma cadeia e severidade;
- as versões exatas do lockfile e das dependências instaladas;
- os nove arquivos revisados de `ip`, tracker e discovery, fixados por SHA-256
  de texto UTF-8 com CRLF normalizado para LF;
- ausência de imports diretos de `ip` nas fontes do aplicativo;
- uso da exceção **antes de 17/11/2026, às 00:00 UTC**.

Outro aviso alto/crítico, nova causa em pacote conhecido, cópia adicional de `ip`
reportada pelo npm, mudança nas evidências, erro de consulta ou vencimento falham a
verificação. Um relatório sem alertas altos/críticos passa sem usar a exceção.
O script não altera dependências, o banco de avisos ou o relatório bruto.

O workflow executa a verificação e guarda o relatório como artefato por 14 dias.
Os testes em `tests/integration/audit-production.test.ts` exercitam aceitação
restrita, expiração e rejeição de alterações sem acessar a rede ou iniciar Electron.

Ao atualizar essas dependências ou introduzir outro consumidor de `ip`, refaça a
análise antes de alterar a política. Se surgir correção oficial compatível, prefira
atualizar a dependência e remover a exceção. O prazo exige reavaliação mesmo que
nenhuma dependência tenha mudado.

## Limites da liberação

Esta avaliação trata somente o aviso acima. A instalação em máquina limpa,
homologação de integrações do Windows, avisos de licenças e revisão dos demais
fluxos de segurança continuam no [roteiro de release](RELEASE.md). A distribuição
permanece sem assinatura e com atualização manual por decisão do projeto.
