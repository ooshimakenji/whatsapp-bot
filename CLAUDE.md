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

## Resiliência / Auto-start
- **Botão power do notebook** configurado para "não fazer nada" (evita desligamento acidental)
  - Revertir: Configurações > Sistema > Energia > "Botão de energia"
- **Auto-start no login do Windows** via atalho na pasta Startup
  - Atalho: `%AppData%\Microsoft\Windows\Start Menu\Programs\Startup\WhatsAppArchiver.lnk`
  - Executa `start-bot.bat` (janela minimizada)
  - Para desativar: deletar o atalho acima
- `start-bot.bat` — script que faz `cd` no projeto e roda `npm start`

## PM2
- `pm2 start ecosystem.config.cjs` — inicia o bot
- `pm2 logs whatsapp-bila-organizer --raw` — logs sem prefixo (necessário pra escanear QR code)
- `pm2 kill` — mata o daemon PM2 e todos os processos (usar quando Chrome zumbi travar)
- Se precisar escanear QR code novo: `pm2 kill`, limpar `session/`, iniciar PM2, usar `--raw` pra ver QR
- `ecosystem.config.cjs` — config do PM2

## Catch-up de Mensagens
- No startup, busca as últimas 50 mensagens de cada grupo monitorado
- Processa apenas mensagens da última 1 hora (`CATCHUP_WINDOW_MS`)
- Evita perder mensagens enviadas enquanto o bot estava offline/reiniciando

## Health Check / Auto-Recovery
- **Health check a cada 5 min** via `client.getState()` no `archiver.js`
- Se 3 falhas consecutivas → limpa sessão corrompida, mata o processo, PM2 reinicia
- **Contador de crashes** no `index.js` via arquivo `.restart_count`
  - Se o bot crashar 3x seguidas no `initialize()` → limpa a pasta `session/` automaticamente
  - Quando conecta com sucesso → reseta o contador
- Após limpar sessão, um novo QR code será gerado (precisa escanear pelo celular)
- Alertas de health check são enviados via DM no WhatsApp (se ainda conectado)

## Comandos
- `npm start` — inicia o bot
- `npm install` — instala dependências

## Projeto Relacionado
- Bot original (interativo): `C:\Users\vinicius.oshima\Downloads\scripts\local-bot\`
- Organizer offline: `C:\Users\vinicius.oshima\Downloads\scripts\janeiro-sj\whatsapp-organizer.js`
