# Bloqueio para WhatsApp Web

Extensão local para Chrome e Firefox que cobre o WhatsApp Web com uma senha. Ela não lê, altera ou envia mensagens.

## Instalação para desenvolvimento

### Chrome

1. Abra `chrome://extensions`.
2. Ative o **Modo do desenvolvedor**.
3. Escolha **Carregar sem compactação** e selecione esta pasta.

### Firefox

1. Abra `about:debugging#/runtime/this-firefox`.
2. Selecione **Carregar extensão temporária**.
3. Escolha o arquivo `manifest.json` desta pasta.

O Zen Browser usa o mesmo fluxo do Firefox: abra `about:debugging#/runtime/this-firefox`, escolha **Load Temporary Add-on** e selecione `manifest.json`.

## Como funciona

- Na primeira abertura de `https://web.whatsapp.com/`, crie uma senha de no mínimo seis caracteres.
- A senha não é salva em texto: somente um verificador PBKDF2 com salt é persistido no armazenamento local da extensão.
- Cada recarga da página é bloqueada; também é possível bloquear pela extensão ou por inatividade.
- O atalho sugerido `Ctrl+Shift+L` bloqueia a aba atual do WhatsApp Web. Em **Configurações > Alterar atalho**, a extensão abre a tela nativa para o usuário escolher outra combinação.

## Limitações de segurança

Esta é uma camada de privacidade para um navegador já autenticado. Uma pessoa com acesso ao perfil do navegador pode desativar a extensão ou apagar seus dados. Para proteger o computador, use também senha do sistema e um perfil de navegador separado.
