module.exports = {
  apps: [{
    name: 'whatsapp-bila-organizer',
    script: 'src/index.js',
    cwd: __dirname,
    restart_delay: 5000,
    max_restarts: 20,
  }],
};
