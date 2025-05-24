import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { google } from 'googleapis';
import https from 'https';

// Authorized user IDs
const AUTHORIZED_USERS = [130060469, 2038732914, 5914538333, 5912713042];

// Parent folder ID for client projects
const PARENT_FOLDER_ID = '1EHERFLB3b8obfdFFzxqsrqyp5llXYk6z';

// Store user sessions in memory (for production use database)
const userSessions = {};

// Questions in the survey (removed Google Drive question)
const questions = [
  "🙋‍♂️ What is the client's name?",
  "🏗️ What room did you work on? (e.g. kitchen, bathroom, laundry room)",
  "📍 In which city and state was this project completed?",
  "🌟 What was the client's goal for this space? (e.g. modernize layout, fix poor lighting, update style, old renovation, etc.)",
  "💪 What work was done during the remodel?",
  "🧱 What materials were used? (Include names, colors, manufacturers if possible)",
  "✨ Were there any interesting features or smart solutions implemented? (e.g. round lighting, hidden drawers, custom panels)"
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
    
    console.log(`Connected to Google Sheet: ${doc.title}`);
    
    // Get first sheet or create new one if it doesn't exist
    let sheet = doc.sheetsByIndex[0];
    if (!sheet) {
      sheet = await doc.addSheet({ title: 'Renovation Projects' });
      console.log('Created new sheet: Renovation Projects');
    }
    
    // Check if column headers are set
    await sheet.loadHeaderRow();
    
    if (!sheet.headerValues || sheet.headerValues.length === 0) {
      // If table is empty, add headers
      await sheet.setHeaderRow(COLUMN_HEADERS);
      console.log('Added headers to Google Sheet');
    }
    
    return sheet;
  } catch (error) {
    console.error('Error initializing Google Sheets:', error);
    throw error;
  }
}

async function createClientFolder(clientName, roomType) {
  try {
    console.log('Creating client folder on Google Drive...');
    
    // Parse service account credentials
    const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    
    // Create JWT client for Google Drive API
    const auth = new JWT({
      email: serviceAccountKey.client_email,
      key: serviceAccountKey.private_key,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    
    // Initialize Google Drive API
    const drive = google.drive({ version: 'v3', auth });
    
    // Create main project folder name
    const currentDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).replace(/\//g, '-');
    
    const folderName = `${clientName} - ${roomType} - ${currentDate}`;
    
    console.log(`Creating folder: ${folderName}`);
    
    // Create main project folder
    const mainFolder = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [PARENT_FOLDER_ID]
      }
    });
    
    const mainFolderId = mainFolder.data.id;
    console.log(`Main folder created with ID: ${mainFolderId}`);
    
    // Create subfolders
    const subfolders = ['Before', 'After', '3D visualization', 'Floor plans'];
    
    for (const subfolderName of subfolders) {
      await drive.files.create({
        requestBody: {
          name: subfolderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [mainFolderId]
        }
      });
      console.log(`Created subfolder: ${subfolderName}`);
    }
    
    // Generate shareable link
    const driveLink = `https://drive.google.com/drive/folders/${mainFolderId}`;
    
    console.log(`Folder structure created successfully: ${driveLink}`);
    return driveLink;
    
  } catch (error) {
    console.error('Error creating client folder:', error);
    throw error;
  }
}

async function addRowToSheet(answers, driveLink) {
  try {
    console.log('Attempting to add row to Google Sheets...');
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
      'Drive Link': driveLink || 'Not specified'
    };
    
    console.log('Adding row:', newRow);
    
    // Add row to sheet
    await sheet.addRow(newRow);
    
    console.log('Row added to Google Sheets successfully');
    return true;
  } catch (error) {
    console.error('Error adding row to sheet:', error);
    console.error('Error details:', error.message);
    throw error;
  }
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

function createAdminNotification(answers, driveLink) {
  return `
📢 New Project Submitted!
👤 Client: ${answers[0] || 'Not specified'}
🏗️ Room: ${answers[1] || 'Not specified'}
📍 Location: ${answers[2] || 'Not specified'}
🌟 Goal: ${answers[3] || 'Not specified'}
💪 Work done: ${answers[4] || 'Not specified'}
🧱 Materials: ${answers[5] || 'Not specified'}
✨ Features: ${answers[6] || 'Not specified'}
📂 Drive: ${driveLink || 'Not specified'}
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

I help collect information about completed renovation projects and automatically create organized Google Drive folders for each project.

*Choose an option below to get started:*
  `;
  
  await sendMessage(chatId, welcomeText, createMainMenu());
}

function checkUserAuthorization(userId) {
  return AUTHORIZED_USERS.includes(userId);
}

