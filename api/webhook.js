const https = require('https');

// Store user sessions in memory (for production use database)
const userSessions = {};

// Questions in the survey
const questions = [
  "🙋‍♂️ What is the client's name?",
  "🏗️ What room did you work on? (e.g. kitchen, bathroom, laundry room)",
  "📍 In which city and state was this project completed?",
  "🌟 What was the client's goal for this space? (e.g. modernize layout, fix poor lighting, update style, old renovation, etc.)",
  "💪 What work was done during the remodel?",
  "🧱 What materials were used? (Include names, colors, manufacturers if possible)",
  "✨ Were there any interesting features or smart solutions implemented? (e.g. round lighting, hidden drawers, custom panels)",
  "📂 Please paste the Google Drive folder link (with subfolders: before / after / 3D / drawings)"
];

function sendMessage(chatId, text, options = {}) {
  return new Promise((resolve, reject) => {
    const botToken = process.env.BOT_TOKEN;
    
    const postData = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: options.parse_mode || 'Markdown',
      reply_markup: options.reply_markup || {}
    });
    
    const requestOptions = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const request = https.request(requestOptions, (response) => {
      let data = '';
      response.on('data', (chunk) => data += chunk);
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          resolve({ ok: false, error: data });
        }
      });
    });
    
    request.on('error', reject);
    request.write(postData);
    request.end();
  });
}

function createAdminNotification(data) {
  return `
📢 New Project Submitted!
👤 Client: ${data[0] || 'Not specified'}
🏗️ Room: ${data[1] || 'Not specified'}
📍 Location: ${data[2] || 'Not specified'}
🌟 Goal: ${data[3] || 'Not specified'}
💪 Work done: ${data[4] || 'Not specified'}
🧱 Materials: ${data[5] || 'Not specified'}
✨ Features: ${data[6] || 'Not specified'}
📂 Drive: ${data[7] || 'Not specified'}
  `.trim();
}

module.exports = async (req, res) => {
  console.log(`${new Date().toISOString()} - ${req.method} request`);
  
  if (req.method !== 'POST') {
    return res.status(200).json({ message: 'This endpoint handles Telegram webhook events' });
  }

  try {
    const botToken = process.env.BOT_TOKEN;
    const update = req.body;
    
    if (!update.message) {
      return res.status(200).json({ ok: true });
    }
    
    const chatId = update.message.chat.id;
    const text = update.message.text;
    const userId = update.message.from.id;
    
    console.log(`Message from ${userId}: ${text}`);
    
    // Handle /start command
    if (text === '/start') {
      userSessions[userId] = { step: 0, answers: [] };
      
      await sendMessage(chatId, '👋 Welcome to the Renovation Project Bot! I will guide you through the process of submitting information about completed renovation projects.');
      
      setTimeout(async () => {
        await sendMessage(chatId, questions[0], {
          reply_markup: {
            keyboard: [[{ text: 'Skip this question ⏭️' }]],
            resize_keyboard: true
          }
        });
      }, 500);
      
      return res.status(200).json({ ok: true });
    }
    
    // Handle /help command
    if (text === '/help') {
      const helpText = `
*Renovation Project Bot Help*

This bot collects information about completed renovation projects.

*Available commands:*
/start - Start the survey
/help - Show this help message
/cancel - Cancel the current survey

During the survey, you can skip any question by clicking the "Skip this question ⏭️" button.
      `;
      
      await sendMessage(chatId, helpText);
      return res.status(200).json({ ok: true });
    }
    
    // Handle /cancel command
    if (text === '/cancel') {
      delete userSessions[userId];
      await sendMessage(chatId, 'Survey cancelled. Use /start to begin a new survey.', {
        reply_markup: { remove_keyboard: true }
      });
      return res.status(200).json({ ok: true });
    }
    
    // Handle survey responses
    if (userSessions[userId]) {
      const session = userSessions[userId];
      
      // Save answer
      if (text === 'Skip this question ⏭️') {
        session.answers[session.step] = 'Not specified';
      } else {
        session.answers[session.step] = text;
      }
      
      session.step++;
      
      // Check if survey is complete
      if (session.step >= questions.length) {
        // Survey completed
        const answers = session.answers;
        
        // Send summary
        const summaryMessage = `
*Summary of the submitted project:*
👤 Client: ${answers[0]}
🏗️ Room: ${answers[1]}
📍 Location: ${answers[2]}
🌟 Goal: ${answers[3]}
💪 Work done: ${answers[4]}
🧱 Materials: ${answers[5]}
✨ Features: ${answers[6]}
📂 Drive: ${answers[7]}

Processing your data...
        `;
        
        await sendMessage(chatId, summaryMessage);
        
        // Send notification to admin
        const adminChatId = process.env.ADMIN_CHAT_ID;
        if (adminChatId) {
          const notificationText = createAdminNotification(answers);
          await sendMessage(adminChatId, notificationText);
        }
        
        // Confirmation
        await sendMessage(chatId, '✅ Project data has been successfully saved! Thank you for your submission.', {
          reply_markup: { remove_keyboard: true }
        });
        
        delete userSessions[userId];
      } else {
        // Ask next question
        const nextQuestion = questions[session.step];
        const options = {
          reply_markup: {
            keyboard: [[{ text: 'Skip this question ⏭️' }]],
            resize_keyboard: true
          }
        };
        
        // Remove keyboard for last question (Google Drive link)
        if (session.step === questions.length - 1) {
          options.reply_markup = { remove_keyboard: true };
        }
        
        await sendMessage(chatId, nextQuestion, options);
      }
    }
    
    return res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(200).json({ error: 'Internal error', ok: false });
  }
};
