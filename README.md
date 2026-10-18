# Meshy

Cliente BitTorrent desktop multiplataforma construído com Electron, React e WebTorrent.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-0.1.0--beta.1-orange.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)

---

## 1. Descrição

Meshy é um cliente BitTorrent desktop com interface moderna inspirada no VS Code — tema escuro, navegação por Activity Bar e layout otimizado para teclado. Roda em **Windows**, **macOS** e **Linux** via Electron, usando WebTorrent como engine de download e React para a UI.

### Funcionalidades

- Adicionar torrents via arquivo `.torrent`, magnet link ou arrastar e soltar
- Pausar, retomar e remover downloads
- Seleção individual de arquivos dentro de um torrent
- Revisão antes de iniciar: arquivos, tamanho selecionado e pasta por download
- Verificação de espaço livre considerando downloads ativos e enfileirados no mesmo volume
- Pausa por falta de espaço, preservando dados e seleção para retomada manual
- Localizar, mover e verificar arquivos existentes, com retomada apenas do conteúdo pendente
- Abrir magnets e arquivos `.torrent` pelo sistema, sempre passando pela revisão
- Opção para continuar baixando na bandeja, com controles para pausar, retomar e encerrar
- Modo de conexão leve com botão rápido, limites próprios e horários por dia da semana
- Seleção e ações em lote, importação múltipla com revisão e resultados individuais
- Explicações e ações para fila, ausência de peers, trackers com erro e pasta indisponível
- Limites configuráveis de velocidade de download e upload e máximo de downloads simultâneos
- Progresso, velocidade e contagem de peers em tempo real (atualização a cada segundo)
- Persistência de sessão — downloads são restaurados ao reabrir o app
- Gerenciamento de trackers por torrent e favoritos globais
- Notificações nativas do sistema operacional ao concluir um download
- Temas customizáveis com aplicação dinâmica via variáveis CSS
- Internacionalização: `pt-BR` e `en-US`
- Atualizações pelo GitHub Releases no Windows x64, em distribuições assinadas,
  com download automático e reinício confirmado pelo usuário
- Configurações avançadas de rede: DHT, PEX, uTP

Ao adicionar um torrent, o Meshy primeiro obtém apenas seus metadados. Escolha os arquivos e a
pasta de destino na revisão e confirme em **Iniciar download**. Para várias entradas, cada torrent
tem sua própria confirmação. A seleção e a pasta são preservadas ao reabrir o aplicativo.

A proteção de disco mantém uma margem de 64 MiB e verifica o espaço antes de iniciar ou retomar,
inclusive ao sair da fila. Durante a transferência, há uma nova verificação a cada cinco segundos;
um erro `ENOSPC` também provoca a pausa. Libere espaço ou reduza a seleção antes de retomar.

Use **Arquivos…** no torrent para verificar integridade, localizar uma pasta reorganizada ou
mover os dados para outro disco. A operação pausa o torrent; ao terminar, retome para baixar o
conteúdo pendente. Para localizar `Pacote/arquivo.bin`, escolha a pasta que contém `Pacote`.
Movimentos não sobrescrevem arquivos no destino. Os originais só são removidos após a cópia,
verificação e persistência do novo destino; arquivos compartilhados com outros torrents são mantidos.
O catálogo de arquivos também é preservado para abrir downloads concluídos após reiniciar.

Em **Configurações → Geral**, habilite **Continuar baixando ao fechar a janela** para usar a
bandeja. A opção começa desativada. O menu da bandeja oferece mostrar a janela, pausar todos,
retomar pausados e encerrar o aplicativo. **Abrir magnets com o Meshy** solicita o registro do
protocolo; o sistema pode pedir confirmação para escolher o aplicativo padrão.

Magnets e `.torrent` abertos pelo sistema entram na mesma revisão, inclusive quando chegam
durante a inicialização ou enquanto outro torrent está sendo revisado. As associações de arquivos
são declaradas no instalador; execute o aplicativo instalado e escolha Meshy em **Abrir com** ou
nas configurações de aplicativos padrão. O funcionamento em desenvolvimento varia por sistema.
Veja a [documentação de integração do Electron](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app).

Use **Modo leve**, na barra superior, para reduzir temporariamente download e upload. Em
**Configurações → Transferências**, escolha os limites e, opcionalmente, dias e horários.
O modo leve nunca aumenta um limite normal menor. Ao desativar o modo manual, o horário
configurado continua valendo; fora do intervalo, os limites normais voltam. Os horários usam
o fuso local do computador e são conferidos a cada dez segundos, inclusive na bandeja.
Para `22:00 → 06:00`, marque o dia em que o intervalo começa. O aplicativo precisa estar aberto.

