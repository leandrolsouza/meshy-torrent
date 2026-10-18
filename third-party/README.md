# Avisos de terceiros

`npm run release:notices` gera `.build-resources/THIRD_PARTY_NOTICES.txt` sem rede,
a partir da árvore de produção instalada pelo npm. Os comandos `pack`, `dist`,
`dist:win` e `dist:win:signed` executam essa etapa antes de empacotar. O arquivo é
instalado em `resources/THIRD_PARTY_NOTICES.txt`, ao lado de `app.asar`.

O gerador preserva os arquivos LICENSE, COPYING, NOTICE e COPYRIGHT das dependências,
incluindo nomes como `license-mit`. Para pacotes que publicam os termos completos
no README, preserva esse documento. Quando o pacote somente declara uma licença,
`npm-fallbacks.json` registra versão exata, declaração original e texto padrão
correspondente, mantendo autoria e README originais. Nova versão ou licença
sem aviso correspondente exige revisão e interrompe a geração.

`compact2string@1.4.1` usa `BSD` no manifesto antigo, mas seu README declara
explicitamente MIT. O complemento registra essa divergência e preserva ambas as
declarações, acrescentando as condições MIT indicadas pelo README.

Os textos em `licenses/` são originais obtidos das fontes oficiais registradas em
`sources.json`, com hash SHA-256 de texto normalizado para LF. Não os reformate.
As revisões de libjuice, libsrtp, usrsctp, plog e nlohmann-json correspondem aos
submódulos de libdatachannel 0.24.2, selecionado pelo CMake de node-datachannel 0.32.3.
O código-fonte MPL desses componentes é indicado no aviso distribuído, em linha
com a [orientação de distribuição da Mozilla](https://www.mozilla.org/en-US/MPL/2.0/FAQ/).

A interface usa somente `react-icons/vsc`. Seus componentes são incorporados ao
bundle pelo Vite; o diretório de fontes do pacote react-icons fica excluído do
ASAR para não distribuir coleções não utilizadas. O aviso mantém a atribuição
Microsoft/Codicons, a indicação da conversão para React e a licença CC BY 4.0.

O hook `scripts/verify-distribution.cjs` confere os avisos do aplicativo e do runtime,
a exclusão das fontes de ícones e a versão OpenSSL 3.6.2 do prebuild Windows x64.
Electron e Chromium mantêm seus avisos originais no diretório do aplicativo.

Ao atualizar dependências ou ícones, revise estes complementos e os componentes
nativos antes de gerar uma nova distribuição. A lista inclui dependências npm
de produção mesmo quando o empacotador elimina parte delas por plataforma.
