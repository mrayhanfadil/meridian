const path = require("path");

const repoRoot = __dirname;

module.exports = {
  apps: [
    {
      name: "meridian",
      script: path.join(repoRoot, "index.js"),
      cwd: repoRoot,
      interpreter: "node",
      interpreter_args: "--enable-source-maps",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      merge_logs: true,
      time: true,
      // Always start via this file (npm run pm2:start) so cwd + script path stay pinned to the repo.
      env: {
        NODE_ENV: "production",
        NODE_OPTIONS: "--max-old-space-size=1024",
        // DRY_RUN is read from user-config.json, not env. Uncomment to force-disable:
        // DRY_RUN: "true",
      },
      // Log files live in ~/.pm2/logs/ by default; pm2 logs meridian will tail them.
      out_file: path.join(repoRoot, "logs", "meridian-out.log"),
      error_file: path.join(repoRoot, "logs", "meridian-error.log"),
      log_file: path.join(repoRoot, "logs", "meridian-combined.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
