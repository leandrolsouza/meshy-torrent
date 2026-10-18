# Atualizações do aplicativo

O Meshy usa `electron-updater` 6, compatível com o electron-builder 26 do projeto,
para atualizar o instalador NSIS no Windows x64 pelo repositório público
`leandrolsouza/meshy-torrent` no GitHub Releases. macOS, Linux e desenvolvimento
permanecem com atualização manual neste primeiro release.

## Comportamento

Em um pacote de distribuição com editor confiável configurado, o aplicativo:

1. Verifica uma nova versão 30 segundos após iniciar e depois a cada seis horas.
2. Permite consultar manualmente por **Verificar atualizações**, no rodapé.
3. Baixa a nova versão automaticamente e mostra o progresso.
4. Aguarda a verificação de integridade e da assinatura pelo electron-updater.
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

## Assinatura necessária

O projeto ainda não possui certificado. A decisão para esta beta é distribuir sem
assinatura e manter atualização manual. O candidato informa
**Atualizações automáticas exigem uma versão assinada**. Não verifica,
baixa ou instala atualizações automaticamente enquanto `app-update.yml` não tiver
um `publisherName` válido para o feed conhecido. Em desenvolvimento, a mensagem é
**Atualizações disponíveis no app instalado**.

O campo `publisherName` é gerado pelo electron-builder a partir da identidade do
certificado. O electron-updater compara a assinatura do novo instalador com essa
identidade; a verificação Authenticode não foi desativada. Não preencha esse campo
com um nome fictício para contornar a ausência do certificado.

Para o fluxo de certificado PFX, configure no ambiente de build ou nos secrets do
repositório:

- `CSC_LINK`: certificado no formato aceito pelo electron-builder, como PFX em base64.
- `CSC_KEY_PASSWORD`: senha do certificado.

Não versione certificados ou senhas. Nenhum token de acesso ao GitHub deve ser
embutido no aplicativo; o feed de distribuição previsto é público. Outros serviços
de assinatura podem exigir configuração própria do electron-builder.

Com as credenciais configuradas:

```sh
npm run dist:win:signed
```

Esse comando exige assinatura com `forceCodeSigning`. O workflow atual da beta usa
`dist:win`, permite pacotes sem certificado e apenas registra o estado Authenticode.
Ao ativar a assinatura, altere também o workflow para exigir o comando assinado e
validar a assinatura final. Consulte a
[documentação de assinatura do electron-builder 26](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/).

## Publicar uma nova versão

O roteiro abaixo é para a distribuição futura com atualização automática.
Para a beta atual sem assinatura, siga [RELEASE.md](RELEASE.md), gere com
`dist:win` e distribua a atualização para instalação manual. Quem instalar esta
beta precisará instalar manualmente uma versão assinada para ingressar nesse fluxo.

1. Atualize a versão em `package.json` e `package-lock.json` com `npm version`,
   usando `--no-git-tag-version` durante a preparação. Cada release publicado
   precisa ter uma versão nova; não substitua os arquivos de uma versão existente.
2. Execute as verificações do projeto e gere a distribuição assinada.
3. Confira `app-update.yml` no pacote: provedor, repositório e `publisherName`.
4. Conclua a homologação, incluindo atualização entre duas versões assinadas.
5. Depois de configurar a exigência de assinatura no workflow, crie a tag
   correspondente ao manifesto, como `v0.1.0-beta.2`.
6. Anexe ao mesmo GitHub Release todos os arquivos:
    - `Meshy-<versão>-win-x64-setup.exe`
    - `Meshy-<versão>-win-x64-setup.exe.blockmap`
    - `latest.yml`
    - `SHA256SUMS`
7. Marque versões `-beta.N` como **pre-release**; versões estáveis devem ser
   releases normais. Um draft não é disponibilizado pelo feed público de atualização.

`latest.yml` inclui versão, caminho e SHA-512 do instalador. O script de checksums
rejeita manifesto com versão ou hash incompatíveis e calcula SHA-256 de instalador,
blockmap e manifesto. Use todos os arquivos da mesma execução assinada; assinar ou
alterar o instalador depois de gerar `latest.yml` invalida os metadados.

O workflow publica tags beta como pré-releases após os jobs Windows e auditoria
aprovados, usando os quatro artefatos daquela execução e conferindo SHA-256 antes
de tornar o release público. A beta atual continua sem assinatura e com atualização
manual. SHA-256 não substitui assinatura e identidade do editor.

## Homologar a atualização

Em VM Windows x64 com perfil de teste, instale uma versão assinada anterior e
publique uma versão assinada posterior no canal correspondente. Confirme:

- Consulta automática e manual, download com progresso e versão exibida.
- Cancelamento do diálogo mantendo a versão atual aberta e a atualização pronta.
- Reinício com modo bandeja ativo e restauração de sessão, fila e seleção de arquivos.
- Ausência de instalação ao apenas fechar o app ou desligar o sistema.
- Falha por rede indisponível, checksum inválido ou assinatura com outro editor,
  sem iniciar o instalador, seguida de nova tentativa.
- Cliente estável não recebendo beta; cliente beta conseguindo avançar para estável.

Os testes automatizados usam um driver simulado e validam estados, IPC, interface,
persistência e bandeja. Não comprovam a entrega de uma atualização pelo GitHub nem
a instalação entre duas versões assinadas; essa validação depende do certificado
e dos releases de homologação.
