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

// Questions in the survey (7 ВОПРОСОВ) - С ПОДСКАЗКАМИ И ОГРАНИЧЕНИЯМИ
const questions = [
  "🙋‍♂️ What is the client's name?\n\n📏 Maximum 50 characters\n💡 Examples: John Smith, Maria Rodriguez, ABC Construction",                                    // 0 - ОБЯЗАТЕЛЬНЫЙ
  "🏗️ What room did you work on?\n\n📏 Maximum 30 characters\n💡 Enter only room names or list of rooms\n\nExamples: Kitchen, Living Room, Bathroom, House", // 1 - ОБЯЗАТЕЛЬНЫЙ  
  "📍 In which city and state was this project completed?",              // 2 - можно пропустить
  "🌟 What was the client's goal for this space?\n\nExamples: modernize layout, fix poor lighting, update style, old renovation, etc.", // 3
  "💪 What work was done during the remodel?",                           // 4
  "🧱 What materials were used?\n\nInclude names, colors, manufacturers if possible", // 5
  "✨ Were there any interesting features or smart solutions implemented?\n\nExamples: round lighting, hidden drawers, custom panels" // 6
];

// Column headers for Google Sheets - ИСПРАВЛЕНО
const COLUMN_HEADERS = [
  'Date',
  'Client Name',
  'Room Type', 
  'Location',
  'Goal',
  'Work Done',
  'Materials',
  'Features',
  'Drive Folder'  // ИСПРАВЛЕНО: соответствует Google Sheets
];

// Константы для валидации
const MAX_CLIENT_NAME_LENGTH = 50;
const MAX_ROOM_TYPE_LENGTH = 30;
const REDIS_SESSION_TTL = 3600; // 1 час в секундах

// ✨ REDIS ФУНКЦИИ ДЛЯ СЕССИЙ

async function getSession(userId) {
  try {
    console.log(`🔍 Getting session for user ${userId}`);
    const session = await redis.get(`session_${userId}`);
    console.log(`📋 Session found:`, !!session);
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
    
    await redis.set(`session_${userId}`, sessionData, { ex: REDIS_SESSION_TTL });
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

// 📝 ФУНКЦИЯ ДЛЯ СОЗДАНИЯ СОДЕРЖИМОГО ФАЙЛА

function generateProjectFileContent(answers, driveFolder) {
  const date = new Date().toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric'
  });
  
  return `RENOVATION PROJECT BRIEF
========================

📅 PROJECT DATE: ${date}
👤 CLIENT: ${answers[0] || 'Not specified'}
🏗️ ROOM TYPE: ${answers[1] || 'Not specified'}
📍 LOCATION: ${answers[2] || 'Not specified'}

PROJECT OVERVIEW
================
🌟 CLIENT'S GOAL:
${answers[3] || 'Not specified'}

💪 WORK COMPLETED:
${answers[4] || 'Not specified'}

🧱 MATERIALS USED:
${answers[5] || 'Not specified'}

✨ SPECIAL FEATURES:
${answers[6] || 'Not specified'}

FOLDER STRUCTURE
===============
📁 Before Photos - Original condition images
📁 After Photos - Completed project showcase  
📁 3D Visualization - Renderings and design concepts
📁 Floor Plans - Technical drawings and layouts

📊 PROJECT INFORMATION
=====================
• Project Folder: ${driveFolder ? driveFolder.folderUrl : 'Not available'}
• Generated: ${new Date().toLocaleString('en-US')}

=== END OF PROJECT BRIEF ===`;
}

