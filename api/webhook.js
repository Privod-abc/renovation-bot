import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { Redis } from '@upstash/redis';
import https from 'https';

// Инициализация Redis
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Авторизованные пользователи
const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS ? 
  process.env.AUTHORIZED_USERS.split(',').map(id => parseInt(id.trim())) : 
  [];

console.log('✅ Authorized users loaded:', AUTHORIZED_USERS.length);
console.log('🔴 Redis initialized');

// Функция проверки авторизации
function isUserAuthorized(userId) {
  if (AUTHORIZED_USERS.length === 0) return true;
  return AUTHORIZED_USERS.includes(userId);
}

// Questions in the survey (УБРАЛИ 8-й ВОПРОС)
const questions = [
  "🙋‍♂️ What is the client's name?",
  "🏗️ What room did you work on? (e.g. kitchen, bathroom, laundry room)",
  "📍 In which city and state was this project completed?",
  "🌟 What was the client's goal for this space? (e.g. modernize layout, fix poor lighting, update style, old renovation, etc.)",
  "💪 What work was done during the remodel?",
  "🧱 What materials were used? (Include names, colors, manufacturers if possible)",
  "✨ Were there any interesting features or smart solutions implemented? (e.g. round lighting, hidden drawers, custom panels)"
];

// Column headers for Google Sheets (УБРАЛИ Drive Link)
const COLUMN_HEADERS = [
  'Date',
  'Client Name',
  'Room Type',
  'Location',
  'Goal',
  'Work Done',
  'Materials',
  'Features',
  'Drive Folder'
];

// ✨ REDIS ФУНКЦИИ ДЛЯ СЕССИЙ

async function getSession(userId) {
  try {
    console.log(`🔍 Getting session for user ${userId}`);
    const session = await redis.get(`session_${userId}`);
    console.log(`📋 Session data:`, session);
    return session;
  } catch (error) {
    console.error('❌ Error getting session:', error);
    return null;
  }
}

async function saveSession(userId, step, answers) {
  try {
    console.log(`💾 Saving session for user ${userId}, step ${step}`);
    const sessionData = { step, answers, timestamp: Date.now() };
    
    // Сохраняем на 1 час (3600 секунд)
    await redis.set(`session_${userId}`, sessionData, { ex: 3600 });
    console.log(`✅ Session saved successfully`);
    return true;
  } catch (error) {
    console.error('❌ Error saving session:', error);
    return false;
  }
}

async function deleteSession(userId) {
  try {
    console.log(`🗑️ Deleting session for user ${userId}`);
    await redis.del(`session_${userId}`);
    console.log(`✅ Session deleted successfully`);
    return true;
  } catch (error) {
    console.error('❌ Error deleting session:', error);
    return false;
  }
}

// 🗂️ GOOGLE DRIVE ФУНКЦИИ

async function createProjectFolder(clientName, roomType, location) {
  try {
    console.log('📁 Creating Google Drive folder...');
    
    const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const serviceAccountAuth = new JWT({
      email: serviceAccountKey.client_email,
      key: serviceAccountKey.private_key,
      scopes: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive'
      ],
    });

    // Получаем токен доступа
    const token = await serviceAccountAuth.getAccessToken();
    
    // Создаем имя папки
    const date = new Date().toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',  
      year: 'numeric'
    });
    const folderName = `${clientName} - ${roomType} - ${date}`;
    
    // Создаем главную папку
    const mainFolderData = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [process.env.PARENT_FOLDER_ID] // ID родительской папки из переменных
    };
    
    const mainFolder = await createDriveFolder(mainFolderData, token.token);
    console.log('✅ Main folder created:', mainFolder.name);
    
    // Создаем подпапки
    const subfolders = ['Before', 'After', '3D Visualization', 'Floor Plans'];
    const createdSubfolders = [];
    
    for (const subfolderName of subfolders) {
      const subfolderData = {
        name: subfolderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [mainFolder.id]
      };
      
      const subfolder = await createDriveFolder(subfolderData, token.token);
      createdSubfolders.push(subfolder);
      console.log(`✅ Subfolder created: ${subfolder.name}`);
    }
    
    // Устанавливаем права доступа (просмотр для всех по ссылке)
    await setFolderPermissions(mainFolder.id, token.token);
    
    const folderUrl = `https://drive.google.com/drive/folders/${mainFolder.id}`;
    console.log('🔗 Folder URL:', folderUrl);
    
    return {
      folderId: mainFolder.id,
      folderName: folderName,
      folderUrl: folderUrl,
      subfolders: createdSubfolders
    };
    
  } catch (error) {
    console.error('❌ Error creating Google Drive folder:', error);
    throw error;
  }
}

