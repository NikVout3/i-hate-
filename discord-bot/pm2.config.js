module.exports = {
  apps: [
    {
      name: 'discord-bot',
      script: './bot.js',
      watch: true,
      ignore_watch: ['api.log'], // Ignore changes to api.log
      env: {
        NODE_ENV: 'development',
        DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
        PRODUCT_API_ENDPOINT: process.env.PRODUCT_API_ENDPOINT,
        API_SECRET: process.env.API_SECRET
      },
      env_production: {
        NODE_ENV: 'production',
        DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
        PRODUCT_API_ENDPOINT: process.env.PRODUCT_API_ENDPOINT,
        API_SECRET: process.env.API_SECRET
      }
    },
    {
      name: 'api-server',
      script: './api.js',
      watch: true,
      ignore_watch: ['api.log'], // Ignore changes to api.log
      env: {
        NODE_ENV: 'development',
        PORT: process.env.PORT || 3001
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3001
      }
    }
  ]
};