// ФУНКЦИЯ ВАЛИДАЦИИ И ОЧИСТКИ НАЗВАНИЙ ПАПОК
function sanitizeAndValidateFolderName(clientName, roomType) {
  // Убираем недопустимые символы для Google Drive и лишние пробелы
  const cleanClient = clientName.replace(/[<>:"/\\|?*]/g, '').trim().substring(0, MAX_CLIENT_NAME_LENGTH);
  const cleanRoom = roomType.replace(/[<>:"/\\|?*]/g, '').trim().substring(0, MAX_ROOM_TYPE_LENGTH);
  
  // Заменяем множественные пробелы на одинарные
  const finalClient = cleanClient.replace(/\s+/g, ' ');
  const finalRoom = cleanRoom.replace(/\s+/g, ' ');
  
  return { 
    clientName: finalClient || 'Unknown Client', 
    roomType: finalRoom || 'Unknown Room' 
  };
}

// ФУНКЦИЯ ВАЛИДАЦИИ ВВОДА ПОЛЬЗОВАТЕЛЯ
function validateUserInput(step, input) {
  const trimmedInput = input.trim();
  
  if (step === 0) {
    // Вопрос 0: Имя клиента
    if (trimmedInput.length === 0) {
      return { valid: false, error: 'Client name cannot be empty' };
    }
    if (trimmedInput.length > MAX_CLIENT_NAME_LENGTH) {
      return { 
        valid: false, 
        error: `Client name is too long (${trimmedInput.length} characters). Please keep it under ${MAX_CLIENT_NAME_LENGTH} characters` 
      };
    }
  } else if (step === 1) {
    // Вопрос 1: Тип комнаты
    if (trimmedInput.length === 0) {
      return { valid: false, error: 'Room type cannot be empty' };
    }
    if (trimmedInput.length > MAX_ROOM_TYPE_LENGTH) {
      return { 
        valid: false, 
        error: `Room description is too long (${trimmedInput.length} characters). Please keep it under ${MAX_ROOM_TYPE_LENGTH} characters` 
      };
    }
  }
  
  return { valid: true, cleanInput: trimmedInput };
}

// Функция для создания файла в Google Drive
async function createProjectFile(folderId, fileName, content, accessToken) {
  return new Promise((resolve, reject) => {
    console.log(`📝 Creating file: ${fileName}`);
    
    const metadata = {
      name: fileName,
      parents: [folderId],
      mimeType: 'text/plain'
    };
    
    const boundary = '-------314159265358979323846';
    const delimiter = "\r\n--" + boundary + "\r\n";
    const close_delim = "\r\n--" + boundary + "--";
    
    const multipartRequestBody = 
      delimiter +
      'Content-Type: application/json\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      'Content-Type: text/plain\r\n\r\n' +
      content +
      close_delim;
    
    const options = {
      hostname: 'www.googleapis.com',
      port: 443,
      path: '/upload/drive/v3/files?uploadType=multipart',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary="${boundary}"`,
        'Content-Length': Buffer.byteLength(multipartRequestBody)
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        console.log(`📥 File creation response (${res.statusCode})`);
        
        if (res.statusCode === 200) {
          try {
            const result = JSON.parse(data);
            console.log(`✅ File created: ${result.id}`);
            resolve(result);
          } catch (parseError) {
            reject(new Error(`JSON parse error: ${parseError.message}`));
          }
        } else {
          reject(new Error(`Drive API error: ${res.statusCode}`));
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('File creation timeout'));
    });
    
    req.write(multipartRequestBody);
    req.end();
  });
}

// 🗂️ GOOGLE DRIVE ФУНКЦИИ

async function createProjectFolder(clientName, roomType, location) {
  try {
    console.log('📁 === STARTING createProjectFolder ===');
    
    // ОЧИСТКА И ВАЛИДАЦИЯ НАЗВАНИЙ
    const cleaned = sanitizeAndValidateFolderName(clientName, roomType);
    const finalClientName = cleaned.clientName;
    const finalRoomType = cleaned.roomType;
    
    console.log(`📝 Cleaned parameters: "${finalClientName}" - "${finalRoomType}"`);
    
    const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const serviceAccountAuth = new JWT({
      email: serviceAccountKey.client_email,
      key: serviceAccountKey.private_key,
      scopes: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive'
      ],
    });

    const token = await serviceAccountAuth.getAccessToken();
    console.log('✅ Access token obtained');
    
    // Создаем имя папки
    const date = new Date().toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',  
      year: 'numeric'
    });
    const folderName = `${finalClientName} - ${finalRoomType} - ${date}`;
    console.log(`✅ Folder name: "${folderName}" (${folderName.length} chars)`);
    
    // Создаем главную папку
    const mainFolderData = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [process.env.PARENT_FOLDER_ID]
    };
    
    const mainFolder = await createDriveFolder(mainFolderData, token.token);
    console.log(`✅ Main folder created: ${mainFolder.id}`);
    
    // Создаем подпапки
    const subfolders = ['Before', 'After', '3D Visualization', 'Floor Plans'];
    const createdSubfolders = [];
    
    for (const subfolderName of subfolders) {
      console.log(`📂 Creating subfolder: ${subfolderName}`);
      
      try {
        const subfolderData = {
          name: subfolderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [mainFolder.id]
        };
        
        const subfolder = await createDriveFolder(subfolderData, token.token);
        createdSubfolders.push(subfolder);
        console.log(`✅ Subfolder created: ${subfolder.id}`);
        
      } catch (subError) {
        console.error(`❌ Error creating subfolder "${subfolderName}":`, subError);
      }
    }
    
    // Устанавливаем права доступа
    try {
      await setFolderPermissions(mainFolder.id, token.token);
      console.log('✅ Permissions set');
    } catch (permError) {
      console.error('❌ Permissions error:', permError);
    }
    
    const folderUrl = `https://drive.google.com/drive/folders/${mainFolder.id}?usp=sharing`;
    
    const result = {
      folderId: mainFolder.id,
      folderName: folderName,
      folderUrl: folderUrl,
      subfolders: createdSubfolders,
      token: token.token
    };
    
    console.log('🎯 === createProjectFolder FINISHED ===');
    return result;
    
  } catch (error) {
    console.error('❌ CRITICAL ERROR in createProjectFolder:', error);
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
          try {
            resolve(JSON.parse(data));
          } catch (parseError) {
            reject(new Error(`JSON parse error: ${parseError.message}`));
          }
        } else {
          reject(new Error(`Drive API error: ${res.statusCode}`));
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
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
          try {
            resolve(JSON.parse(data));
          } catch (parseError) {
            reject(new Error(`Permissions parse error: ${parseError.message}`));
          }
        } else {
          resolve(null); // Не критично
        }
      });
    });
    
    req.on('error', () => resolve(null)); // Не критично
    req.setTimeout(10000, () => {
      req.destroy();
      resolve(null); // Не критично
    });
    
    req.write(postData);
    req.end();
  });
}

