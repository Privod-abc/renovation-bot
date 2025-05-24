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
    // Set up bot commands menu
    await makeApiCall('setMyCommands', {
      commands: [
        {
          command: 'start',
          description: '🏠 Show main menu'
        },
        {
          command: 'survey',
          description: '🚀 Start project survey'
        },
        {
          command: 'help',
          description: '❓ Show help information'
        },
        {
          command: 'cancel',
          description: '❌ Cancel current survey'
        }
      ]
    });
    
    console.log('Bot commands menu set up successfully');
  } catch (error) {
    console.error('Error setting up bot commands:', error);
  }
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

function createMainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🚀 Start New Survey', callback_data: 'start_survey' }
        ],
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
  console.log(`${new Date().toISOString()} - ${req.method} request`);
  
  if (req.method !== 'POST') {
    return res.status(200).json({ message: 'This endpoint handles Telegram webhook events' });
  }

  try {
    const botToken = process.env.BOT_TOKEN;
    const update = req.body;
    
    // Handle callback queries (inline button presses)
    if (update.callback_query) {
      const callbackQuery = update.callback_query;
      const chatId = callbackQuery.message.chat.id;
      const userId = callbackQuery.from.id;
      const data = callbackQuery.data;
      
      // Answer callback query to remove loading state
      await makeApiCall('answerCallbackQuery', {
        callback_query_id: callbackQuery.id
      });
      
      if (data === 'start_survey') {
        userSessions[userId] = { step: 0, answers: [] };
        
        await sendMessage(chatId, '📝 *Starting Project Survey*\n\nI will guide you through 8 questions about your completed renovation project. You can skip any question if needed.\n\nLet\'s begin!');
        
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
2️⃣ Answer 8 questions about your project
3️⃣ Skip questions with "⏭️" button if needed
4️⃣ Get summary and confirmation

*Questions Asked:*
- Client name
- Room type (kitchen, bathroom, etc.)
- Location (city, state)
- Client's goals
- Work completed
- Materials used
- Special features
- Google Drive folder link

Use /start anytime to return to the main menu.
        `;
        
        await sendMessage(chatId, helpText);
        
        // Show menu again after help
        setTimeout(() => {
          showMainMenu(chatId);
        }, 1000);
        
      } else if (data === 'about_bot') {
        const aboutText = `
*📊 About Renovation Project Bot*

*Purpose:*
This bot streamlines the collection of renovation project information for business use.

*Data Collection:*
- 🏠 Project details (client, location, room)
- 🔧 Work scope and materials
- ✨ Special features and solutions
- 📁 Media organization (Google Drive)

*Business Benefits:*
- 📝 Content creation for marketing
- 📊 CRM and database management
- 🎬 Video script generation
- 📈 Project analytics and reporting

*Security:*
All data is processed securely and sent directly to project administrators.

Ready to submit a project? Click "🚀 Start New Survey"
        `;
        
        await sendMessage(chatId, aboutText);
        
        // Show menu again after about
        setTimeout(() => {
          showMainMenu(chatId);
        }, 1000);
      }
      
      return res.status(200).json({ ok: true });
    }
    
    if (!update.message) {
      return res.status(200).json({ ok: true });
    }
    
    const chatId = update.message.chat.id;
    const text = update.message.text;
    const userId = update.message.from.id;
    
    console.log(`Message from ${userId}: ${text}`);
    
    // Set up bot commands on first interaction
    await setupBotCommands();
    
    // Handle /start command - show menu immediately
    if (text === '/start') {
      await showMainMenu(chatId);
      return res.status(200).json({ ok: true });
    }
    
    // Handle /survey command - start survey directly
    if (text === '/survey') {
      userSessions[userId] = { step: 0, answers: [] };
      
      await sendMessage(chatId, '📝 *Starting Project Survey*\n\nI will guide you through 8 questions about your completed renovation project. You can skip any question if needed.\n\nLet\'s begin!');
      
      await sendMessage(chatId, questions[0], {
        reply_markup: {
          keyboard: [[{ text: 'Skip this question ⏭️' }]],
          resize_keyboard: true
        }
      });
      
      return res.status(200).json({ ok: true });
    }
    
    // Handle /help command
    if (text === '/help') {
      const helpText = `
*❓ Renovation Project Bot Help*

Use /start to see the main menu with all options.

*Quick Commands:*
- /start - Main menu
- /survey - Start survey directly
- /cancel - Cancel current survey

During surveys, you can skip questions using the "Skip this question ⏭️" button.
      `;
      
      await sendMessage(chatId, helpText);
      return res.status(200).json({ ok: true });
    }
    
    // Handle /cancel command
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
*✅ Project Survey Completed!*

*Summary of submitted project:*
👤 Client: ${answers[0]}
🏗️ Room: ${answers[1]}
📍 Location: ${answers[2]}
🌟 Goal: ${answers[3]}
💪 Work done: ${answers[4]}
🧱 Materials: ${answers[5]}
✨ Features: ${answers[6]}
📂 Drive: ${answers[7]}

Processing and saving your data...
        `;
        
        await sendMessage(chatId, summaryMessage);
        
        // Send notification to admin
        const adminChatId = process.env.ADMIN_CHAT_ID;
        if (adminChatId) {
          const notificationText = createAdminNotification(answers);
          await sendMessage(adminChatId, notificationText);
        }
        
        // Confirmation with menu
        await sendMessage(chatId, '🎉 *Project data successfully saved!*\n\nThank you for your submission. The information has been sent to the project administrators.\n\nUse /start to return to the main menu or submit another project.', {
          reply_markup: { remove_keyboard: true }
        });
        
        delete userSessions[userId];
        
        // Show main menu again after completion
        setTimeout(() => {
          showMainMenu(chatId);
        }, 2000);
        
      } else {
        // Ask next question - KEEP SKIP BUTTON FOR ALL QUESTIONS
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
      // If user sends a message without active session, show menu
      await sendMessage(chatId, 'Hi! 👋 Use /start to see the main menu and available options.');
    }
    
    return res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(200).json({ error: 'Internal error', ok: false });
  }
};
