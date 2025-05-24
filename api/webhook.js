import { createBot } from '../lib/bot.js';

// Create bot instance
const bot = createBot();

// Function to setup webhook
async function setupWebhook() {
  try {
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) {
      console.error('WEBHOOK_URL not set in environment variables');
      return;
    }

    // Set webhook for the bot
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`Webhook set to ${webhookUrl}`);
  } catch (error) {
    console.error('Error setting webhook:', error);
  }
}

// In development mode, run bot in long polling mode
if (process.env.NODE_ENV === 'development') {
  bot.launch();
  console.log('Bot is running in development mode (long polling)');
  
  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
} else {
  // In production mode, setup webhook
  setupWebhook().catch(console.error);
}

// Handler for Vercel serverless function
export default async function handler(req, res) {
  try {
    // Check that the request is POST
    if (req.method !== 'POST') {
      res.status(200).json({ message: 'This endpoint handles Telegram webhook events' });
      return;
    }
    
    // Process webhook update
    await bot.handleUpdate(req.body);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error handling webhook:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
}