// ОПТИМИЗИРОВАННАЯ ФУНКЦИЯ sendMessage с timeout
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
    
    console.log(`📤 Sending message to ${chatId}:`, text.substring(0, 50) + '...');
    
    const request = https.request(requestOptions, (response) => {
      let data = '';
      response.on('data', (chunk) => data += chunk);
      response.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.ok) {
            console.log('✅ Message sent successfully');
            resolve(result);
          } else {
            console.error('❌ Telegram API error:', result.description);
            reject(new Error(`Telegram API error: ${result.description}`));
          }
        } catch (error) {
          reject(new Error('Failed to parse Telegram response'));
        }
      });
    });
    
    // КРИТИЧЕСКИЙ TIMEOUT для предотвращения зависания
    request.setTimeout(8000, () => {
      console.error('⏰ Telegram API timeout');
      request.destroy();
      reject(new Error('Telegram API timeout'));
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
    request.setTimeout(5000, () => {
      request.destroy();
      reject(new Error('API call timeout'));
    });
    
    request.write(postData);
    request.end();
  });
}

async function initializeGoogleSheets() {
  try {
    console.log('🔧 Initializing Google Sheets');
    
    const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const serviceAccountAuth = new JWT({
      email: serviceAccountKey.client_email,
      key: serviceAccountKey.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    console.log(`✅ Connected to: ${doc.title}`);
    
    let sheet = doc.sheetsByIndex[0];
    if (!sheet) {
      sheet = await doc.addSheet({ title: 'Renovation Projects' });
      console.log('✅ Created new sheet');
    }
    
    await sheet.loadHeaderRow();
    
    if (!sheet.headerValues || sheet.headerValues.length === 0) {
      await sheet.setHeaderRow(COLUMN_HEADERS);
      await sheet.loadHeaderRow();
      console.log('✅ Headers set');
    }
    
    return sheet;
    
  } catch (error) {
    console.error('❌ Google Sheets error:', error);
    throw error;
  }
}

async function addRowToSheet(answers, driveFolder) {
  try {
    console.log('📊 Adding row to Google Sheets');
    
    const sheet = await initializeGoogleSheets();
    
    const rowData = {
      'Date': new Date().toLocaleDateString('en-US'),
      'Client Name': answers[0] || 'Not specified',
      'Room Type': answers[1] || 'Not specified',
      'Location': answers[2] || 'Not specified',
      'Goal': answers[3] || 'Not specified',
      'Work Done': answers[4] || 'Not specified',
      'Materials': answers[5] || 'Not specified',
      'Features': answers[6] || 'Not specified',
      'Drive Folder': driveFolder?.folderUrl || 'Not created'
    };
    
    const addedRow = await sheet.addRow(rowData);
    console.log(`✅ Row added: ${addedRow._rowNumber}`);
    
    // Верификация
    const savedLink = addedRow.get('Drive Folder');
    if (savedLink && savedLink !== 'Not created') {
      console.log('✅ Drive Folder verified in sheets');
    } else {
      console.warn('⚠️ Drive Folder not saved properly');
    }
    
    return true;
    
  } catch (error) {
    console.error('❌ Google Sheets error:', error);
    throw error;
  }
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
    console.log('✅ Bot commands set up');
  } catch (error) {
    console.error('❌ Error setting up commands:', error);
  }
}

function createAdminNotification(answers, driveFolder) {
  return `📢 New Project Submitted!
👤 Client: ${answers[0] || 'Not specified'}
🏗️ Room: ${answers[1] || 'Not specified'}
📍 Location: ${answers[2] || 'Not specified'}
📁 Folder: ${driveFolder?.folderUrl || 'Not created'}`.trim();
}

function createMainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🚀 Start New Survey', callback_data: 'start_survey' }],
        [
          { text: '❓ Help &amp; Info', callback_data: 'show_help' },
          { text: '📊 About Bot', callback_data: 'about_bot' }
        ]
      ]
    }
  };
}

