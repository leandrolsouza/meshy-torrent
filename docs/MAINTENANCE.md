# 🛠️ Meshy Torrent — Guia de Manutenção

> Documento de referência para tarefas de manutenção do projeto.  
> Cada item contém contexto, objetivo e um prompt pronto para executar com a IA.

---

## Índice

1. [Auditoria de Dependências](#1-auditoria-de-dependências)
2. [Atualização da Stack](#2-atualização-da-stack)
3. [Cobertura de Testes](#3-cobertura-de-testes)
4. [Revisão de Segurança do IPC](#4-revisão-de-segurança-do-ipc)
5. [Detecção de Código Morto](#5-detecção-de-código-morto)
6. [Revisão de Tratamento de Erros](#6-revisão-de-tratamento-de-erros)
7. [Performance do Renderer](#7-performance-do-renderer)
8. [Revisão de Acessibilidade](#8-revisão-de-acessibilidade)
9. [Atualizar o README](#9-atualizar-o-readme)
10. [Revisão de Logs e Métricas](#10-revisão-de-logs-e-métricas)
11. [Rigor TypeScript](#11-rigor-typescript)

---

## 1. Auditoria de Dependências

**Por quê:** Dependências desatualizadas acumulam vulnerabilidades de segurança e dívida técnica. O projeto usa WebTorrent, Electron e React — ecossistemas que evoluem rapidamente.

**Arquivos relevantes:** `package.json`, `package-lock.json`

**Prompt:**

```
Você é um engenheiro sênior. No projeto Meshy Torrent em `e:\Desenvolvimento\GiHub\meshy-torrent`,
audite o `package.json` e o `package-lock.json`. Identifique:
(1) dependências com versões desatualizadas relevantes,
(2) vulnerabilidades conhecidas,
(3) dependências que podem ser removidas por não serem mais usadas.

Execute `npm audit` e `npm outdated`. Para cada item, informe o risco e se a
atualização é segura ou pode gerar breaking changes. Produza um relatório em
`.agents/tasks/dependency-audit.md`.
```

---

---

## 2. Atualização da Stack

**Por quê:** O Meshy Torrent é construído sobre peças que evoluem de forma acoplada — Electron, Node.js embutido, Chromium, Vite, electron-vite e TypeScript. Atualizar só os pacotes npm sem considerar essa cadeia pode introduzir incompatibilidades silenciosas. Por outro lado, ficar muito atrás dessas versões significa perder correções de segurança críticas (especialmente no Chromium e no Node.js do Electron) e APIs modernas.

**Stack atual (referência):**

| Peça | Versão atual |
|------|-------------|
| Electron | `^41.x` |
| Node.js (embutido no Electron) | depende da release do Electron |
| Chromium (embutido no Electron) | depende da release do Electron |
| Vite | `^7.x` |
| electron-vite | `^5.x` |
| TypeScript | `~5.9.x` |
| React | `19.x` |
| WebTorrent | `^2.x` |

**Arquivos relevantes:** `package.json`, `electron.vite.config.ts`, `tsconfig*.json`

**Ferramentas utilizadas:** [`npm-check-updates`](https://www.npmjs.com/package/npm-check-updates) — verifica todas as dependências contra o registro npm e atualiza o `package.json` de forma controlada, sem instalar nada até você decidir.

Comandos de referência:
```bash
npx npm-check-updates              # lista tudo que está desatualizado
npx npm-check-updates <pacote>     # verifica um pacote específico
npx npm-check-updates -u <pacote>  # atualiza a versão no package.json (sem instalar)
npx npm-check-updates --target minor  # somente minor/patch (ignora major)
```

**Prompt:**

```
Você é um engenheiro sênior especialista em Electron. Execute uma atualização
completa da stack do projeto Meshy Torrent em `e:\Desenvolvimento\GiHub\meshy-torrent`.

**0. Levantamento com npm-check-updates**
- Execute `npx npm-check-updates` para obter a lista completa de pacotes
  desatualizados. Use esse relatório como ponto de partida para as etapas abaixo.
- Não execute `-u` em massa ainda — cada grupo será atualizado e verificado
  individualmente.

**1. Electron (atualizar primeiro — puxa Node.js e Chromium)**
- Verifique a versão mais recente com `npx npm-check-updates electron`.
- Consulte https://releases.electronjs.org/ e confirme as versões de Node.js e
  Chromium embutidas na nova release.
- Verifique se há breaking changes que afetem `main/`, `electron/preload.ts` ou
  configurações de segurança (contextIsolation, sandbox, CSP).
- Aplique com `npx npm-check-updates -u electron`, ajuste `allowScripts` se
  necessário e execute `npm install`.

**2. electron-vite e Vite (acoplados ao Electron)**
- Verifique compatibilidade entre a nova versão do electron-vite e o Electron
  escolhido no passo anterior.
- Aplique `npx npm-check-updates -u electron-vite vite` e execute `npm install`.
- Confirme que `electron.vite.config.ts` não precisa de ajustes de API.
- Execute `npm run build` para validar.

**3. TypeScript**
- Aplique `npx npm-check-updates -u typescript` e execute `npm install`.
- Execute `npx tsc --noEmit -p tsconfig.node.json`, `tsconfig.web.json` e
  `tsconfig.jest.json` separadamente (o script `typecheck` raiz não garante
  cobertura completa dos três projetos).
- Corrija qualquer erro de tipo introduzido pelo novo compilador.

**4. WebTorrent**
- Verifique o changelog de `webtorrent` entre a versão atual e a mais recente.
- Se houver breaking changes de API, atualize os usos em `main/torrentEngine.ts`
  e `main/webtorrentInternals.ts` antes de instalar.
- Aplique `npx npm-check-updates -u webtorrent` e execute `npm install`.

**5. Demais dependências**
- Use `npx npm-check-updates --target minor` para identificar atualizações
  minor/patch de baixo risco em runtime e devDependencies.
- Aplique e instale grupo a grupo (runtime, devDependencies, @types).
- Para upgrades major restantes, avalie o changelog individualmente antes de
  aplicar.
- Após cada grupo, execute `npm run build` e os três `tsc --noEmit`.

**Verificação final:**
- `npx tsc --noEmit -p tsconfig.node.json` — zero erros
- `npx tsc --noEmit -p tsconfig.web.json` — zero erros
- `npx tsc --noEmit -p tsconfig.jest.json` — zero erros
- `npm run lint` — zero warnings novos
- `npm test -- --runInBand` — todos os testes passando
- `npm run build` — build de produção bem-sucedido

Documente em `.agents/tasks/stack-update.md`:
- O que foi atualizado (de → para)
- O que foi mantido fixo intencionalmente e o motivo
- Breaking changes encontrados e como foram tratados
```

---

## 3. Cobertura de Testes

**Por quê:** Jest está configurado (`jest.config.js`) mas não há garantia de que os módulos críticos estão cobertos. Fluxos como adicionar torrent, gerenciar fila e tratar erros precisam de testes confiáveis.

**Arquivos relevantes:** `jest.config.js`, `main/torrentEngine.ts`, `main/ipcHandler.ts`, `shared/validators.ts`

**Prompt:**

```
Você é um engenheiro de qualidade. No projeto Meshy Torrent em `e:\Desenvolvimento\GiHub\meshy-torrent`,
execute `npm run test:coverage` e analise o relatório. Identifique os módulos mais
críticos sem cobertura (priorize `main/torrentEngine.ts`, `main/ipcHandler.ts`,
`shared/validators.ts`).

Para cada lacuna encontrada, escreva os testes unitários faltantes usando
Jest + Testing Library. Todos os testes devem passar ao final.
```

---

## 4. Revisão de Segurança do IPC

**Por quê:** A fronteira IPC (Inter-Process Communication) é a principal superfície de ataque em aplicações Electron. Qualquer entrada não validada do renderer que chega ao main process pode ser explorada.

**Arquivos relevantes:** `main/ipcHandler.ts`, `main/payloadValidator.ts`, `main/validators.ts`, `electron/preload.ts`

**Prompt:**

```
Você é um especialista em segurança Electron. Analise os arquivos
`main/ipcHandler.ts`, `main/payloadValidator.ts`, `main/validators.ts` e
`electron/preload.ts` no projeto `e:\Desenvolvimento\GiHub\meshy-torrent`.

Verifique:
(1) se toda entrada vinda do renderer é validada antes de ser usada no main process,
(2) se há exposição desnecessária de APIs no preload,
(3) se `contextIsolation` e `nodeIntegration` estão corretamente configurados,
(4) se há riscos de path traversal nos argumentos de pasta/arquivo.

Corrija os problemas encontrados e documente as alterações.
```

---

## 5. Detecção de Código Morto

**Por quê:** Componentes, tipos e funções não utilizados aumentam o bundle size, confundem novos colaboradores e dificultam refatorações.

**Arquivos relevantes:** `src/components/`, `shared/`, arquivos `.gitkeep`

**Prompt:**

```
Você é um engenheiro de manutenção. No projeto Meshy Torrent em `e:\Desenvolvimento\GiHub\meshy-torrent`,
encontre:
(1) componentes React importados mas nunca renderizados,
(2) funções exportadas em `shared/` que nenhum arquivo importa,
(3) tipos TypeScript definidos mas nunca referenciados,
(4) arquivos `.gitkeep` que podem ser removidos.

Use grep e análise estática. Remova o que for seguro remover e liste o que
precisaria de revisão manual.
```

---

## 6. Revisão de Tratamento de Erros

**Por quê:** Erros silenciosos (`catch` vazios ou com apenas `console.log`) são difíceis de diagnosticar em produção. O app usa `electron-log` e um `ErrorBoundary`, mas a consistência de uso precisa ser verificada.

**Arquivos relevantes:** `main/`, `src/components/common/ErrorBoundary.tsx`, `shared/errorCodes.ts`

**Prompt:**

```
Você é um engenheiro sênior. Revise o tratamento de erros em todo o projeto
Meshy Torrent (`e:\Desenvolvimento\GiHub\meshy-torrent`). Verifique:
(1) todos os `catch` que apenas fazem `console.log` sem propagar ou logar via `electron-log`,
(2) promises sem `.catch()` ou `await` sem `try/catch` no processo main,
(3) se o `ErrorBoundary` em `src/components/common/ErrorBoundary.tsx` está cobrindo
    a árvore de componentes adequadamente,
(4) se os `IPCResponse` de erro chegam ao renderer com mensagens úteis.

Corrija os casos encontrados.
```

---

## 7. Performance do Renderer

**Por quê:** O store Zustand emite atualizações de progresso frequentes (a cada segundo para cada torrent ativo). Re-renders desnecessários na lista de downloads degradam a fluidez da UI.

**Arquivos relevantes:** `src/components/DownloadList/`, `src/components/DownloadDetails/`

**Prompt:**

```
Você é um especialista em performance React. Analise os componentes em
`e:\Desenvolvimento\GiHub\meshy-torrent\src\components\DownloadList` e `DownloadDetails`.

O store Zustand emite atualizações frequentes via `onProgress`. Identifique:
(1) componentes que re-renderizam sem necessidade (selectors desnecessariamente
    amplos no Zustand),
(2) listas que renderizam todos os itens sem memoização,
(3) oportunidades para `React.memo`, `useMemo` e `useCallback`.

Aplique as otimizações e justifique cada uma.
```

---

## 8. Revisão de Acessibilidade

**Por quê:** Botões sem `aria-label`, modais sem armadilha de foco e barras de progresso sem atributos ARIA prejudicam usuários que dependem de leitores de tela e navegação por teclado.

**Arquivos relevantes:** `src/components/`, especialmente `AddTorrent/`, `common/ProgressBar.tsx`, `common/ConfirmDialog.tsx`

**Prompt:**

```
Você é um especialista em acessibilidade web. Revise os componentes React em
`e:\Desenvolvimento\GiHub\meshy-torrent\src\components`.

Verifique:
(1) se todos os botões têm `aria-label` quando não possuem texto visível,
(2) se modais (como `AddTorrentModal`) armadilham foco corretamente,
(3) se o `ProgressBar` comunica seu valor via `role="progressbar"` com
    `aria-valuenow`, `aria-valuemin` e `aria-valuemax`,
(4) se a navegação por teclado funciona em todos os controles interativos.

Aplique as correções necessárias conforme WCAG 2.1 AA.
```

---

## 9. Atualizar o README

**Por quê:** O README é a porta de entrada do projeto. Deve refletir o estado atual, facilitar onboarding e documentar como buildar e contribuir.

**Arquivos relevantes:** `README.md`, `package.json`, `main/index.ts`, `shared/types.ts`

**Prompt:**

```
Você é um engenheiro de documentação. Leia todo o projeto Meshy Torrent em
`e:\Desenvolvimento\GiHub\meshy-torrent` — especialmente `package.json`, `main/index.ts`,
`shared/types.ts` e os componentes principais.

Reescreva o `README.md` para incluir:
(1) descrição clara do projeto,
(2) diagrama de arquitetura (main process / renderer / IPC),
(3) instruções de instalação e execução (`npm install`, `npm run dev`),
(4) como buildar para produção,
(5) estrutura do projeto com descrição de cada pasta,
(6) como contribuir.

Mantenha em português.
```

---

## 10. Revisão de Logs e Métricas

**Por quê:** Logs mal calibrados (excesso de debug em produção, falta de logs em fluxos críticos) dificultam o diagnóstico de problemas reportados por usuários. Métricas não utilizadas são ruído.

**Arquivos relevantes:** `main/logger.ts`, `main/metrics.ts`, `main/torrentEngine.ts`

**Prompt:**

```
Você é um engenheiro de observabilidade. Analise `e:\Desenvolvimento\GiHub\meshy-torrent\main\logger.ts`
e `main\metrics.ts`.

Verifique:
(1) se os níveis de log (info/warn/error) estão sendo usados corretamente em todo
    o processo main,
(2) se há logs de debug que vazam informações sensíveis (ex: caminhos completos,
    magnetLinks) em produção,
(3) se as métricas coletadas em `metrics.ts` estão sendo usadas ou são letra morta.

Corrija inconsistências e adicione logs faltantes nos fluxos críticos (add torrent,
erro de download, mudança de estado).
```

---

## 11. Rigor TypeScript

**Por quê:** Flags de strictness como `noUncheckedIndexedAccess` e `exactOptionalPropertyTypes` capturam classes inteiras de bugs em tempo de compilação, antes de chegarem ao usuário.

**Arquivos relevantes:** `tsconfig.json` (e variantes `tsconfig.node.json`, `tsconfig.web.json`)

**Prompt:**

```
Você é um engenheiro sênior TypeScript. No projeto Meshy Torrent (`e:\Desenvolvimento\GiHub\meshy-torrent`),
revise os arquivos `tsconfig.json` disponíveis e habilite as flags de rigor que
ainda não estejam ativas:
- `strictNullChecks`
- `noUncheckedIndexedAccess`
- `noImplicitReturns`
- `exactOptionalPropertyTypes`

Corrija todos os erros de tipo que aparecerem após as mudanças. Execute
`npm run typecheck` ao final para confirmar zero erros. Justifique qualquer
tipo que precisar de cast explícito (`as`).
```

---

## Checklist de Execução

| # | Tarefa | Prioridade | Status |
|---|--------|-----------|--------|
| 1 | Auditoria de Dependências | 🔴 Alta | `[ ]` |
| 2 | Atualização da Stack | 🔴 Alta | `[ ]` |
| 3 | Cobertura de Testes | 🔴 Alta | `[ ]` |
| 4 | Revisão de Segurança do IPC | 🔴 Alta | `[ ]` |
| 5 | Detecção de Código Morto | 🟡 Média | `[ ]` |
| 6 | Revisão de Tratamento de Erros | 🔴 Alta | `[ ]` |
| 7 | Performance do Renderer | 🟡 Média | `[ ]` |
| 8 | Revisão de Acessibilidade | 🟡 Média | `[ ]` |
| 9 | Atualizar o README | 🟢 Baixa | `[ ]` |
| 10 | Revisão de Logs e Métricas | 🟡 Média | `[ ]` |
| 11 | Rigor TypeScript | 🟡 Média | `[ ]` |

---

*Documento gerado em outubro de 2026. Revise periodicamente conforme o projeto evolui.*
