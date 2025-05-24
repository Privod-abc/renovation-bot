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
  "✨ Were there any interesting features or smart solutions implemented? (e.g. round lighting, hidden drawers, custom panels)"
];

// ЛЕГКАЯ интеграция с Google Sheets
async function addRowToSheet(answers) {
  try {
    const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
    
    if (!APPS_SCRIPT_URL) {
      console.log('APPS_SCRIPT_URL not configured, skipping Google Sheets');
      return false;
    }
    
    const data = {
      date: new Date().toLocaleDateString('en-US'),
      client_name: answers[0] || 'Not specified',
      room_type: answers[1] || 'Not specified',
      location: answers[2] || 'Not specified',
      goal: answers[3] || 'Not specified',
      work_done: answers[4] || 'Not specified',
      materials: answers[5] || 'Not specified',
      features: answers[6] || 'Not specified'
    };
    
    const postData = JSON.stringify(data);
    const url = new URL(APPS_SCRIPT_URL);
    
    return new Promise((resolve) => {
      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };
      
      const req = https.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => responseData += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            console.log('✅ Row added to Google Sheets via Apps Script');
            resolve(true);
          } else {
            console.error('❌ Apps Script error:', responseData);
            resolve(false);
          }
        });
      });
      
      req.on('error', (error) => {
        console.error('❌ Request error:', error);
        resolve(false);
      });
      
      req.write(postData);
      req.end();
    });
    
  } catch (error) {
    console.error('❌ Error in addRowToSheet:', error);
    return false;
  }
}

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

function makeApiCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const botToken = process.env.BOT_TOKEN;
    const postData = JSON.stringify(params);
    
    const requestOptions = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${botToken}/${method}`,
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

async function setupBotCommands() {
  try {
    await makeApiCall('setMyCommands', {
      commands: [
        { command: 'start', description: '🏠 Show main menu' },
        { command: 'survey', description: '🚀 Start project survey' },
        { command: 'help', description: '❓ Show help information' },
        { command: 'cancel', description: '❌ Cancel current survey' }
      ]
    });
    console.log('✅ Bot commands menu set up successfully');
  } catch (error) {
    console.error('❌ Error setting up bot commands:', error);
  }
}

function createAdminNotification(answers) {
  return `
📢 New Project Submitted!
👤 Client: ${answers[0] || 'Not specified'}
🏗️ Room: ${answers[1] || 'Not specified'}
📍 Location: ${answers[2] || 'Not specified'}
🌟 Goal: ${answers[3] || 'Not specified'}
💪 Work done: ${answers[4] || 'Not specified'}
🧱 Materials: ${answers[5] || 'Not specified'}
✨ Features: ${answers[6] || 'Not specified'}
  `.trim();
}

function createMainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🚀 Start New Survey', callback_data: 'start_survey' }],
        [
          { text: '❓ Help & Info', callback_data: 'show_help' },
          { text: '📊 About Bot', callback_data: 'about_bot' }
        ]
      ]
    }
  };
}

async function showMainMenu(chatId) {
  const welcomeText = `
🏠 *Welcome to Renovation Project Bot!*

I help collect information about completed renovation projects for content creation, CRM management, and business analytics.

*Choose an option below to get started:*
  `;
  
  await sendMessage(chatId, welcomeText, createMainMenu());
}

module.exports = async (req, res) => {
  console.log(`${new Date().toISOString()} - ${req.method} request received`);
  
  if (req.method !== 'POST') {
    return res.status(200).json({ message: 'This endpoint handles Telegram webhook events' });
  }

  try {
    const update = req.body;
    console.log('📨 Received update:', JSON.stringify(update, null, 2));
    
    // Handle callback queries (inline button presses)
    if (update.callback_query) {
      const callbackQuery = update.callback_query;
      const chatId = callbackQuery.message.chat.id;
      const userId = callbackQuery.from.id;
      const data = callbackQuery.data;
      
      console.log(`🔘 Callback query from ${userId}: ${data}`);
      
      await makeApiCall('answerCallbackQuery', {
        callback_query_id: callbackQuery.id
      });
      
      if (data === 'start_survey') {
        userSessions[userId] = { step: 0, answers: [] };
        console.log('✅ Created session for user:', userId, userSessions[userId]);
        
        await sendMessage(chatId, '📝 *Starting Project Survey*\n\nI will guide you through 7 questions about your completed renovation project.\n\nLet\'s begin!');
        
        await sendMessage(chatId, questions[0], {
          reply_markup: {
            keyboard: [[{ text: 'Skip this question ⏭️' }]],
            resize_keyboard: true
          }
        });
      } else if (data === 'show_help') {
        const helpText = `
*❓ How to Use This Bot*

*Available Commands:*
- /start - Show main menu
- /survey - Start project survey directly  
- /help - Show this help
- /cancel - Cancel current survey