async function showMainMenu(chatId) {
  const welcomeText = `🏠 *Welcome to Renovation Project Bot!*

I help collect information about completed renovation projects for content creation, CRM management, and business analytics.

*Choose an option below to get started:*`;
  
  await sendMessage(chatId, welcomeText, createMainMenu());
}

async function processCompletedSurvey(chatId, userId, answers) {
  try {
    console.log('🎯 === PROCESSING COMPLETED SURVEY ===');
    
    await sendMessage(chatId, "✅ Survey completed!\n\nCreating project folder...");
    
    // Создание папки
    const driveFolder = await createProjectFolder(
      answers[0] || 'Unknown Client',
      answers[1] || 'Unknown Room', 
      answers[2] || 'Unknown Location'
    );
    console.log('✅ Drive folder created');
    
    // Асинхронное создание файла (не блокирует)
    createProjectFileAsync(answers, driveFolder).catch(err => {
      console.error('❌ File creation failed (non-blocking):', err);
    });
    
    // Сохранение в Google Sheets
    await addRowToSheet(answers, driveFolder);
    console.log('✅ Data saved to sheets');
    
    // Уведомление админу
    const adminChatId = process.env.ADMIN_CHAT_ID;
    if (adminChatId) {
      const notification = createAdminNotification(answers, driveFolder);
      await sendMessage(adminChatId, notification);
      console.log('✅ Admin notified');
    }
    
    // Финальное сообщение БЕЗ MARKDOWN КОНФЛИКТОВ
    const confirmationMessage = `✅ Project successfully processed!

📁 Folder: ${driveFolder.folderName}

📤 Please upload your project files to these folders:

Before photos - Before folder
After photos - After folder  
3D renderings - 3D Visualization folder
Floor plans - Floor Plans folder

🔗 ${driveFolder.folderUrl}

Use /start for main menu`;

    await sendMessage(chatId, confirmationMessage, {
      reply_markup: { remove_keyboard: true }
    });
    
    await deleteSession(userId);
    console.log('🎯 === SURVEY PROCESSING COMPLETE ===');
    
  } catch (error) {
    console.error('❌ CRITICAL ERROR in survey processing:', error);
    await deleteSession(userId);
    await sendMessage(chatId, `❌ Error processing survey: ${error.message}`);
  }
}

