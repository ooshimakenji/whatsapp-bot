# WhatsApp Bot — Organizador de Fotos

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white) ![Claude API](https://img.shields.io/badge/Claude-API-blueviolet) ![Licença](https://img.shields.io/badge/licença-MIT-green)

Bot de WhatsApp para receber e organizar fotos de colaboradores com validação automática de legendas.

## Funcionalidades

- Recebe fotos via WhatsApp com legendas no formato `202XXXXXXX`
- Valida o formato da legenda automaticamente
- Exige mínimo de 3 fotos por lote
- Salva fotos em pasta local organizada por data
- Envia relatório diário por e-mail
- Controle de colaboradores autorizados via JSON
- Respostas inteligentes com Claude AI (opcional)

## Stack

- **Node.js** + **whatsapp-web.js**
- **Anthropic Claude API** para validação inteligente
- **Nodemailer** para relatórios por e-mail
- **Puppeteer** para renderização do QR Code

## Instalação

```bash
git clone https://github.com/ooshimakenji/whatsapp-bot.git
cd whatsapp-bot
npm install
```

## Configuração

Copie `.env.example` para `.env` e preencha:

```env
CLAUDE_API_KEY=sua_chave_aqui
EMAIL_USER=seu_email
EMAIL_PASS=sua_senha_app
EMAIL_TO=destinatario
```

## Uso

```bash
npm start        # produção
npm run dev      # desenvolvimento (hot reload)
```

Escaneie o QR Code exibido no terminal com o WhatsApp.

## Estrutura

```
src/
├── bot/whatsapp.js        # Handler principal do WhatsApp
├── config/
│   ├── index.js           # Configurações gerais
│   └── collaborators.json # Números autorizados
├── services/
│   ├── claude.js          # Integração Claude API
│   ├── email.js           # Relatórios por e-mail
│   ├── storage.js         # Salvamento de arquivos
│   └── validator.js       # Validação de legendas
└── index.js               # Ponto de entrada
```

## Licença

MIT


## Contribuindo / Contributing

Contribuições são bem-vindas! Abra uma issue ou envie um pull request.  
Contributions are welcome! Feel free to open an issue or submit a pull request.
