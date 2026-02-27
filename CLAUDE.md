# WhatsApp Group Archiver

## O que é
Bot 100% passivo que monitora grupos WhatsApp e arquiva todas as mensagens (texto, fotos, vídeos) localmente. Nunca responde mensagens.

## Stack
- Node.js (ESM - `"type": "module"`)
- `@whiskeysockets/baileys` — conexão WebSocket direta (sem Chromium/Puppeteer)
- `@sec-ant/zxing-wasm` — leitor de barcode ZXing C++ WASM (best-effort)
- `sharp` — pré-processamento de imagens para leitura de barcode
- Autenticação persistida em `./session/` (MultiFileAuthState)

## Arquitetura
- `src/index.js` — entry point, valida config, retry de drive (3×30s), contador de crashes
- `src/archiver-baileys.js` — conexão WhatsApp (Baileys), listener de mensagens, buffer de agrupamento, health check, crash recovery, buffer persistente em disco
- `src/storage.js` — salvamento de arquivos, organização por protocolo AS
- `src/alerts.js` — alertas (console + WhatsApp grupo LOGS_BOT + relatório diário)
- `src/config.js` — carrega .env
- `src/eventlog.js` — log centralizado de eventos críticos em `logs/eventos.csv` (abre no Excel)
- `src/barcode.js` — leitura de barcode em imagens (ZXing WASM, best-effort)
- `src/excel.js` — integração Excel Online via Microsoft Graph API
- `auth-excel.mjs` — autenticação one-time para o Excel (device code flow)

## Lógica de Protocolo/AS
- Protocolo = 10 dígitos numéricos extraídos da legenda/caption ou barcode
- **Válido** (2025/2026 + 6 dígitos): salva em `archive/{grupo}/{protocolo}/`
- **Fora do padrão**: salva em `archive/{grupo}/protocolo_revisar/{numero}/` + alerta
- **Múltiplas legendas**: salva em `archive/{grupo}/sem_legenda/{autor}/{proto1_proto2}/` com subpastas
- **Sem legenda**: salva em `archive/{grupo}/sem_legenda/{autor}/`
- Lógica baseada no organizer offline em `C:\Users\vinicius.oshima\Downloads\scripts\janeiro-sj\whatsapp-organizer.js`

## Buffer de Agrupamento
- Quando chega mídia, vai pro buffer (Map em memória + backup em disco para crash recovery)
- Se texto com protocolo chega do mesmo autor dentro do timeout → associa
- Se timeout → flush: salva em `sem_legenda/` ou na pasta do protocolo
- No shutdown (SIGINT/SIGTERM), flush de todos os buffers
- **Timeout por grupo** configurável via `GROUP_BUFFER_MS` no `.env`
  - `AGUA_TESTE_FEVEREIRO`: 10s (grupo de teste)
  - `Batedor Ambiental`: 300s (vídeos demoram mais para subir)
  - Demais: `BUFFER_TIMEOUT_MS` (padrão 60s)

## Leitor de Barcode (best-effort)
- Tenta ler barcode de cada imagem recebida (~200ms por foto)
- Rotações: 0°, 90°, 180°, 270° + normalize+sharpen
- Se barcode lido e nenhum protocolo digitado → usa barcode como protocolo
- Se barcode divergir do protocolo digitado → alerta no LOGS_BOT
- Funciona bem em fotos landscape com barcode claro; fotos comprimidas podem falhar

## Grupos Monitorados
Configurados no `.env`: `Batedor Ambiental`, `Manutenção Rede Ambiental/SEMASA`, `AGUA_TESTE_FEVEREIRO`, `TOPOGRAFIA`

## Alertas
- Console em tempo real
- WhatsApp para o grupo `LOGS_BOT` (configurado em `ALERT_GROUP`)
- Relatório diário em `archive/logs/{YYYY-MM-DD}_relatorio.txt` às 23:59

## Integração Excel Online
- Atualiza planilha SharePoint automaticamente ao salvar AS com protocolo válido
- **Somente grupo Manutenção** alimenta a planilha; demais grupos ignorados
- Fluxo: lê coluna A (linhas 2000-6000) → encontra protocolo → checa col F → escreve "Sim" em col J se >= 3 fotos, "X foto(s)" se < 3
- Linhas com coluna F = "Batedor" são ignoradas silenciosamente
- Configuração no `.env`: `EXCEL_FILE_ID`, `EXCEL_SHEET_NAME`, `EXCEL_STATUS_COL`
- Token OAuth2 salvo em `archive/.excel_token.json` (renovado automaticamente)
- **Primeira vez**: `node auth-excel.mjs` → abre navegador → login com conta corporativa → pronto

## Estrutura de Pastas Gerada
```
archive/
├── {NomeDoGrupo}/
│   ├── {protocolo}/              # AS válido
│   ├── protocolo_revisar/{num}/  # AS fora do padrão
│   ├── sem_legenda/{autor}/      # Sem legenda
│   └── {YYYY-MM-DD}/
│       └── mensagens.jsonl       # Log texto (1 JSON por linha)
├── logs/
│   ├── {YYYY-MM-DD}_relatorio.txt
│   └── {YYYY-MM-DD}_processed.txt  # IDs processados (deduplicação, auto-limpeza 30 dias)
├── .buffer_temp/                 # Buffers persistentes (crash recovery)
├── .last_active                  # Timestamp para catch-up inteligente
└── .excel_token.json             # Token OAuth2 para Excel Online

logs/                             # LOCAL ao projeto (não depende do drive X:)
└── eventos.csv                   # Log centralizado de eventos críticos (abre no Excel)
```

