# WhatsApp Bila Organizer - Documentacao

## O que e

Bot automatico que monitora grupos do WhatsApp e arquiva todas as fotos e videos enviados, organizando por numero de protocolo (AS). Funciona 24/7, nunca responde mensagens, apenas salva.

---

## Grupos Monitorados

- Batedor Ambiental
- Manutencao Rede Ambiental/SEMASA
- AGUA_TESTE_FEVEREIRO
- TOPOGRAFIA

Novos grupos podem ser adicionados editando o arquivo `.env`.

---

## Como as Midias Sao Organizadas

### Foto/video com protocolo valido (2025 ou 2026 + 6 digitos)

```
archive/{NomeDoGrupo}/{protocolo}/
```

Exemplo: `archive/Batedor Ambiental/2025001234/`

### Foto/video com protocolo fora do padrao

```
archive/{NomeDoGrupo}/protocolo_revisar/{numero}/
```

Gera alerta automatico.

### Multiplos protocolos no mesmo envio

```
archive/{NomeDoGrupo}/sem_legenda/{encanador}/{proto1_proto2}/
```

Subpastas vazias sao criadas para cada protocolo como referencia.

### Foto/video sem legenda

```
archive/{NomeDoGrupo}/sem_legenda/{encanador}/
```

---

## Logica de Agrupamento

O sistema agrupa automaticamente todas as midias enviadas pelo mesmo encanador em sequencia:

1. Encanador envia fotos (com ou sem legenda) - tudo vai para um buffer temporario
2. Quando o encanador para de enviar por **30 segundos**, o bloco e processado
3. Se alguma foto do bloco tem protocolo, **todas as fotos** do bloco vao para a pasta desse protocolo
4. O timer de 30s **reseta** a cada nova mensagem - se o encanador continua enviando, o sistema espera

**Exemplo pratico:**
- Foto com legenda "2025001234" -> buffer
- Foto sem legenda -> buffer
- Foto sem legenda -> buffer
- Foto com legenda "2025001234" -> buffer
- *(30 segundos sem mensagem)*
- **Resultado:** Todas as 4 fotos salvas em `archive/{grupo}/2025001234/`

---

## Alertas

### Alertas em Tempo Real (WhatsApp DM)

O bot envia mensagem direta para o administrador quando:

| Evento | Icone | Descricao |
|---|---|---|
| Midia salva com sucesso | ✅ | Confirma quantas midias foram salvas e de quem |
| Erro ao salvar | ❌ | Falha ao salvar arquivo no disco |
| Protocolo fora do padrao | 🔢 | Numero de 10 digitos que nao comeca com 2025/2026 |
| Multiplas legendas | 📂 | Bloco com mais de um protocolo diferente |
| Sem legenda (timeout) | ⏱️ | Midias sem protocolo apos timeout |
| Grupo nao encontrado | ❌ | Grupo configurado mas nao acessivel |
| Disco cheio | 💾 | Espaco em disco abaixo de 2 GB |
| Drive indisponivel | ⚠️ | Drive X: nao acessivel no startup — informa se usou caminho reserva |

### Relatorio Diario (23:59)

Enviado automaticamente por DM e salvo em `archive/logs/`, contendo:

- **Resumo total:** quantidade de midias e AS do dia
- **Contagem por encanador:** quantas midias e AS cada um enviou
- **AS com menos de 3 fotos/videos:** lista de protocolos com poucas midias (possivel incompleto)
- **Alertas do dia:** todos os eventos registrados

---

## Estrutura de Pastas

