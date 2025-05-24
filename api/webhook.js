const https = require('https');
const querystring = require('querystring');

module.exports = async (req, res) => {
  // Log all requests for debugging
  console.log(`${new Date().toISOString()} - ${req.method} request`);
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
      console.error('BOT_TOKEN not found');
      return res.status(200).json({ error: 'Bot token not configured' });
    }
    
    const update = req.body;
    
    if (update && update.message && update.message.text === '/start') {
      const chatId = update.message.chat.id;
      console.log(`Responding to /start from chat: ${chatId}`);
      
      // Send message using native https module
      const postData = JSON.stringify({
        chat_id: chatId,
        text: '🤖 Bot is working! This is a test response from new code.'
      });
      
      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${botToken}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };
      
      const request = https.request(options, (response) => {
        let data = '';
        response.on('data', (chunk) => data += chunk);
        response.on('end', () => {
          console.log('Telegram response:', data);
        });
      });
      
      request.on('error', (error) => {
        console.error('Error sending message:', error);
      });
      
      request.write(postData);
      request.end();
    }
    
    // Always return 200 OK
    console.log('Returning 200 OK to Telegram');
    return res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(200).json({ error: 'Internal error', ok: false });
  }
};
