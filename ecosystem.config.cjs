module.exports = {
  apps: [{
    name: 'whatsapp-bila-organizer',
    script: 'src/index.js',
    cwd: __dirname,
    restart_delay: 5000,
    max_restarts: 20,
    max_memory_restart: '400M',  // reinicia se vazar memória
    cron_restart: '30 7 * * *',  // reinicio preventivo todo dia às 7:30 (Brasília)
  }],
};
