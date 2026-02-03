Olá! Preciso criar um Bot WhatsApp completo com as seguintes características:

## 📋 OBJETIVO DO PROJETO

Bot WhatsApp que:
- Recebe fotos com legendas numéricas dos colaboradores
- Valida legendas usando Claude API (formato: 202XXXXXXX)
- Valida mínimo de 3 fotos por lote
- Faz upload automático para OneDrive organizando por data
- Envia relatório diário por email
- Controla apenas 40 números autorizados
- Roda 24/7 em AWS EC2

## 🏗️ ESTRUTURA DO PROJETO

whatsapp-bot/
├── src/
│   ├── bot/
│   │   ├── whatsapp-handler.js      # Gerencia mensagens WhatsApp
│   │   ├── session-manager.js       # Controla sessões dos usuários
│   │   └── validators.js            # Validações com Claude
│   ├── services/
│   │   ├── claude-service.js        # Integração Claude API
│   │   ├── onedrive-service.js      # Upload OneDrive
│   │   └── email-service.js         # Envio de relatórios
│   ├── utils/
│   │   ├── logger.js                # Sistema de logs
│   │   └── helpers.js               # Funções auxiliares
│   └── config/
│       ├── authorized-numbers.json  # Lista de colaboradores
│       └── settings.js              # Configurações gerais
├── reports/                         # Relatórios temporários
├── temp/                            # Fotos temporárias
├── logs/                            # Arquivos de log
├── .env                             # Variáveis de ambiente
├── .env.example                     # Template de configuração
├── package.json
├── ecosystem.config.js              # Configuração PM2
└── README.md

## 🔧 TECNOLOGIAS

- Node.js + WhatsApp Web.js
- Claude API (Anthropic) para validação de legendas
- OneDrive API (Microsoft Graph) para armazenamento
- Nodemailer para relatórios por email
- PM2 para gerenciamento de processos
- AWS EC2 (Free Tier) para hospedagem

## 📝 FLUXO DE FUNCIONAMENTO

1. Colaborador envia "Bom dia" → Bot responde pedindo legenda
2. Colaborador envia legenda (ex: 202411001) → Claude valida formato
3. Se legenda OK → Pede fotos (mínimo 3)
4. Colaborador envia fotos → Bot valida quantidade
5. Pode enviar "proxima" para novo lote ou "terminar"
6. Upload automático para OneDrive: /WhatsApp Bot/2024-11-20/202411001_001.jpg
7. Relatório diário às 18h com estatísticas

## 🎯 VALIDAÇÕES IMPORTANTES

- Legenda: formato 202XXXXXXX (9 dígitos começando com 202)
- Mínimo: 3 fotos por lote
- Apenas números autorizados em authorized-numbers.json
- Timeout de sessão: 30 minutos de inatividade

## 🔐 VARIÁVEIS DE AMBIENTE (.env)

CLAUDE_API_KEY=
ONEDRIVE_CLIENT_ID=
ONEDRIVE_CLIENT_SECRET=
ONEDRIVE_REFRESH_TOKEN=
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=
EMAIL_PASS=
EMAIL_TO=
NODE_ENV=production

## 📦 DEPENDÊNCIAS PRINCIPAIS

- whatsapp-web.js
- @anthropic-ai/sdk
- @microsoft/microsoft-graph-client
- nodemailer
- qrcode-terminal
- winston (logs)
- node-cron (relatórios agendados)

## 🚀 PRÓXIMOS PASSOS

Estou na FASE 2 do roadmap - preciso que você crie:

1. Toda a estrutura de pastas
2. Todos os arquivos .js com código funcional
3. package.json com todas as dependências
4. .env.example com template
5. ecosystem.config.js para PM2
6. README.md completo

Pode começar criando os arquivos na ordem:
1. package.json e .env.example
2. src/config/ (settings.js e authorized-numbers.json)
3. src/utils/ (logger.js e helpers.js)
4. src/services/ (claude-service.js, onedrive-service.js, email-service.js)
5. src/bot/ (validators.js, session-manager.js, whatsapp-handler.js)
6. index.js (arquivo principal)
7. ecosystem.config.js e README.md

IMPORTANTE: 
- Código deve ser production-ready
- Comentários em português
- Error handling robusto
- Logs detalhados
- Segurança em primeiro lugar

BORA COMEÇAR? 🚀