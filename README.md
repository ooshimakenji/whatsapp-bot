# WhatsApp Bila Organizer

Bot passivo que monitora grupos WhatsApp e organiza automaticamente fotos e vídeos por protocolo de atendimento (AS), com integração a planilha Excel Online.

**Repositório:** https://github.com/ooshimakenji/whatsapp-bot

## O que faz

- Monitora grupos WhatsApp configurados e arquiva todas as mídias localmente
- Associa cada mídia ao protocolo AS de 10 dígitos (extraído da legenda)
- Atualiza coluna de status na planilha Excel Online via Microsoft Graph API
- Envia alertas em tempo real e relatório diário por WhatsApp
- Nunca responde mensagens — 100% passivo

## Stack

- Node.js (ESM)
- [Baileys](https://github.com/WhiskeySockets/Baileys) — conexão WhatsApp via multi-device
- Microsoft Graph API — Excel Online
- PM2 — gerenciamento de processo e auto-restart

## Estrutura de pastas gerada

```
archive/
├── {NomeDoGrupo}/
│   ├── {protocolo}/              # AS válido (2025/2026)
│   ├── protocolo_revisar/{num}/  # AS fora do padrão
│   ├── sem_legenda/{autor}/      # Sem legenda
│   └── {YYYY-MM-DD}/
│       └── mensagens.jsonl
└── logs/
    └── {YYYY-MM-DD}_relatorio.txt
```

## Configuração

Copie `.env.example` para `.env` e preencha:

```env
GROUPS=Grupo 1, Grupo 2
ALERT_GROUP=LOGS_BOT
EXCEL_FILE_ID=...
EXCEL_SHEET_NAME=ASs entregues
EXCEL_STATUS_COL=J
```

Autenticação Excel (uma vez):
```
node auth-excel.mjs
```

## Iniciar

```
pm2 start ecosystem.config.cjs
pm2 logs whatsapp-bila-organizer --raw
```
