# Atualizações do aplicativo

O Meshy usa `electron-updater` 6, compatível com o electron-builder 26 do projeto,
para atualizar o instalador NSIS no Windows x64 pelo repositório público
`leandrolsouza/meshy-torrent` no GitHub Releases. Builds Windows x64 sem certificado
também podem atualizar, limitados ao feed oficial em HTTPS. macOS, Linux e
desenvolvimento permanecem com atualização manual.

## Comportamento

Em um pacote de distribuição Windows x64 com configuração do feed oficial, o aplicativo:

1. Verifica uma nova versão 30 segundos após iniciar e depois a cada seis horas.
2. Permite consultar manualmente por **Verificar atualizações**, no rodapé.
3. Baixa a nova versão automaticamente e mostra o progresso.
4. Confere o hash SHA-512 do instalador pelo manifesto `latest.yml`. Quando o build
   tem `publisherName`, também valida a assinatura Authenticode; sem certificado,
   não há validação da identidade do editor.
5. Oferece **Reiniciar e atualizar**. O diálogo informa que as transferências
   serão interrompidas e permite cancelar sem perder o download da atualização.
6. Salva a sessão e permite o fechamento da janela mesmo com modo bandeja ativo,
   antes de chamar o instalador. Falha na persistência ou uma operação de arquivos
   em andamento impede a instalação para permitir nova tentativa.

Após a confirmação, o instalador é chamado em modo silencioso e reabre o Meshy
quando terminar. A validação desse ciclo em Windows permanece parte da homologação.

Fechar o app ou desligar o computador não dispara a instalação da atualização:
`autoInstallOnAppQuit` fica desativado. A instalação é explícita para evitar
interromper transferências sem confirmação e problemas ao desligar o Windows.

Versões beta consultam pré-releases beta e versões estáveis posteriores. Versões
estáveis consultam releases estáveis. Downgrade e instaladores web ficam
desabilitados. O provedor do GitHub usa os metadados de cada release, com fallback
de canal para `latest.yml`, conforme a implementação da versão 6 instalada.

O serviço vive no main, com uma única agenda de consultas. A ponte IPC tem apenas
consulta de estado, verificação e instalação; não recebe URLs, caminhos ou canais
arbitrários do renderer. As assinaturas de eventos são removidas ao desmontar os
componentes, e revisões impedem que uma resposta antiga sobrescreva estado novo.

## Integridade e assinatura

O projeto ainda não possui certificado Authenticode. Builds Windows x64 sem
`publisherName` verificam o SHA-512 do instalador publicado em `latest.yml` e só
consultam o repositório oficial do Meshy pelo GitHub em HTTPS. Isso detecta um
arquivo que não corresponde ao manifesto recebido, mas não identifica o editor nem
protege contra comprometimento da conta ou do processo de publicação. O app informa
essa limitação na ajuda do controle de atualização. Em desenvolvimento, a mensagem
é **Atualizações disponíveis no app instalado**.

Quando `publisherName` existe, o electron-updater compara a assinatura Authenticode
do instalador com a identidade confiável. Esse controle permanece ativo nos builds
assinados; não preencha o campo com um nome fictício. Sem `publisherName`, o
electron-updater 6 não faz essa comparação e usa o SHA-512 publicado no manifesto.

Para o fluxo de certificado PFX, configure no ambiente de build ou nos secrets do
repositório:

- `CSC_LINK`: certificado no formato aceito pelo electron-builder, como PFX em base64.
- `CSC_KEY_PASSWORD`: senha do certificado.

Não versione certificados ou senhas. Nenhum token de acesso ao GitHub deve ser
embutido no aplicativo; o feed de distribuição previsto é público. Outros serviços
de assinatura podem exigir configuração própria do electron-builder.

O release beta atual usa builds sem certificado e atualizações automáticas pelo
feed oficial. Com credenciais de certificado configuradas, builds assinados mantêm
também a validação de editor. Para gerá-los:

```sh
npm run dist:win:signed
```

Esse comando exige assinatura com `forceCodeSigning`. O workflow atual usa
`dist:win` e registra o estado Authenticode; quando houver certificado disponível,
o manifesto e a instalação final também precisam ser homologados com a validação de
editor ativa. Consulte a
[documentação de assinatura do electron-builder 26](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/).

## Publicar uma nova versão

Siga [RELEASE.md](RELEASE.md), gere o instalador Windows x64 e publique no GitHub
Release oficial com o `latest.yml`, blockmap e `SHA256SUMS` daquela mesma execução.
Os instaladores beta sem certificado também podem receber versões beta seguintes.
Versões antigas que exibem **Atualizações automáticas exigem uma versão assinada**
precisam ser instaladas manualmente uma vez para obter o atualizador habilitado.

1. Atualize a versão em `package.json` e `package-lock.json` com `npm version`,
   usando `--no-git-tag-version` durante a preparação. Cada release publicado
   precisa ter uma versão nova; não substitua os arquivos de uma versão existente.
2. Execute as verificações do projeto e gere a distribuição com `dist:win`.
3. Confira `app-update.yml` no pacote: provedor, repositório e, se houver certificado,
   `publisherName`.
4. Conclua a homologação, incluindo atualização entre duas versões da mesma linha.
5. Crie a tag correspondente ao manifesto, como `v0.1.0-beta.4`.
6. Anexe ao mesmo GitHub Release todos os arquivos:
    - `Meshy-<versão>-win-x64-setup.exe`
    - `Meshy-<versão>-win-x64-setup.exe.blockmap`
    - `latest.yml`
    - `SHA256SUMS`
7. Marque versões `-beta.N` como **pre-release**; versões estáveis devem ser
   releases normais. Um draft não é disponibilizado pelo feed público de atualização.

`latest.yml` inclui versão, caminho e SHA-512 do instalador. O script de checksums
rejeita manifesto com versão ou hash incompatíveis e calcula SHA-256 de instalador,
blockmap e manifesto. Use todos os arquivos da mesma execução; assinar ou alterar o
instalador depois de gerar `latest.yml` invalida os metadados.

O workflow publica tags beta como pré-releases após os jobs Windows e auditoria
aprovados, usando os quatro artefatos daquela execução e conferindo SHA-256 antes
de tornar o release público. O SHA-256 auxilia a distribuição, e o SHA-512 do
manifesto protege a integridade do instalador baixado. Nenhum dos dois substitui a
identidade Authenticode do editor.

## Homologar a atualização

Em VM Windows x64 com perfil de teste, instale uma versão beta sem certificado e
publique outra versão beta posterior no feed oficial. Confirme também a validação
de editor quando testar builds assinados. Verifique:

- Consulta automática e manual, download com progresso e versão exibida.
- Cancelamento do diálogo mantendo a versão atual aberta e a atualização pronta.
- Reinício com modo bandeja ativo e restauração de sessão, fila e seleção de arquivos.
- Ausência de instalação ao apenas fechar o app ou desligar o sistema.
- Falha por rede indisponível, SHA-512 inválido ou assinatura com outro editor
  (quando configurada), sem iniciar o instalador, seguida de nova tentativa.
- Cliente estável não recebendo beta; cliente beta conseguindo avançar para estável.

Os testes automatizados usam um driver simulado e validam estados, IPC, interface,
persistência e bandeja. Não comprovam a entrega de uma atualização pelo GitHub nem
a instalação entre duas versões assinadas; essa validação depende do certificado
e dos releases de homologação.
