# Credenciais em logs e persistência local

URLs de trackers podem conter passkeys no path ou na query. Também podem aparecer
em magnets e dentro de metadados `.torrent` codificados em base64. Por isso, a
proteção não depende de reconhecer o nome de um parâmetro de URL.

## Logs

`main/logger.ts` aplica `main/logRedaction.ts` antes de chamar electron-log, em
todos os níveis e no logger de escopo. URLs HTTP(S), UDP, WS(S) e magnets são
omitidos por inteiro, inclusive em representações percent-encoded ou escapadas.
Ao encontrar uma URL, a redação omite o restante daquele texto, preservando o
prefixo da mensagem: não pressupõe que espaços ou quebras de linha vindos de uma
biblioteca sejam delimitadores seguros para credenciais.
Mensagens, stacks, causas e objetos aninhados são tratados; campos como passkey,
token, senha, autorização, cookies e metadados base64 são omitidos. Objetos de erro
originais, buffers e accessors não são repassados ao destino do log.

O contexto base e o contexto de cada chamada do logger de escopo são sanitizados
antes de mesclar campos, inclusive quando o logger de destino é injetado. Campos
e objetos aninhados seguem estruturados para o destino, preservando a identificação
de campos secretos, como `token`, sem executar funções de formatação do contexto.

Erros preservam somente campos de diagnóstico: `type` (derivado de `Error.name`),
mensagem, stack, `code`, `errno`, `syscall`, causas e erros agregados. Esses campos
também passam pela redação. Accessors personalizados são omitidos. O accessor
nativo de stack do V8 é lido somente quando os campos `name` e `message` são
strings sem getters. Ciclos e profundidade excessiva recebem marcadores; valores
lançados sem ser Error são normalizados sem executar `toString` do objeto.
Veja o esquema dos eventos em [OBSERVABILITY.md](OBSERVABILITY.md).

Caminhos absolutos Windows, UNC e Unix e URIs `file:` são omitidos até o final da
linha, incluindo nomes de arquivos e caminhos com espaços. As linhas seguintes da
stack são tratadas separadamente, preservando frames internos sem caminho pessoal.
E-mails e endereços IPv4/IPv6 reconhecidos em texto também são omitidos. Campos
pessoais explícitos, como `name`, `username`, `userId`, `email`, `ip`, `peerId`,
`address`, `phone`, `cpf` e `cnpj`, são omitidos em objetos aninhados. Códigos de
erro, identificadores operacionais e durações continuam disponíveis.
O tratamento textual usa padrões reconhecíveis; não identifica nomes próprios ou
todo dado pessoal arbitrário em texto livre. Novos logs devem continuar evitando
dados pessoais e segredos na origem.

Essa redação se aplica às novas chamadas do logger do aplicativo. Não modifica logs
antigos, arquivos `.torrent` importados nem backups anteriores à correção. Se uma
passkey já foi exposta, revogue/substitua a credencial no serviço do tracker e
atualize as URLs globais e os torrents com os novos metadados. O aplicativo não
pode rotacionar uma passkey emitida pelo tracker automaticamente.

## Armazenamento protegido

`main/protectedStore.ts` é a factory usada pelos armazenamentos de produção
`settings.json` e `downloads.json`. Todo o documento é cifrado com o
[`safeStorage` do Electron](https://www.electronjs.org/docs/latest/api/safe-storage),
incluindo trackers globais, magnets, metadados base64 e mensagens de erro salvas na
sessão. Nenhuma chave fixa ou senha de criptografia é distribuída com o app.

O arquivo contém um envelope `meshy-protected-store`, versão 1, com ciphertext em
base64. Essa versão é independente de `schemaVersion` e `downloadsSchemaVersion`:
os contratos em memória e IPC continuam iguais. Base64 sozinho não é a proteção;
o conteúdo decodificado permanece cifrado pelo provedor do sistema operacional.

Ao abrir um JSON legado válido, a factory o regrava atomicamente no mesmo arquivo
antes de devolver o armazenamento ao serviço. Arquivos ilegíveis, ciphertext
inválido e envelopes de versão desconhecida falham sem serem apagados ou
substituídos por defaults. Se o cofre não estiver disponível, a migração não é
concluída e o arquivo legado é preservado; não há novas gravações em texto claro.
Não são criadas cópias de backup em texto claro pela migração.
Versões antigas do aplicativo não entendem o envelope protegido. Não abra o mesmo
perfil nessas versões; preserve um backup separado antes de qualquer downgrade
manual.

No Windows a proteção usa DPAPI; no macOS, Keychain; no Linux, exige libsecret ou
KWallet reconhecido. `basic_text` e backend desconhecido no Linux são rejeitados.
Na inicialização, indisponibilidade ou falha de leitura gera uma mensagem nos
idiomas suportados e encerra o app, preservando os arquivos. Desbloqueie o cofre
antes de abrir novamente.

Backups dos novos arquivos contêm dados cifrados, mas a recuperação depende da
conta/cofre original ou de uma recuperação compatível das chaves do sistema.
No Windows, outros processos executados com a mesma conta ainda podem acessar
DPAPI: esta proteção não substitui as permissões e a segurança da conta do usuário.

A integração mantém a API síncrona disponível no Electron 44 para preservar os
contratos síncronos de persistência. Antes de atualizar para Electron 46, migre para
a API assíncrona de safeStorage, que também oferece sinalização de rotação de
chaves. Regravações atuais usam a proteção disponível no cofre; isso não equivale
a rotacionar credenciais de trackers.

## Verificação

```sh
npm test -- --runInBand --runTestsByPath tests/unit/logRedaction.test.ts tests/unit/storeEncryption.test.ts tests/integration/protected-store.test.ts tests/integration/session-persistence.test.ts
npm run typecheck
npm run lint
npm run qa:release
```

Os testes de integração usam arquivos temporários, Conf real e provedor de chaves
simulado. O auxiliar da interface em `scripts/qa/renderer.mjs` usa ElectronStore e
safeStorage reais em perfil isolado, verificando migração de settings, round-trip
de settings/downloads e ausência de uma passkey sintética nos arquivos gravados.
Consulte [QA_RELEASE.md](QA_RELEASE.md) para o escopo da homologação.
