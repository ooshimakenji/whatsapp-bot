# WhatsApp Group Archiver

## O que é
Bot 100% passivo que monitora grupos WhatsApp e arquiva todas as mensagens (texto, fotos, vídeos) localmente. Nunca responde mensagens.

## Stack
- Node.js (ESM - `"type": "module"`)
- `whatsapp-web.js` v1.26.0 — conexão via QR code + Puppeteer headless
- Autenticação persistida em `./session/` (LocalAuth)

## Arquitetura
- `src/index.js` — entry point, valida config
- `src/archiver.js` — conexão WhatsApp, listener de mensagens, buffer de agrupamento
- `src/storage.js` — salvamento de arquivos, organização por protocolo AS
- `src/alerts.js` — alertas (console + WhatsApp DM para si mesmo + relatório diário)
- `src/config.js` — carrega .env

## Lógica de Protocolo/AS
- Protocolo = 10 dígitos numéricos extraídos da legenda/caption
- **Válido** (2025/2026 + 6 dígitos): salva em `archive/{grupo}/{protocolo}/`
- **Fora do padrão**: salva em `archive/{grupo}/protocolo_revisar/{numero}/` + alerta
- **Múltiplas legendas**: salva em `archive/{grupo}/sem_legenda/{autor}/{proto1_proto2}/` com subpastas
- **Sem legenda**: salva em `archive/{grupo}/sem_legenda/{autor}/`
- Lógica baseada no organizer offline em `C:\Users\vinicius.oshima\Downloads\scripts\janeiro-sj\whatsapp-organizer.js`

## Buffer de Agrupamento
- Quando chega mídia sem caption com protocolo, vai pro buffer (Map em memória)
- Se texto com protocolo chega do mesmo autor em até 2 min → associa
- Se timeout → salva em `sem_legenda/`
- No shutdown (SIGINT/SIGTERM), flush de todos os buffers

## Grupos Monitorados
Configurados no `.env`: `Batedor Ambiental`, `Manutenção Rede Ambiental/SEMASA`, `AGUA_TESTE_FEVEREIRO`

## Alertas
- Console em tempo real
- WhatsApp DM (chat "Você" — auto-detecta número via `client.info.wid`)
- Relatório diário em `archive/logs/{YYYY-MM-DD}_relatorio.txt` às 23:59

## Estrutura de Pastas Gerada
```
archive/
├── {NomeDoGrupo}/
│   ├── {protocolo}/              # AS válido
│   ├── protocolo_revisar/{num}/  # AS fora do padrão
│   ├── sem_legenda/{autor}/      # Sem legenda
│   └── {YYYY-MM-DD}/
│       └── mensagens.jsonl       # Log texto (1 JSON por linha)
└── logs/
    └── {YYYY-MM-DD}_relatorio.txt
```

## Comandos
- `npm start` — inicia o bot
- `npm install` — instala dependências

## Projeto Relacionado
- Bot original (interativo): `C:\Users\vinicius.oshima\Downloads\scripts\local-bot\`
- Organizer offline: `C:\Users\vinicius.oshima\Downloads\scripts\janeiro-sj\whatsapp-organizer.js`
