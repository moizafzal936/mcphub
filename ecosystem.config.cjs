// PM2 process definition: `npm run build && npx pm2 start ecosystem.config.cjs`
// One instance only: MCP SSE sessions and rate-limit counters live in process memory.
module.exports = {
  apps: [
    {
      name: 'mcphub',
      cwd: './packages/server',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      // Secrets (MCPHUB_ENCRYPTION_KEY etc.) come from the host environment, never this file.
      kill_timeout: 12000,
      max_restarts: 10,
      min_uptime: 5000,
      restart_delay: 2000,
    },
  ],
}
