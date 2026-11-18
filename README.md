# Radar

Aplicação de monitoramento, coleta, triagem e organização de notícias, com perfis editoriais configuráveis.

> **Estado do pacote:** preparação inicial para publicação pública. A aplicação principal corresponde à versão Radar V1.18 disponível no projeto. O Worker foi preparado para receber credenciais por Secret Binding, sem chave embutida no código.

## Estrutura

- `app/index.html` — aplicação principal (HTML único).
- `worker/worker.js` — Cloudflare Worker e adaptadores de coleta/serviços.
- `profiles/clipping-exclusivo-alrn.example.json` — exemplo de perfil editorial importável para clipping exclusivo da ALRN.

## Requisitos de segurança

- Nunca publique chaves de Gemini, Dados Futebol, tokens, cookies ou credenciais.
- A chave Dados Futebol deve ser configurada como Secret no Cloudflare Worker, com o nome `DADOSFUTEBOL_API_KEY`.
- Configure o secret com: `npx wrangler secret put DADOSFUTEBOL_API_KEY`.
- A aplicação HTML pode solicitar uma chave Gemini no próprio navegador. Não inclua chaves reais em arquivos versionados, capturas de tela ou issues.
- Antes de abrir o acesso público, revise também os domínios permitidos, CORS, limites de uso e eventuais custos dos serviços externos.

## Publicação do Worker

1. Crie/associe um Worker no painel Cloudflare ou via Wrangler.
2. Publique `worker/worker.js` conforme a configuração do seu ambiente.
3. Cadastre `DADOSFUTEBOL_API_KEY` como Secret no ambiente do Worker.
4. Configure no Radar a URL do Worker publicado.

Este repositório ainda não inclui um `wrangler.toml`, pois o identificador da conta, o nome do Worker e os bindings de produção precisam ser definidos pelo proprietário.

## Perfis editoriais

Os arquivos em `profiles/` são exemplos de configuração. O usuário pode importar o JSON pela interface do Radar. Não inclua nesse diretório exports com notícias, dados pessoais ou configurações locais.

## Dados locais

O Radar utiliza armazenamento do navegador para configurações e dados de operação. Esses dados não são sincronizados pelo GitHub.

## Licença

Nenhuma licença de código aberto foi atribuída neste pacote. Até que o titular escolha e adicione uma licença, todos os direitos permanecem reservados.
