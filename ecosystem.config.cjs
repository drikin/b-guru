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
      max_memory_restart: "400M",
      autorestart: true,
    },
  ],
};