*Survey Process:*
1️⃣ Click "🚀 Start New Survey"
2️⃣ Answer 7 questions about your project
3️⃣ Skip questions with "⏭️" button if needed
4️⃣ Get summary and confirmation

Use /start anytime to return to the main menu.
        `;
        await sendMessage(chatId, helpText);
      } else if (data === 'about_bot') {
        const aboutText = `
*📊 About Renovation Project Bot*

*Purpose:*
This bot streamlines the collection of renovation project information for business use.

*Data Collection:*
- 🏠 Project details (client, location, room)
- 🔧 Work scope and materials
- ✨ Special features and solutions

*Business Benefits:*
- 📝 Content creation for marketing
- 📊 CRM and database management
- 🎬 Video script generation
- 📈 Project analytics and reporting

Ready to submit a project? Use /start to return to the main menu.
        `;
        await sendMessage(chatId, aboutText);
      }
      
      return res.status(200).json({ ok: true });
    }
    
    if (!update.message) {
      console.log('❌ No message in update');
      return res.status(200).json({ ok: true });
    }
    
    const chatId = update.message.chat.id;
    const text = update.message.text;
    const userId = update.message.from.id;
    
    console.log(`💬 Message from ${userId}: ${text}`);
    console.log('📊 Current sessions:', Object.keys(userSessions));
    console.log('🔍 User session exists:', !!userSessions[userId]);
    
    if (text === '/start') {
      await setupBotCommands();
      await showMainMenu(chatId);
      return res.status(200).json({ ok: true });
    }
    
    if (text === '/survey') {
      userSessions[userId] = { step: 0, answers: [] };
      console.log('✅ Created session for user:', userId, userSessions[userId]);
      
      await sendMessage(chatId, '📝 *Starting Project Survey*\n\nI will guide you through 7 questions about your completed renovation project.\n\nLet\'s begin!');
      
      await sendMessage(chatId, questions[0], {
        reply_markup: {
          keyboard: [[{ text: 'Skip this question ⏭️' }]],
          resize_keyboard: true
        }
      });
      
      return res.status(200).json({ ok: true });
    }
    
    if (text === '/help') {
      const helpText = `
*❓ Renovation Project Bot Help*

Use /start to see the main menu with all options.

*Quick Commands:*
- /start - Main menu
- /survey - Start survey directly
- /cancel - Cancel current survey

During surveys, you can skip questions using the "Skip this question ⏭️" button.

Need to go back to the main menu? Just type /start
      `;
      await sendMessage(chatId, helpText);
      return res.status(200).json({ ok: true });
    }
    
    if (text === '/cancel') {
      delete userSessions[userId];
      await sendMessage(chatId, '❌ Survey cancelled.\n\nUse /start to return to the main menu.', {
        reply_markup: { remove_keyboard: true }
      });
      return res.status(200).json({ ok: true });
    }
    
    // Handle survey responses
    if (userSessions[userId]) {
      const session = userSessions[userId];
      
      console.log(`📝 Survey response from ${userId}, step ${session.step}: ${text}`);
      
      // Save answer
      if (text === 'Skip this question ⏭️') {
        session.answers[session.step] = 'Not specified';
      } else {
        session.answers[session.step] = text;
      }
      
      session.step++;
      
      // Check if survey is complete
      if (session.step >= questions.length) {
        const answers = session.answers;
        
        const summaryMessage = `
*✅ Project Survey Completed!*

*Summary of submitted project:*
👤 Client: ${answers[0]}
🏗️ Room: ${answers[1]}
📍 Location: ${answers[2]}
🌟 Goal: ${answers[3]}
💪 Work done: ${answers[4]}
🧱 Materials: ${answers[5]}
✨ Features: ${answers[6]}

Thank you for your submission!

• Use /start to return to main menu
• Use "🚀 Start New Survey" to submit another project
        `;
        
        await sendMessage(chatId, summaryMessage, {
          reply_markup: { remove_keyboard: true }
        });
        
        // Save to Google Sheets (non-blocking)
        addRowToSheet(answers).then(success => {
          if (success) {
            console.log('✅ Data saved to Google Sheets');
          } else {
            console.log('⚠️ Failed to save to Google Sheets');
          }
        });
        
        // Send notification to admin
        const adminChatId = process.env.ADMIN_CHAT_ID;
        if (adminChatId) {
          const notificationText = createAdminNotification(answers);
          await sendMessage(adminChatId, notificationText);
          console.log('✅ Admin notification sent to:', adminChatId);
        }
        
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
        
        await sendMessage(chatId, nextQuestion, options);
      }
    } else {
      console.log('❌ No session found for user:', userId);
      await sendMessage(chatId, 'Hi! 👋 Use /start to see the main menu and available options.');
    }
    
    return res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    console.error('Error stack:', error.stack);
    return res.status(200).json({ error: 'Internal error', details: error.message, ok: false });
  }
};