## Log de Eventos (`logs/eventos.csv`)
- Arquivo CSV local (não depende do drive X:), abre diretamente no Excel
- Colunas: `Data | Hora | Tipo | Mensagem | Detalhes`
- Eventos registrados:

| Tipo | Quando |
|---|---|
| `STARTUP` | Bot inicia |
| `DRIVE_RETRY` | Tentativa de reconexão ao drive X: |
| `DRIVE_FALLBACK` | Troca automática para caminho reserva |
| `DRIVE_ERRO` | Drive indisponível e sem fallback configurado |
| `CONECTADO` | WhatsApp conectado com sucesso |
| `SESSAO_LIMPA` | Health check limpou sessão após 3 falhas |
| `SHUTDOWN` | Bot encerrado normalmente (SIGINT/SIGTERM) |
| `CRASH` | Erro fatal |

## Drive de Arquivo / Caminho Reserva
- **Drive principal**: `X:\Contrato 005-2024\2026\02 - Fevereiro\Registros Fotográficos\Água\FOTOS_SEM_AS` (configurado em `ARCHIVE_DIR`)
- **Caminho reserva**: `C:\Users\vinicius.oshima\Downloads\fotos-reserva` (configurado em `ARCHIVE_FALLBACK_DIR`)
- No startup, `checkConfig` tenta acessar o drive principal até **3 vezes** (30s entre cada tentativa)
  - Drive disponível desde o início → funciona normalmente, sem aviso
  - Drive conecta durante os retries → continua normalmente + alerta no LOGS_BOT
  - Drive indisponível após 3 tentativas → **muda automaticamente para o caminho reserva** + alerta no LOGS_BOT
  - Sem `ARCHIVE_FALLBACK_DIR` configurado → bot inicia mas salvamentos falharão + alerta no LOGS_BOT
- O alerta informa exatamente qual caminho está sendo usado
- Erros de drive: `ENOENT`, `ENOTCONN`, `ENODEV`, `ENOMEDIUM`, `EIO` — outros erros ainda crasham
- Após reconectar o drive X:, mover os arquivos de `fotos-reserva` manualmente para o local correto

## Resiliência / Auto-start
- **Botão power do notebook** configurado para "não fazer nada" (evita desligamento acidental)
  - Revertir: Configurações > Sistema > Energia > "Botão de energia"
- **Auto-start no login do Windows** via atalho na pasta Startup
  - Atalho: `%AppData%\Microsoft\Windows\Start Menu\Programs\Startup\WhatsAppArchiver.lnk`
  - Executa `start-bot.bat` (janela minimizada)
  - Para desativar: deletar o atalho acima
- `start-bot.bat` — script que faz `cd` no projeto e roda `npm start`
- **Drive indisponível no startup** → retry 3×30s → fallback automático para `fotos-reserva` (ver seção Drive)
- **Memory leak** → PM2 reinicia o processo automaticamente ao atingir 400MB
- **Reinicio preventivo** → PM2 reinicia todo dia às 7:30 (Brasília) via cron

## PM2
- `pm2 start ecosystem.config.cjs` — inicia o bot
- `pm2 restart whatsapp-bila-organizer --update-env` — restart pegando novas variáveis de ambiente
- `pm2 logs whatsapp-bila-organizer --raw` — logs sem prefixo (necessário pra escanear QR code)
- `pm2 kill` — mata o daemon PM2 e todos os processos
- Se precisar escanear QR code novo: `pm2 kill`, limpar `session/`, iniciar PM2, usar `--raw` pra ver QR
- `ecosystem.config.cjs` — config do PM2
  - `max_memory_restart: '400M'` — reinicia automaticamente se o processo ultrapassar 400MB (proteção contra memory leak)
  - `cron_restart: '30 7 * * *'` — reinicio preventivo todo dia às 7:30 (Brasília), antes do expediente
- **pm2-logrotate** instalado — rotação automática dos logs do PM2 a cada 10MB, retém 7 arquivos comprimidos

## Catch-up de Mensagens
- No startup, processa mensagens enviadas enquanto o bot estava offline (tipo `append` do Baileys)
- **Catch-up inteligente**: se ficou offline X horas, busca X+0.5h (teto: `MAX_CATCHUP_HOURS`)
- Janela de catch-up dura 60s após conectar (suficiente para receber histórico do WhatsApp)
- Deduplicação por ID de mensagem: arquivo `{YYYY-MM-DD}_processed.txt`
- Arquivos `_processed.txt` com mais de 30 dias são removidos automaticamente no startup

## Health Check / Auto-Recovery
- **Health check a cada 5 min** — verifica se `isConnected` ainda é true
- Se 3 falhas consecutivas → limpa sessão, mata processo, PM2 reinicia
- **Contador de crashes** no `index.js` via arquivo `.restart_count`
  - Se o bot crashar 3x seguidas → limpa a pasta `session/` automaticamente
  - Quando conecta com sucesso → reseta o contador
- Após limpar sessão, novo QR code será gerado (escanear pelo celular)

## Comandos
- `npm start` — inicia o bot
- `npm install` — instala dependências
- `node auth-excel.mjs` — autenticação one-time para Excel Online

## Projeto Relacionado
- Bot original (interativo): `C:\Users\vinicius.oshima\Downloads\scripts\local-bot\`
- Organizer offline: `C:\Users\vinicius.oshima\Downloads\scripts\janeiro-sj\whatsapp-organizer.js`
