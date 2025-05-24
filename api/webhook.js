import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import https from 'https';

// Store user sessions in memory (for production use database)
const userSessions = {};

// Авторизованные пользователи
const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS ? 
  process.env.AUTHORIZED_USERS.split(',').map(id => parseInt(id.trim())) : 
  [];

console.log('✅ Authorized users loaded:', AUTHORIZED_USERS);

// Функция проверки авторизации
function isUserAuthorized(userId) {
  return AUTHORIZED_USERS.length === 0 || AUTHORIZED_USERS.includes(userId);
}

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

// Column headers for Google Sheets
const COLUMN_HEADERS = [
  'Date',
  'Client Name',
  'Room Type',
  'Location',
  'Goal',
  'Work Done',
  'Materials',
  'Features',
  'Drive Link'
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

// Функция отправки сообщения о неавторизованном доступе
async function sendUnauthorizedMessage(chatId, userId) {
  const message = `
🚫 *Access Denied*

Sorry, you are not authorized to use this bot.

This bot is restricted to authorized team members only. If you believe this is an error, please contact the administrator.

*Your User ID:* \`${userId}\`
  `;
  
  await sendMessage(chatId, message);
}

async function initializeGoogleSheets() {
  try {
    // Parse service account credentials from environment variables
    const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    
    // Create JWT client for authentication
    const serviceAccountAuth = new JWT({
      email: serviceAccountKey.client_email,
      key: serviceAccountKey.private_key,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
      ],
    });

    // Initialize document
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    
    console.log(`✅ Connected to Google Sheet: ${doc.title}`);
    
    // Get first sheet or create new one if it doesn't exist
    let sheet = doc.sheetsByIndex[0];
    if (!sheet) {
      sheet = await doc.addSheet({ title: 'Renovation Projects' });
      console.log('✅ Created new sheet: Renovation Projects');
    }
    
    // Check if column headers are set
    await sheet.loadHeaderRow();
    
    if (!sheet.headerValues || sheet.headerValues.length === 0) {
      // If table is empty, add headers
      await sheet.setHeaderRow(COLUMN_HEADERS);
      console.log('✅ Added headers to Google Sheet');
    }
    
    return sheet;
  } catch (error) {
    console.error('❌ Error initializing Google Sheets:', error);
    throw error;
  }
}

async function addRowToSheet(answers) {
  try {
    console.log('📝 Attempting to add row to Google Sheets...');
    const sheet = await initializeGoogleSheets();
    
    // Create new row with today's date and project data
    const newRow = {
      'Date': new Date().toLocaleDateString('en-US'),
      'Client Name': answers[0] || 'Not specified',
      'Room Type': answers[1] || 'Not specified',
      'Location': answers[2] || 'Not specified',
      'Goal': answers[3] || 'Not specified',
      'Work Done': answers[4] || 'Not specified',
      'Materials': answers[5] || 'Not specified',
      'Features': answers[6] || 'Not specified',
      'Drive Link': answers[7] || 'Not specified'
    };
    
    console.log('📊 Adding row:', newRow);
    
    // Add row to sheet
    await sheet.addRow(newRow);
    
    console.log('✅ Row added to Google Sheets successfully');
    return true;
  } catch (error) {
    console.error('❌ Error adding row to sheet:', error);
    console.error('Error details:', error.message);
    throw error;
  }
}

function validateDriveLink(link) {
  return link.includes('drive.google.com') || link.includes('docs.google.com');
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
📂 Drive: ${answers[7] || 'Not specified'}
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

export default async function handler(req, res) {
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
      
      // 🔐 ПРОВЕРКА АВТОРИЗАЦИИ
      if (!isUserAuthorized(userId)) {
        console.log(`🚫 Unauthorized access attempt by user ${userId}`);
        await makeApiCall('answerCallbackQuery', {
          callback_query_id: callbackQuery.id,
          text: "Access denied",
          show_alert: true
        });
        await sendUnauthorizedMessage(chatId, userId);
        return res.status(200).json({ ok: true });
      }
      
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
All data is processed securely and sent directly to project administrators and saved to Google Sheets.

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
    
    // 🔐 ПРОВЕРКА АВТОРИЗАЦИИ для всех команд
    if (!isUserAuthorized(userId)) {
      console.log(`🚫 Unauthorized access attempt by user ${userId}`);
      await sendUnauthorizedMessage(chatId, userId);
      return res.status(200).json({ ok: true });
    }
    
    // Set up bot commands only on first /start
    if (text === '/start') {
      await setupBotCommands();
    }
    
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

Need to go back to the main menu? Just type /start
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
        // Survey completed
        const answers = session.answers;
        
        console.log('✅ Survey completed, answers:', answers);
        
        // Validate Google Drive link if provided
        if (answers[7] && answers[7] !== 'Not specified' && !validateDriveLink(answers[7])) {
          await sendMessage(chatId, '❌ Please provide a valid Google Drive link. The link should contain "drive.google.com" or "docs.google.com".\n\nPlease send the Google Drive link again:');
          session.step--; // Go back to previous question
          return res.status(200).json({ ok: true });
        }
        
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
        
        try {
          // Save to Google Sheets
          console.log('📊 Attempting to save to Google Sheets...');
          await addRowToSheet(answers);
          console.log('✅ Successfully saved to Google Sheets');
          
          // Send notification to admin
          const adminChatId = process.env.ADMIN_CHAT_ID;
          if (adminChatId) {
            const notificationText = createAdminNotification(answers);
            await sendMessage(adminChatId, notificationText);
            console.log('✅ Admin notification sent');
          }
          
          // Confirmation
          await sendMessage(chatId, '🎉 *Project data successfully saved to Google Sheets!*\n\nThank you for your submission. The information has been sent to the project administrators and saved to our database.\n\n• Use /start to return to main menu\n• Use "🚀 Start New Survey" to submit another project', {
            reply_markup: { remove_keyboard: true }
          });
          
        } catch (error) {
          console.error('❌ Error saving to Google Sheets:', error);
          await sendMessage(chatId, '❌ Error saving data to Google Sheets. The survey data has been recorded but there was an issue with the database.\n\nPlease contact support or try again later.\n\nError: ' + error.message);
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
      // If user sends a message without active session, show menu
      await sendMessage(chatId, 'Hi! 👋 Use /start to see the main menu and available options.');
    }
    
    return res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    console.error('Error stack:', error.stack);
    return res.status(200).json({ error: 'Internal error', details: error.message, ok: false });
  }
}
