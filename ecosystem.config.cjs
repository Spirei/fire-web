module.exports = {
  apps: [{
    name: process.env.FIRE_PM2_NAME || 'fire',
    cwd: __dirname,
    script: 'npm',
    args: 'run dev',
    interpreter: 'none',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    min_uptime: '10s',
    max_restarts: 5,
    restart_delay: 3000,
    kill_timeout: 10000,
    time: true,
  }],
};
