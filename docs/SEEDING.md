# Seeding de torrents completos

O Meshy Torrent mantém torrents concluídos na rede para enviar dados a outros peers.
Na aba **Rede** das Configurações, **Ativar seeding** vem habilitado e o limite
padrão é de **2 seeders simultâneos**, configurável entre **1 e 20**.
O limite de upload global também se aplica ao seeding.

- `seeding`: participa da rede e exibe a velocidade de upload.
- `completed`: terminou o download e aguarda um slot, ou está com seed desativado.
- **Parar seed** desativa o seed daquele torrent e persiste a preferência.
  **Retomar seed** devolve sua elegibilidade, respeitando a configuração global.
- A fila segue `completedAt`, do mais antigo ao mais recente. Pausar ou remover
  um seeder libera seu slot; reduzir o limite suspende os últimos iniciados.
- Reiniciar o aplicativo ou alterar opções de rede reaplica os slots. Seeders
  não consomem slots de download. A conclusão dos arquivos selecionados também
  participa desse fluxo, sem selecionar automaticamente os demais arquivos.

Os contratos ficam em [shared/types.ts](../shared/types.ts), a decisão de slots
em [main/downloadManager.ts](../main/downloadManager.ts), e a adaptação de rede
em [main/torrentEngine.ts](../main/torrentEngine.ts) e
[main/webtorrentInternals.ts](../main/webtorrentInternals.ts).
O comando IPC `torrent:toggle-seed` valida o hash e retorna o item atualizado.
Sessões antigas recebem os defaults; `seedingDisabled` ausente significa elegível.

## Verificação

```sh
npm run typecheck
npm test -- --runInBand
npm run lint
npm run build
npm run qa:transfer
```

Os testes de serviços cobrem fila, slots, persistência, configurações, eventos
atrasados e falhas de rede. Os testes de interface cobrem ações e controles nos
dois idiomas. A homologação `qa:transfer` usa dados aleatórios e peers TCP em
`127.0.0.1`: verifica download, pausa/retomada, restauração, seed automático,
stop/resume e envio para outro cliente com SHA-256 idêntico. Evidências ficam
em `.build-resources/qa/`. Isso não substitui instalação em máquina limpa nem
valida um swarm público.