```
archive/
├── Batedor Ambiental/
│   ├── 2025001234/                          # AS valido - fotos organizadas
│   │   ├── 2026-02-13_14-30_Joao_001.jpg
│   │   ├── 2026-02-13_14-30_Joao_002.jpg
│   │   └── 2026-02-13_14-31_Joao_003.mp4
│   ├── 2025005678/                          # Outro AS
│   │   └── ...
│   ├── protocolo_revisar/                   # Protocolos fora do padrao
│   │   └── 1234567890/
│   │       └── ...
│   ├── sem_legenda/                         # Midias sem protocolo
│   │   ├── Joao/
│   │   │   └── ...
│   │   └── Maria/
│   │       ├── 2025001111_2025002222/       # Multiplos protocolos
│   │       │   ├── 2025001111/              # Subpasta referencia (vazia)
│   │       │   ├── 2025002222/              # Subpasta referencia (vazia)
│   │       │   └── foto1.jpg               # Midias ficam aqui
│   │       └── ...
│   └── 2026-02-13/
│       └── mensagens.jsonl                  # Log de texto do dia
├── Manutencao Rede AmbientalSEMASA/
│   └── ...
├── AGUA_TESTE_FEVEREIRO/
│   └── ...
└── logs/
    ├── 2026-02-13_relatorio.txt
    └── 2026-02-14_relatorio.txt
```

---

## Tipos de Arquivo Aceitos

| Tipo | Extensoes |
|---|---|
| Fotos | .jpg, .png, .webp |
| Videos | .mp4, .3gp, .mov |

Audio, documentos e figurinhas sao ignorados.

---

## Disponibilidade

- Roda **24/7** automaticamente via PM2
- Reinicia sozinho em caso de falha
- Inicia automaticamente quando o computador liga
- **Bloquear a tela (Win+L):** bot continua rodando
- **Suspender/hibernar:** bot para (configuracao atual: suspensao desativada)
- **Reinicio preventivo diario:** todo dia as 7:30 o bot reinicia automaticamente (limpeza de memoria)
- **Protecao contra travamento de memoria:** reinicia automaticamente se ultrapassar 400 MB de RAM

### Drive de Rede (X:)

O bot salva as midias no drive de rede `X:`. Se o drive nao estiver conectado quando o computador ligar:

1. O bot tenta reconectar ao drive por ate **1 minuto e meio** (3 tentativas de 30s)
2. Se o drive conectar nesse periodo, continua normalmente
3. Se nao conectar, **salva automaticamente em** `C:\Users\vinicius.oshima\Downloads\fotos-reserva`
4. Envia alerta no WhatsApp informando que esta usando o caminho reserva

Apos reconectar o drive X:, os arquivos salvos em `fotos-reserva` devem ser movidos manualmente para o local correto.

---

## Comandos de Gerenciamento

Abrir qualquer terminal (PowerShell ou CMD) e executar:

| Comando | O que faz |
|---|---|
| `pm2 status` | Ver se o bot esta rodando |
| `pm2 logs whatsapp-bila-organizer` | Ver logs em tempo real |
| `pm2 restart whatsapp-bila-organizer` | Reiniciar o bot |
| `pm2 stop whatsapp-bila-organizer` | Parar o bot |
| `pm2 monit` | Monitor de CPU/RAM |

---

## Requisitos do Sistema

- Windows 11
- Node.js instalado
- PM2 instalado globalmente
- Conexao com internet
- WhatsApp autenticado (sessao salva localmente)
- Suspensao automatica desativada

---

## Consumo de Recursos

| Recurso | Uso |
|---|---|
| RAM | ~80-150 MB (reinicia automaticamente se ultrapassar 400 MB) |
| CPU | ~0% (so processa quando chega mensagem) |
| Disco | Depende do volume de fotos/videos |

---

## Configuracoes (arquivo .env)

| Variavel | Valor Atual | Descricao |
|---|---|---|
| GROUPS | Batedor Ambiental, Manutencao Rede Ambiental/SEMASA, AGUA_TESTE_FEVEREIRO, TOPOGRAFIA | Grupos monitorados |
| ARCHIVE_DIR | X:\Contrato 005-2024\2026\02 - Fevereiro\...\FOTOS_SEM_AS | Pasta de destino principal (drive de rede) |
| ARCHIVE_FALLBACK_DIR | C:\Users\vinicius.oshima\Downloads\fotos-reserva | Pasta reserva se drive X: nao estiver disponivel |
| BUFFER_TIMEOUT_MS | 60000 | Tempo de espera apos ultima mensagem (60s) |
| ALERT_GROUP | LOGS_BOT | Grupo WhatsApp para receber alertas |
| DISK_WARN_GB | 2 | Alerta quando disco abaixo de X GB |
