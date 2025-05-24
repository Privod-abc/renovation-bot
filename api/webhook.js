// Simple test version for diagnostics
export default async function handler(req, res) {
  console.log('Webhook called with method:', req.method);
  console.log('Request body:', JSON.stringify(req.body));

  if (req.method !== 'POST') {
    return res.status(200).json({ message: 'This endpoint handles Telegram webhook events' });
  }

  try {
    // Simple response to test if webhook works
    const botToken = process.env.BOT_TOKEN;
    const update = req.body;
    
    if (update.message && update.message.text === '/start') {
      const chatId = update.message.chat.id;
      
      // Send simple response
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: '🤖 Bot is working! This is a test response.'
        })
      });
      
      console.log('Response sent:', await response.text());
    }
    
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ e