async function createDriveFolder(folderData, accessToken) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(folderData);
    
    const options = {
      hostname: 'www.googleapis.com',
      port: 443,
      path: '/drive/v3/files',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Drive API error: ${res.statusCode} - ${data}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function setFolderPermissions(folderId, accessToken) {
  return new Promise((resolve, reject) => {
    const permissionData = {
      role: 'reader',
      type: 'anyone'
    };
    
    const postData = JSON.stringify(permissionData);
    
    const options = {
      hostname: 'www.googleapis.com',
      port: 443,
      path: `/drive/v3/files/${folderId}/permissions`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Permissions API error: ${res.statusCode} - ${data}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
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

async function initializeGoogleSheets() {
  try {
    const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    
    const serviceAccountAuth = new JWT({
      email: serviceAccountKey.client_email,
      key: serviceAccountKey.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    
    console.log(`Connected to Google Sheet: ${doc.title}`);
    
    let sheet = doc.sheetsByIndex[0];
    if (!sheet) {
      sheet = await doc.addSheet({ title: 'Renovation Projects' });
      console.log('Created new sheet: Renovation Projects');
    }
    
    await sheet.loadHeaderRow();
    
    if (!sheet.headerValues || sheet.headerValues.length === 0) {
      await sheet.setHeaderRow(COLUMN_HEADERS);
      console.log('Added headers to Google Sheet');
    }
    
    return sheet;
  } catch (error) {
    console.error('Error initializing Google Sheets:', error);
    throw error;
  }
}

async function addRowToSheet(answers, driveFolder) {
  try {
    console.log('Attempting to add row to Google Sheets...');
    const sheet = await initializeGoogleSheets();
    
    const newRow = {
      'Date': new Date().toLocaleDateString('en-US'),
      'Client Name': answers[0] || 'Not specified',
      'Room Type': answers[1] || 'Not specified',
      'Location': answers[2] || 'Not specified',
      'Goal': answers[3] || 'Not specified',
      'Work Done': answers[4] || 'Not specified',
      'Materials': answers[5] || 'Not specified',
      'Features': answers[6] || 'Not specified',
      'Drive Folder': driveFolder ? driveFolder.folderUrl : 'Not created'
    };
    
    console.log('Adding row:', newRow);
    
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
    console.log('🔧 Setting up bot commands...');
    
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

function createAdminNotification(answers, driveFolder) {
  return `
📢 New Project Submitted!
👤 Client: ${answers[0] || 'Not specified'}
🏗️ Room: ${answers[1] || 'Not specified'}
📍 Location: ${answers[2] || 'Not specified'}
🌟 Goal: ${answers[3] || 'Not specified'}
💪 Work done: ${answers[4] || 'Not specified'}
🧱 Materials: ${answers[5] || 'Not specified'}
✨ Features: ${answers[6] || 'Not specified'}
📁 Folder: ${driveFolder ? driveFolder.folderUrl : 'Not created'}
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

async function processCompletedSurvey(chatId, userId, answers) {
  try {
    console.log('✅ Survey completed, answers:', answers);
    
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

Creating Google Drive folder and saving data...
    `;
    
    await sendMessage(chatId, summaryMessage);
    
    try {
      // Создаем Google Drive папку
      console.log('📁 Creating Google Drive folder...');
      const driveFolder = await createProjectFolder(
        answers[0] || 'Unknown Client',
        answers[1] || 'Unknown Room', 
        answers[2] || 'Unknown Location'
      );
      
      // Save to Google Sheets
      console.log('Attempting to save to Google Sheets...');
      await addRowToSheet(answers, driveFolder);
      console.log('Successfully saved to Google Sheets');
      
      // Send notification to admin
      const adminChatId = process.env.ADMIN_CHAT_ID;
      if (adminChatId) {
        const notificationText = createAdminNotification(answers, driveFolder);
        await sendMessage(adminChatId, notificationText);
        console.log('Admin notification sent');
      }
      
      // Confirmation with Drive folder link
      await sendMessage(chatId, `🎉 *Project data successfully processed!*

✅ Data saved to Google Sheets
📁 Google Drive folder created: **${driveFolder.folderName}**

🔗 **Folder Link:** ${driveFolder.folderUrl}

**Folder Structure:**
📁 ${driveFolder.folderName}
├── 📁 Before
├── 📁 After  
├── 📁 3D Visualization
└── 📁 Floor Plans

Upload your project files to the appropriate folders!

• Use /start to return to main menu
• Use "🚀 Start New Survey" to submit another project`, {
        reply_markup: { remove_keyboard: true }
      });
      
    } catch (error) {
      console.error('Error in post-processing:', error);
      await sendMessage(chatId, `❌ Error processing project data: ${error.message}\n\nPlease contact support or try again later.`);
    }
    
    // Удаляем сессию из Redis
    await deleteSession(userId);
    
  } catch (error) {
    console.error('Error processing completed survey:', error);
    await sendMessage(chatId, '❌ Error processing survey. Please try again later.');
  }
}

export default async function handler(req, res) {
  console.log(`${new Date().toISOString()} - ${req.method} request received`);
  
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
      
      console.log(`Callback query from ${userId}: ${data}`);
      
      // ПРОВЕРКА АВТОРИЗАЦИИ
      if (!isUserAuthorized(userId)) {
        await makeApiCall('answerCallbackQuery', {
          callback_query_id: callbackQuery.id,
          text: "Access denied",
          show_alert: true
        });
        await sendMessage(chatId, `🚫 Access denied. Your ID: ${userId}`);
        return res.status(200).json({ ok: true });
      }
      
      // Answer callback query to remove loading state
      await makeApiCall('answerCallbackQuery', {
        callback_query_id: callbackQuery.id
      });
      
      if (data === 'start_survey') {
        // Создаем новую сессию в Redis
        await saveSession(userId, 0, []);
        
        await sendMessage(chatId, '📝 *Starting Project Survey*\n\nI will guide you through 7 questions about your completed renovation project. You can skip any question if needed.\n\nLet\'s begin!');
        
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
4️⃣ Get summary and Google Drive folder link

*Questions Asked:*
- Client name
- Room type (kitchen, bathroom, etc.)
- Location (city, state)
- Client's goals
- Work completed
- Materials used
- Special features

*After completion:*
- Automatic Google Drive folder creation
- Folder with 4 subfolders (Before, After, 3D, Floor Plans)
- Shareable link for file uploads

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

*Automation:*
- 📁 Automatic Google Drive folder creation
- 📊 Data saved to Google Sheets
- 🔗 Instant shareable links

*Business Benefits:*
- 📝 Content creation for marketing
- 📊 CRM and database management
- 🎬 Video script generation
- 📈 Project analytics and reporting
- 🗂️ Organized file management

*Security:*
All data is processed securely and sent directly to project administrators.

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
    
    // ПРОВЕРКА АВТОРИЗАЦИИ  
    if (!isUserAuthorized(userId)) {
      await sendMessage(chatId, `🚫 Access denied. Your ID: ${userId}`);
      return res.status(200).json({ ok: true });
    }
    
    // Handle /start command - show menu immediately
    if (text === '/start') {
      console.log('🚀 Processing /start command...');
      
      try {
        // Настройка команд БЕЗ блокировки основного потока
        setupBotCommands().catch(err => {
          console.error('❌ setupBotCommands failed:', err);
        });
        
        // Показываем меню СРАЗУ, не ждем setupBotCommands
        await showMainMenu(chatId);
        console.log('✅ Main menu sent successfully');
        
      } catch (error) {
        console.error('❌ Error in /start handler:', error);
        
        // Запасной вариант - простое сообщение
        await sendMessage(chatId, '🏠 Welcome! Use /start again to see the menu.');
      }
      
      return res.status(200).json({ ok: true });
    }
    
    // Handle /survey command - start survey directly
    if (text === '/survey') {
      // Создаем новую сессию в Redis
      await saveSession(userId, 0, []);
      
      await sendMessage(chatId, '📝 *Starting Project Survey*\n\nI will guide you through 7 questions about your completed renovation project. You can skip any question if needed.\n\nLet\'s begin!');
      
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

After completing the survey, you'll receive a Google Drive folder link for uploading project files.

Need to go back to the main menu? Just type /start
      `;
      
      await sendMessage(chatId, helpText);
      return res.status(200).json({ ok: true });
    }
    
    // Handle /cancel command
    if (text === '/cancel') {
      await deleteSession(userId);
      await sendMessage(chatId, '❌ Survey cancelled.\n\nUse /start to return to the main menu.', {
        reply_markup: { remove_keyboard: true }
      });
      return res.status(200).json({ ok: true });
    }
    
    // Handle survey responses - ИСПОЛЬЗУЕМ REDIS СЕССИИ
    const session = await getSession(userId);
    
    if (session) {
      console.log(`📋 Found Redis session: step ${session.step}`);
      
      // Сохраняем ответ
      let answer = text;
      if (text === 'Skip this question ⏭️') {
        answer = 'Not specified';
      }
      
      session.answers[session.step] = answer;
      session.step++;
      
      // Проверяем завершен ли опрос (ТЕПЕРЬ 7 ВОПРОСОВ)
      if (session.step >= questions.length) {
        // Опрос завершен
        await processCompletedSurvey(chatId, userId, session.answers);
      } else {
        // Сохраняем обновленное состояние в Redis и задаем следующий вопрос
        await saveSession(userId, session.step, session.answers);
        
        await sendMessage(chatId, questions[session.step], {
          reply_markup: {
            keyboard: [[{ text: 'Skip this question ⏭️' }]],
            resize_keyboard: true
          }
        });
      }
    } else {
      // Нет активной сессии
      await sendMessage(chatId, 'Hi! 👋 Use /start to see the main menu and available options.');
    }
    
    return res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error('Webhook error:', error);
    console.error('Error stack:', error.stack);
    return res.status(200).json({ ok: true });
  }
}
