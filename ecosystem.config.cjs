module.exports = {
  apps: [{
    name: 'whatsapp-bila-organizer',
    script: 'src/index.js',
    cwd: __dirname,
    restart_delay: 5000,
    max_restarts: 20,
    max_memory_restart: '400M',  // reinicia se vazar memória
    kill_timeout: 30000,         // aguarda 30s o processo anterior morrer antes de iniciar novo
  }],
};
