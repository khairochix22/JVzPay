// PM2 process file for the AWS server (docs/DEPLOY-AWS.md §7).
//
//   pm2 start ecosystem.config.cjs      first start
//   pm2 restart jvzpay --update-env     after editing .env or pulling a new version
//   pm2 logs jvzpay                     live logs
//
// ONE process only (fork mode, instances: 1). The app runs its scheduler inside the process (lib/scheduler.js:
// payroll computation, HR pull, Inventory outbox poll, event delivery, audit sealing, daily backup). Two processes
// would run every job twice, so never use cluster mode or "pm2 scale" for JVzPay.
//
// PM2 runs index.js directly. index.js starts the server unconditionally (it has no "main module" check, which under
// PM2 would be false and make the app exit with code 0 in a restart loop). The settings come from .env (dotenv);
// NODE_ENV here only makes sure the production checks run even if .env forgets it.
module.exports = {
  apps: [
    {
      name: "jvzpay",
      cwd: __dirname,
      script: "index.js",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      // a start-up refusal (missing setting) exits at once: stop retrying after 10 quick failures instead of looping
      min_uptime: "20s",
      max_restarts: 10,
      exp_backoff_restart_delay: 2000,
      // index.js closes the server and the MySQL pool on SIGINT; give it time before PM2 kills it
      kill_timeout: 10000,
      max_memory_restart: "700M",
      time: true, // timestamps in the logs
      out_file: "~/.pm2/logs/jvzpay-out.log",
      error_file: "~/.pm2/logs/jvzpay-error.log",
      merge_logs: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