export default async function handler(req, res) {
  console.log(`${new Date().toISOString()} - ${req.method} request received`);
  
  if (req.method !== 'POST') {
    return res.status(200).json({ message: 'This endpoint handles Telegram webhook events' });
  }

  try {
    const botToken = process.env.BOT_TOKEN;
    const update = req.body;
    
    console.log('Received update:', JSON.stringify(update, null, 2));
    
    // Handle callback queries (inline button presses)
    if (update.callback_query) {
      const callbackQuery = update.callback_query;
      const chatId = callbackQuery.message.chat.id;
      const userId = callbackQuery.from.id;
      const data = callbackQuery.data;
      
      console.log(`Callback query from ${userId}: ${data}`);
      
      // Check authorization
      if (!checkUserAuthorization(userId)) {
        await makeApiCall('answerCallbackQuery', {
          callback_query_id: callbackQuery.id,
          text: "❌ Access denied",
          show_alert: true
        });
        return res.status(200).json({ ok: true });
      }
      
      // Answer callback query to remove loading state
      await makeApiCall('answerCallbackQuery', {
        callback_query_id: callbackQuery.id
      });
      
      if (data === 'start_survey') {
        userSessions[userId] = { step: 0, answers: [] };
        
        await sendMessage(chatId, '📝 *Starting Project Survey*\n\nI will guide you through 7 questions about your completed renovation project. After completion, I will automatically create an organized Google Drive folder for this project.\n\nLet\'s begin!');
        
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
4️⃣ Bot automatically creates Google Drive folder
5️⃣ Get summary and confirmation

*Questions Asked:*
- Client name
- Room type (kitchen, bathroom, etc.)
- Location (city, state)
- Client's goals
- Work completed
- Materials used
- Special features

*Auto-Created Folder Structure:*
📁 [Client] - [Room] - [Date]
  ├── 📁 Before
  ├── 📁 After
  ├── 📁 3D visualization
  └── 📁 Floor plans

Use /start anytime to return to the main menu.
        `;
        
        await sendMessage(chatId, helpText);
        
      } else if (data === 'about_bot') {
        const aboutText = `
*📊 About Renovation Project Bot*

*Purpose:*
This bot streamlines the collection of renovation project information and automatically creates organized Google Drive folders.

*What It Does:*
- 🏠 Collects project details (client, location, room)
- 🔧 Records work scope and materials
- ✨ Documents special features and solutions
- 📁 **Automatically creates Google Drive folders**
- 📊 Saves all data to Google Sheets

*Business Benefits:*
- 📝 Organized project documentation
- 📊 Automated CRM and database management
- 🎬 Ready structure for content creation
- 📈 Project analytics and reporting

*Security:*
- 🔒 Access restricted to authorized team members only
- 🛡️ All data processed securely through Google APIs

*Authorized Users: ${AUTHORIZED_USERS.length} team members*

Ready to submit a project? Use /start to return to the main menu.
        `;
        
        await sendMessage(chatId, aboutText);
      }
      
      return res.status(200).json({ ok: true });
    }
    
    if (!update.message) {
      console.log('No message in update');
      return res.status(200).json({ ok: true });
    }
    
    const chatId = update.message.chat.id;
    const text = update.message.text;
    const userId = update.message.from.id;
    
    console.log(`Message from ${userId}: ${text}`);
    
    // Check authorization for all message types
    if (!checkUserAuthorization(userId)) {
      await sendMessage(chatId, '❌ *Access Denied*\n\nThis bot is restricted to authorized team members only.\n\nIf you believe you should have access, please contact the administrator.', {
        parse_mode: 'Markdown'
      });
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
      
      await sendMessage(chatId, '📝 *Starting Project Survey*\n\nI will guide you through 7 questions about your completed renovation project. After completion, I will automatically create an organized Google Drive folder for this project.\n\nLet\'s begin!');
      
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

The bot will automatically create a Google Drive folder after completing the survey.

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
      
      console.log(`Survey response from ${userId}, step ${session.step}: ${text}`);
      
      // Save answer
      if (text === 'Skip this question ⏭️') {
        session.answers[session.step] = 'Not specified';
      } else {
        session.answers[session.step] = text;
      }
      
      session.step++;
      
      // Check if survey is complete (now 7 questions instead of 8)
      if (session.step >= questions.length) {
        // Survey completed - start folder creation process
        const answers = session.answers;
        const clientName = answers[0] || 'Unknown Client';
        const roomType = answers[1] || 'Unknown Room';
        
        console.log('Survey completed, answers:', answers);
        
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

🔄 *Creating Google Drive folder...*
Please wait while I organize your project files.
        `;
        
        await sendMessage(chatId, summaryMessage);
        
        try {
          // Create Google Drive folder
          console.log('Creating Google Drive folder...');
          await sendMessage(chatId, '📁 Creating project folder structure:\n📂 Before\n📂 After\n📂 3D visualization\n📂 Floor plans\n\n⏳ This may take a few seconds...');
          
          const driveLink = await createClientFolder(clientName, roomType);
          console.log('Google Drive folder created:', driveLink);
          
          // Save to Google Sheets with Drive link
          console.log('Saving to Google Sheets...');
          await addRowToSheet(answers, driveLink);
          console.log('Successfully saved to Google Sheets');
          
          // Send notification to admin
          const adminChatId = process.env.ADMIN_CHAT_ID;
          if (adminChatId) {
            const notificationText = createAdminNotification(answers, driveLink);
            await sendMessage(adminChatId, notificationText);
            console.log('Admin notification sent');
          }
          
          // Final confirmation with Drive link
          await sendMessage(chatId, `🎉 *Project Successfully Processed!*

✅ **Data saved to Google Sheets**
✅ **Google Drive folder created**

📂 **Your project folder:**
${driveLink}

The folder contains organized subfolders for:
• Before photos
• After photos  
• 3D visualization
• Floor plans

Thank you for your submission!

• Use /start to return to main menu
• Use "🚀 Start New Survey" to submit another project`, {
            reply_markup: { remove_keyboard: true }
          });
          
        } catch (error) {
          console.error('Error processing project:', error);
          await sendMessage(chatId, `❌ **Error Processing Project**

There was an issue creating the Google Drive folder or saving data.

**Error details:** ${error.message}

Please try again later or contact support.

• Use /start to return to main menu`, {
            reply_markup: { remove_keyboard: true }
          });
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
    console.error('Webhook error:', error);
    console.error('Error stack:', error.stack);
    return res.status(200).json({ error: 'Internal error', details: error.message, ok: false });
  }
}