// Асинхронная функция создания файла
async function createProjectFileAsync(answers, driveFolder) {
  try {
    if (!driveFolder?.folderId || !driveFolder?.token) {
      throw new Error('Missing folder data for file creation');
    }
    
    const content = generateProjectFileContent(answers, driveFolder);
    const fileName = `${answers[0] || 'Project'} - Project Brief.txt`;
    
    await createProjectFile(driveFolder.folderId, fileName, content, driveFolder.token);
    console.log('✅ Project file created');
    
  } catch (error) {
    console.error('❌ File creation failed:', error);
  }
}

export default async function handler(req, res) {
  console.log(`${new Date().toISOString()} - ${req.method} request received`);
  
  if (req.method !== 'POST') {
    return res.status(200).json({ message: 'This endpoint handles Telegram webhook events' });
  }

  try {
    const update = req.body;
    
    // Handle callback queries (inline button presses)
    if (update.callback_query) {
      const { message, from, data, id } = update.callback_query;
      const chatId = message.chat.id;
      const userId = from.id;
      
      console.log(`Callback from ${userId}: ${data}`);
      
      // Проверка авторизации
      if (!isUserAuthorized(userId)) {
        await makeApiCall('answerCallbackQuery', {
          callback_query_id: id,
          text: "Access denied",
          show_alert: true
        });
        await sendMessage(chatId, `🚫 Access denied. Your ID: ${userId}`);
        return res.status(200).json({ ok: true });
      }
      
      // Ответ на callback query
      await makeApiCall('answerCallbackQuery', { callback_query_id: id });
      
      if (data === 'start_survey') {
        await saveSession(userId, 0, []);
        
        await sendMessage(chatId, '📝 *Starting Project Survey*\n\nI will guide you through 7 questions about your completed renovation project.\n\n⚠️ First 2 questions are required (client name and room type).\n\nLet\'s begin!');
        
        // Первый вопрос БЕЗ Skip кнопки
        await sendMessage(chatId, questions[0], {
          reply_markup: { remove_keyboard: true }
        });
        
      } else if (data === 'show_help') {
        const helpText = `*❓ How to Use This Bot*

*Available Commands:*
- /start - Show main menu
- /survey - Start project survey directly  
- /help - Show this help
- /cancel - Cancel current survey

*Survey Process:*
1️⃣ Click "🚀 Start New Survey"
2️⃣ Answer 7 questions about your project
3️⃣ First 2 questions are required (client name, room type)
4️⃣ Other questions can be skipped if needed
5️⃣ Get Google Drive folder with project files

*After completion:*
- Automatic Google Drive folder creation
- Project Brief text file
- Data saved to Google Sheets  
- Upload instructions provided

Use /start anytime to return to the main menu.`;
        
        await sendMessage(chatId, helpText);
        
      } else if (data === 'about_bot') {
        const aboutText = `*📊 About Renovation Project Bot*

*Purpose:*
Streamline renovation project data collection for business use.

*Features:*
- 📁 Automatic Google Drive folders
- 📊 Google Sheets data storage
- 📝 Project Brief files
- 🔗 Instant shareable links

*Business Benefits:*
- Content creation for marketing
- CRM and database management
- Project analytics and reporting
- Organized file management

Ready to submit a project? Use /start to begin.`;
        
        await sendMessage(chatId, aboutText);
      }
      
      return res.status(200).json({ ok: true });
    }
    
    if (!update.message) {
      return res.status(200).json({ ok: true });
    }
    
    const { chat, text, from } = update.message;
    const chatId = chat.id;
    const userId = from.id;
    
    console.log(`Message from ${userId}: ${text}`);
    
    // Проверка авторизации  
    if (!isUserAuthorized(userId)) {
      await sendMessage(chatId, `🚫 Access denied. Your ID: ${userId}`);
      return res.status(200).json({ ok: true });
    }
    
    // Обработка команд
    if (text === '/start') {
      setupBotCommands().catch(console.error);
      await showMainMenu(chatId);
      return res.status(200).json({ ok: true });
    }
    
    if (text === '/survey') {
      await saveSession(userId, 0, []);
      await sendMessage(chatId, '📝 *Starting Project Survey*\n\nI will guide you through 7 questions about your completed renovation project.\n\n⚠️ First 2 questions are required (client name and room type).\n\nLet\'s begin!');
      await sendMessage(chatId, questions[0], {
        reply_markup: { remove_keyboard: true }
      });
      return res.status(200).json({ ok: true });
    }
    
    if (text === '/help') {
      const helpText = `*❓ Renovation Project Bot Help*

Use /start to see the main menu with all options.

*Quick Commands:*
- /start - Main menu
- /survey - Start survey directly
- /cancel - Cancel current survey

*Survey Info:*
- 7 questions total
- First 2 questions are required (client name, room type)
- Other questions can be skipped
- Get organized Google Drive folder with upload instructions

Need to go back to the main menu? Just type /start`;
      
      await sendMessage(chatId, helpText);
      return res.status(200).json({ ok: true });
    }
    
    if (text === '/cancel') {
      await deleteSession(userId);
      await sendMessage(chatId, '❌ Survey cancelled.\n\nUse /start to return to the main menu.', {
        reply_markup: { remove_keyboard: true }
      });
      return res.status(200).json({ ok: true });
    }
    
    // ОБРАБОТКА ОТВЕТОВ НА ВОПРОСЫ АНКЕТЫ
    const session = await getSession(userId);
    
    if (session) {
      console.log(`📋 Session found: step ${session.step}`);
      
      // Проверка валидности сессии
      if (!session.answers || !Array.isArray(session.answers)) {
        console.error('❌ Invalid session data');
        await deleteSession(userId);
        await sendMessage(chatId, 'Session expired. Please start a new survey with /start', {
          reply_markup: { remove_keyboard: true }
        });
        return res.status(200).json({ ok: true });
      }
      
      // Получение и обработка ответа
      let answer = text;
      if (text === 'Skip this question ⏭️') {
        answer = 'Not specified';
      }
      
      const currentStep = session.step;
      
      // ВАЛИДАЦИЯ ДЛЯ ОБЯЗАТЕЛЬНЫХ ВОПРОСОВ (0, 1)
      if (currentStep <= 1 && answer !== 'Not specified') {
        const validation = validateUserInput(currentStep, answer);
        
        if (!validation.valid) {
          await sendMessage(chatId, `❌ ${validation.error}.\n\nPlease try again:\n\n${questions[currentStep]}`, {
            reply_markup: { remove_keyboard: true }
          });
          return res.status(200).json({ ok: true });
        }
        
        answer = validation.cleanInput;
      }
      
      // Сохранение ответа и переход к следующему шагу
      session.answers[session.step] = answer;
      session.step++;
      
      // Проверка завершения анкеты
      if (session.step >= questions.length) {
        // Анкета завершена
        await processCompletedSurvey(chatId, userId, session.answers);
      } else {
        // Продолжение анкеты
        await saveSession(userId, session.step, session.answers);
        
        // Определение необходимости Skip кнопки
        const isSkippable = session.step >= 2;
        
        const replyMarkup = isSkippable ? {
          keyboard: [[{ text: 'Skip this question ⏭️' }]],
          resize_keyboard: true
        } : {
          remove_keyboard: true
        };
        
        await sendMessage(chatId, questions[session.step], {
          reply_markup: replyMarkup
        });
      }
    } else {
      // Нет активной сессии
      await sendMessage(chatId, 'Hi! 👋 Use /start to see the main menu and available options.');
    }
    
    return res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    return res.status(200).json({ ok: true });
  }
}
