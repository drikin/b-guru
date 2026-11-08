// PM2 ecosystem for BSM Portal (Next.js standalone on port 3000)
module.exports = {
  apps: [
    {
      name: "bsm-portal",
      cwd: "/home/ubuntu/bsm-portal",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
      },
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "1536M", // 400M では起動直後で 360MB・1〜2 時間で届き、毎日 6〜23 回再起動して部室の音声が全員切れていた（2026-11-08）
      autorestart: true,
    },
  ],
};
