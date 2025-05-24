// Improved test version with better error handling
export default async function handler(req, res) {
  // Log all requests
  console.log(`${new Date().toISOString()} - ${req.method} request received`);
  console.log('Headers:', JSON.stringify(req.headers));
  
  // Handle non-POST requests
  if (req.method !== 'POST') {
    console.log('Non-POST request, returning 200');
    return res.status(200).json({ message: 'This endpoint handles Telegram webhook events' });
  }

  try {
    console.log('Processing POST request');
    console.log('Request body:', JSON.stringify(req.body));
    
    const botToken = process.env.BOT_TOKEN;
    if (!botToken) {
      console.error('BOT_TOKEN not found in environment');
      return res.status(500).json({ error: 'Bot token not configured' });
    }
    
    const update = req.body;
    
    if (update && update.message && update.message.text === '/start') {
      const chatId = update.message.chat.id;
      console.log(`Responding to /start from chat: ${chatId}`);
      
      try {
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
        
        const responseData = await response.text();
        console.log('Telegram response:', responseData);
        
      } catch (fetchError) {
        console.error('Error sending message:', fetchError);
      }
    }
    
    // Always return 200 OK to Telegram
    console.log('Returning 200 OK to Telegram');
    return res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error('Webhook error:', error);
    // Still return 200 to prevent Telegram from retrying
    return res.status(200).json({ error: 'Internal error', ok: false });
  }
}