Em **Selecionar torrents**, marque os downloads e use **Selecionar visíveis**, **Pausar**,
**Retomar** ou **Remover selecionados**. Somente os selecionados visíveis no filtro atual e
compatíveis com a ação participam. Há um limite de 200 torrents por operação; recuperação de
arquivos impede ações concorrentes. A remoção exige escolher entre manter ou excluir arquivos,
e cada torrent recebe um resultado. Falhas não impedem os demais de serem processados.

O seletor de `.torrent` aceita vários arquivos, assim como arrastar e soltar e magnets em linhas
separadas. Cada entrada passa pela sua própria confirmação. Use **Pular este torrent** para
continuar após um problema; o resumo mostra adições, entradas puladas e falhas. Arquivos
arrastados têm um limite total de 64 MiB de metadados por lote.

Explicações na lista usam observações do main: pasta sem acesso, fila, metadados, seleção vazia,
ausência de peers e trackers com erro. Com peers conectados, 30 segundos sem avanço exibem
uma orientação para conferir conexões. Ausência de peers não comprova ausência de seeders;
as explicações oferecem ações pertinentes sem alterar o torrent automaticamente.

### Stack

| Camada       | Tecnologia                                                          |
| ------------ | ------------------------------------------------------------------- |
| Framework    | [Electron](https://www.electronjs.org/) 44                          |
| Build        | [electron-vite](https://electron-vite.org/) 5 + Vite 7              |
| UI           | [React](https://react.dev/) 19                                      |
| Estado       | [Zustand](https://zustand-demo.pmnd.rs/) 5                          |
| Torrent      | [WebTorrent](https://webtorrent.io/) 3                              |
| Persistência | [electron-store](https://github.com/sindresorhus/electron-store) 11 |
| i18n         | [react-intl](https://formatjs.github.io/docs/react-intl/) 12        |
| Linguagem    | TypeScript 7 (strict mode), API compatível 6 para Jest/ESLint       |
| Logging      | [electron-log](https://github.com/megahertz/electron-log) 5         |
| Testes       | Jest 30 + ts-jest + @testing-library/react 16                       |
| PBT          | [fast-check](https://fast-check.dev/) 4                             |
| Linting      | ESLint 10 + typescript-eslint 8                                     |
| Formatação   | Prettier 3                                                          |

**Pré-requisito:** Node.js >= 22.13

---

## 2. Arquitetura

Meshy segue o modelo de processos do Electron com isolamento estrito: o renderer nunca acessa Node.js diretamente.

```mermaid
graph LR
    R[Renderer Process<br/>React + Zustand] -- ipcRenderer.invoke --> P[Preload<br/>contextBridge]
    P -- ipcMain.handle --> M[Main Process<br/>Electron + WebTorrent]
    M -- webContents.send<br/>torrent:progress 1s --> R
```

- **Renderer** → chama `window.meshy.*` (API exposta pelo preload) via `ipcRenderer.invoke` para todas as operações
- **Preload** → ponte segura: expõe wrappers tipados sobre `ipcRenderer.invoke` via `contextBridge`
- **Main** → processa handlers `ipcMain.handle`, executa operações no WebTorrent e envia snapshots de progresso a cada segundo via `webContents.send('torrent:progress', items)`

Todos os handlers IPC retornam `IPCResponse<T>` — `{ success: true, data: T }` ou `{ success: false, error: string }`. Os tipos cruzados entre processos vivem exclusivamente em `shared/types.ts`.

---

## 3. Instalação e Desenvolvimento

**Pré-requisito:** Node.js >= 22.13

```bash
git clone <repository-url>
cd meshy
npm install
npm run dev
```

`npm run dev` inicia o Electron com hot reload via electron-vite. Alterações no renderer (React) são refletidas instantaneamente; alterações no processo principal reiniciam o Electron automaticamente.

### Outros comandos úteis

| Comando                 | Descrição                                 |
| ----------------------- | ----------------------------------------- |
| `npm test`              | Roda todos os testes com Jest             |
| `npm run test:watch`    | Testes em modo watch                      |
| `npm run test:coverage` | Relatório de cobertura de testes          |
| `npm run typecheck`     | Type-check completo (`tsc --noEmit`)      |
| `npm run lint`          | ESLint                                    |
| `npm run lint:fix`      | ESLint com auto-fix                       |
| `npm run format`        | Prettier --write                          |
| `npm run format:check`  | Prettier --check (sem modificar arquivos) |

---

## 4. Build de Produção

```bash
npm run build
```

Os artefatos são gerados em `out/`:

| Arquivo              | Descrição                    |
| -------------------- | ---------------------------- |
| `out/main/index.mjs` | Processo principal (Node.js) |
| `out/preload/`       | Script de preload            |
| `out/renderer/`      | Interface React (HTML + JS)  |

Para executar o build gerado:

```bash
npm start
```

Para empacotar sem instalador, use `npm run pack`. Para gerar o instalador da plataforma atual,
use `npm run dist`. Ambos compilam as fontes, preparam o ícone e geram artefatos em `dist/`,
sem publicar releases. A configuração fica em `electron-builder.json`: NSIS no Windows,
DMG no macOS e DEB/AppImage no Linux, com protocolo `magnet` e associação `.torrent`.
Builds de distribuição recompilam dependências nativas e podem precisar de rede e ferramentas
da plataforma. Cada instalador deve ser validado no sistema correspondente antes de publicar.

O primeiro candidato é **0.1.0-beta.1 para Windows x64**. Use `npm run dist:win`
para gerar o instalador NSIS e `dist/SHA256SUMS`. A publicação depende da
[homologação do release](docs/RELEASE.md); veja as
[notas do beta](docs/releases/0.1.0-beta.1.md). O atualizador já está integrado, mas
o candidato sem certificado mantém a instalação manual. Para ativar as atualizações
automáticas na distribuição, veja [assinatura e publicação](docs/AUTO_UPDATES.md).

Use `npm run qa:release` para compilar e executar a homologação com transferência TCP
local real, recuperação de sessão e capturas do renderer em temas e idiomas distintos.
`npm run qa:transfer` executa somente a transferência. Os dados ficam isolados em
`.build-resources/qa/`; veja o [escopo e as limitações](docs/QA_RELEASE.md).

---

## 5. Estrutura do Projeto

```
meshy/
├── main/
├── electron/
├── shared/
├── src/
├── tests/
└── docs/
```

| Pasta       | Responsabilidade                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `main/`     | Processo principal Electron: engine WebTorrent, fila de downloads, persistência, handlers IPC, logs e métricas |
| `electron/` | Script de preload — expõe a API `window.meshy` ao renderer via `contextBridge` com isolamento de contexto      |
| `shared/`   | Código compartilhado entre main e renderer: tipos (`types.ts`), validações, formatadores e códigos de erro     |
| `src/`      | Processo renderer React: componentes, hooks, stores Zustand, temas, i18n e estilos                             |
| `tests/`    | Testes Jest: unitários (`tests/unit/`) e de integração (`tests/integration/`)                                  |
| `docs/`     | Documentação do projeto e roteiros de manutenção                                                               |

### Configuração TypeScript

O projeto usa referências compostas com quatro configs:

- `tsconfig.node.json` — main + preload + shared (target ES2022)
- `tsconfig.web.json` — renderer + shared (target ES2020, JSX react-jsx)
- `tsconfig.jest.json` — testes (NodeNext, saída CommonJS, módulos isolados)
- `tsconfig.json` — raiz com referências; `npm run typecheck` verifica os três projetos explicitamente

`npx tsc` executa o TypeScript 7 nativo. O alias `typescript` fornece a API do
TypeScript 6 para `ts-jest` e `typescript-eslint`; `npx tsc6` executa esse compilador
compatível. Veja as [decisões da atualização de dependências](docs/DEPENDENCY_UPDATES.md).

---

## 6. Como Contribuir

Antes de abrir um PR, execute as três verificações obrigatórias e certifique-se de que todas passam sem erros:

```bash
npm run lint
npm run format:check
npm test -- --runInBand
```

- **`npm run lint`** — zero erros de ESLint
- **`npm run format:check`** — código formatado conforme `.prettierrc`
- **`npm test -- --runInBand`** — todos os testes passando

Para type-check explícito dos três projetos:

```bash
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
npx tsc --noEmit -p tsconfig.jest.json
```

Convenções de código: quatro espaços, aspas simples, ponto e vírgula, trailing commas e largura de 100 caracteres (`.prettierrc`). Nomes de símbolos e APIs seguem o padrão existente — evite refatorações amplas em PRs pontuais.

---

## Licença

[MIT](LICENSE)
