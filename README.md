# WhatsApp Bot - Organizador de Fotos

Bot de WhatsApp para receber e organizar fotos de colaboradores com validação automática de legendas.

## Funcionalidades

- Recebe fotos via WhatsApp com legendas no formato `202XXXXXXX`
- Valida o formato da legenda automaticamente
- Exige mínimo de 3 fotos por lote
- Salva fotos em pasta local organizada por data
- Envia relatório diário por email
- Controle de colaboradores autorizados via JSON
- Respostas inteligentes com Claude AI (opcional)

## Stack

- **Node.js** + **whatsapp-web.js**
- **Claude API** (Anthropic) para validação inteligente
- **Nodemailer** para relatórios por email
- **Puppeteer** para renderização do QR Code

## Instalação

```bash
git clone https://github.com/ooshimakenji/whatsapp-bot.git
cd whatsapp-bot
npm install
```

## Configuração

Copie `.env.example` para `.env` e preencha as variáveis:

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

Escaneie o QR Code que aparecer no terminal com o WhatsApp.

## Estrutura

```
src/
├── bot/whatsapp.js        # Handler principal WhatsApp
├── config/
│   ├── index.js           # Configurações
│   └── collaborators.json # Números autorizados
├── services/
│   ├── claude.js          # Integração Claude API
│   ├── email.js           # Relatórios por email
│   ├── storage.js         # Salvamento de arquivos
│   └── validator.js       # Validação de legendas
└── index.js               # Ponto de entrada
```
