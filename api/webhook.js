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

// Questions in the survey (7 ВОПРОСОВ)
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

// 📝 ПРОСТАЯ ФУНКЦИЯ ДЛЯ СОЗДАНИЯ СОДЕРЖИМОГО ФАЙЛА

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

CONTENT IDEAS
============
🎬 VIDEO TITLE SUGGESTIONS:
- "Amazing ${answers[1] || 'Room'} Transformation in ${answers[2] || 'Location'}!"
- "From Outdated to Outstanding: Complete ${answers[1] || 'Room'} Renovation"
- "Modern Design Meets Functionality: ${answers[1] || 'Room'} Renovation Reveal"

📝 SOCIAL MEDIA CAPTION:
"Just completed this stunning ${answers[1]?.toLowerCase() || 'room'} renovation for our client ${answers[0] || 'our client'} in ${answers[2] || 'location'}! 

✨ Client Goals: ${answers[3] || 'Transform the space'}
💎 Key highlights: ${answers[6] || 'Amazing transformation achieved'}

Swipe to see the incredible before & after transformation! 

#renovation #${answers[1]?.toLowerCase().replace(/\s+/g, '') || 'renovation'} #beforeandafter #interiordesign"

📊 PROJECT INFORMATION
=====================
• Project Folder: ${driveFolder ? driveFolder.folderUrl : 'Not available'}
• Generated: ${new Date().toLocaleString('en-US')}
• Created by: Renovation Bot v1.0

=== END OF PROJECT BRIEF ===`;
}

// Функция для создания файла в Google Drive
async function createProjectFile(folderId, fileName, content, accessToken) {
  return new Promise((resolve, reject) => {
    console.log(`📝 Creating file: ${fileName} in folder: ${folderId}`);
    
    // Создаем метаданные файла
    const metadata = {
      name: fileName,
      parents: [folderId],
      mimeType: 'text/plain'
    };
    
    // Создаем multipart данные
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
        console.log(`📥 File creation response (${res.statusCode}):`, data.substring(0, 200));
        
        if (res.statusCode === 200) {
          try {
            const result = JSON.parse(data);
            console.log(`✅ File created successfully: ${result.id}`);
            resolve(result);
          } catch (parseError) {
            reject(new Error(`File creation JSON parse error: ${parseError.message}`));
          }
        } else {
          reject(new Error(`Drive API file creation error: ${res.statusCode} - ${data}`));
        }
      });
    });
    
    req.on('error', (error) => {
      console.error('❌ File creation request error:', error);
      reject(error);
    });
    
    req.setTimeout(10000, () => {
      console.error('⏰ File creation timeout');
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
    console.log(`📝 Parameters: client="${clientName}", room="${roomType}", location="${location}"`);
    
    console.log('🔑 Step A: Parsing service account key...');
    const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    console.log('✅ Step A: Service account key parsed');
    
    console.log('🔑 Step B: Creating JWT auth...');
    const serviceAccountAuth = new JWT({
      email: serviceAccountKey.client_email,
      key: serviceAccountKey.private_key,
      scopes: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive'
      ],
    });
    console.log('✅ Step B: JWT auth created');

    console.log('🔑 Step C: Getting access token...');
    const token = await serviceAccountAuth.getAccessToken();
    console.log('✅ Step C: Access token obtained');
    console.log(`🔑 Token length: ${token.token ? token.token.length : 'null'}`);
    
    // Создаем имя папки
    console.log('📝 Step D: Creating folder name...');
    const date = new Date().toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',  
      year: 'numeric'
    });
    const folderName = `${clientName} - ${roomType} - ${date}`;
    console.log(`✅ Step D: Folder name created: "${folderName}"`);
    console.log(`📁 Parent folder ID: "${process.env.PARENT_FOLDER_ID}"`);
    
    // Создаем главную папку
    console.log('🗂️ Step E: Creating main folder...');
    const mainFolderData = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [process.env.PARENT_FOLDER_ID]
    };
    
    const mainFolder = await createDriveFolder(mainFolderData, token.token);
    console.log(`✅ Step E: Main folder created with ID: ${mainFolder.id}`);
    
    // Создаем подпапки
    console.log('📂 Step F: Creating subfolders...');
    const subfolders = ['Before', 'After', '3D Visualization', 'Floor Plans'];
    const createdSubfolders = [];
    
    for (let i = 0; i < subfolders.length; i++) {
      const subfolderName = subfolders[i];
      console.log(`📂 Step F.${i+1}: Creating subfolder "${subfolderName}"...`);
      
      try {
        const subfolderData = {
          name: subfolderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [mainFolder.id]
        };
        
        const subfolder = await createDriveFolder(subfolderData, token.token);
        createdSubfolders.push(subfolder);
        console.log(`✅ Step F.${i+1}: Subfolder created with ID: ${subfolder.id}`);
        
      } catch (subError) {
        console.error(`❌ Step F.${i+1}: Error creating subfolder "${subfolderName}":`, subError);
      }
    }
    
    console.log('✅ Step F: All subfolders processing completed');
    
    // Устанавливаем права доступа
    console.log('🔐 Step G: Setting folder permissions...');
    try {
      await setFolderPermissions(mainFolder.id, token.token);
      console.log('✅ Step G: Permissions set successfully');
    } catch (permError) {
      console.error('❌ Step G: Permissions error:', permError);
      console.log('⚠️ Step G: Continuing without permissions...');
    }
    
    console.log('🔗 Step H: Creating folder URL...');
    const folderUrl = `https://drive.google.com/drive/folders/${mainFolder.id}`;
    console.log(`✅ Step H: Folder URL: ${folderUrl}`);
    
    const result = {
      folderId: mainFolder.id,
      folderName: folderName,
      folderUrl: folderUrl,
      subfolders: createdSubfolders,
      token: token.token // Добавляем токен для создания файла
    };
    
    console.log('🎯 === createProjectFolder FINISHED SUCCESSFULLY ===');
    console.log('📊 Final result:', JSON.stringify({...result, token: '[HIDDEN]'}, null, 2));
    
    return result;
    
  } catch (error) {
    console.error('❌ CRITICAL ERROR in createProjectFolder:', error);
    console.error('❌ Error type:', typeof error);
    console.error('❌ Error name:', error.name);
    console.error('❌ Error message:', error.message);
    console.error('❌ Error stack:', error.stack);
    throw error;
  }
}

async function createDriveFolder(folderData, accessToken) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(folderData);
    console.log(`📤 Creating folder: ${folderData.name}`);
    
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
        console.log(`📥 Drive API response (${res.statusCode}):`, data.substring(0, 200));
        
        if (res.statusCode === 200) {
          try {
            const result = JSON.parse(data);
            resolve(result);
          } catch (parseError) {
            reject(new Error(`JSON parse error: ${parseError.message}`));
          }
        } else {
          reject(new Error(`Drive API error: ${res.statusCode} - ${data}`));
        }
      });
    });
    
    req.on('error', (error) => {
      console.error('🌐 HTTP request error:', error);
      reject(error);
    });
    
    req.setTimeout(15000, () => {
      console.error('⏰ Request timeout');
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
    console.log(`🔐 Setting permissions for folder: ${folderId}`);
    
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
        console.log(`🔐 Permissions API response (${res.statusCode}):`, data.substring(0, 100));
        
        if (res.statusCode === 200) {
          try {
            const result = JSON.parse(data);
            resolve(result);
          } catch (parseError) {
            reject(new Error(`Permissions JSON parse error: ${parseError.message}`));
          }
        } else {
          reject(new Error(`Permissions API error: ${res.statusCode} - ${data}`));
        }
      });
    });
    
    req.on('error', (error) => {
      console.error('🌐 Permissions request error:', error);
      reject(error);
    });
    
    req.setTimeout(10000, () => {
      console.error('⏰ Permissions request timeout');
      req.destroy();
      reject(new Error('Permissions timeout'));
    });
    
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
    console.log('🔧 === INITIALIZING GOOGLE SHEETS ===');
    
    const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    console.log('✅ Service account key parsed');
    
    const serviceAccountAuth = new JWT({
      email: serviceAccountKey.client_email,
      key: serviceAccountKey.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    console.log('✅ JWT auth created');

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    console.log(`✅ Connected to Google Sheet: ${doc.title}`);
    
    let sheet = doc.sheetsByIndex[0];
    if (!sheet) {
      sheet = await doc.addSheet({ title: 'Renovation Projects' });
      console.log('✅ Created new sheet: Renovation Projects');
    }
    
    // Загружаем заголовки
    await sheet.loadHeaderRow();
    console.log('📋 Current sheet headers:', sheet.headerValues);
    
    // Проверяем и устанавливаем правильные заголовки
    if (!sheet.headerValues || sheet.headerValues.length === 0) {
      console.log('🔧 Setting headers for the first time...');
      await sheet.setHeaderRow(COLUMN_HEADERS);
      console.log('✅ Headers set successfully');
      
      // Перезагружаем заголовки после установки
      await sheet.loadHeaderRow();
      console.log('📋 Final headers:', sheet.headerValues);
    } else {
      console.log('✅ Headers already exist:', sheet.headerValues);
    }
    
    console.log('🔧 === GOOGLE SHEETS INITIALIZATION COMPLETE ===');
    return sheet;
    
  } catch (error) {
    console.error('❌ Error initializing Google Sheets:', error);
    console.error('❌ Sheet ID:', process.env.GOOGLE_SHEET_ID);
    console.error('❌ Error details:', error.message);
    throw error;
  }
}

async function addRowToSheet(answers, driveFolder) {
  try {
    console.log('📊 === STARTING addRowToSheet ===');
    console.log('📝 Input answers array:', answers);
    console.log('📁 Input driveFolder:', driveFolder);
    
    const sheet = await initializeGoogleSheets();
    console.log('✅ Google Sheets connection established');
    
    // Убеждаемся, что заголовки загружены
    await sheet.loadHeaderRow();
    console.log('📋 Sheet headers:', sheet.headerValues);
    
    // Создаем объект данных для новой строки
    const rowData = {
      'Date': new Date().toLocaleDateString('en-US'),
      'Client Name': answers[0] || 'Not specified',
      'Room Type': answers[1] || 'Not specified',
      'Location': answers[2] || 'Not specified',
      'Goal': answers[3] || 'Not specified',
      'Work Done': answers[4] || 'Not specified',
      'Materials': answers[5] || 'Not specified',
      'Features': answers[6] || 'Not specified',
      'Drive Link': driveFolder ? driveFolder.folderUrl : 'Not created'
    };
    
    console.log('📋 Row data prepared:');
    console.log(JSON.stringify(rowData, null, 2));
    
    // Добавляем строку в таблицу
    console.log('➕ Adding row to sheet...');
    const addedRow = await sheet.addRow(rowData);
    console.log('✅ Row added successfully! Row number:', addedRow._rowNumber);
    
    console.log('📊 === addRowToSheet FINISHED SUCCESSFULLY ===');
    return true;
    
  } catch (error) {
    console.error('❌ CRITICAL ERROR in addRowToSheet:', error);
    console.error('❌ Error type:', typeof error);
    console.error('❌ Error name:', error.name);
    console.error('❌ Error message:', error.message);
    console.error('❌ Full error stack:', error.stack);
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
  let notification = `
📢 New Project Submitted!
👤 Client: ${answers[0] || 'Not specified'}
🏗️ Room: ${answers[1] || 'Not specified'}
📍 Location: ${answers[2] || 'Not specified'}
🌟 Goal: ${answers[3] || 'Not specified'}
💪 Work done: ${answers[4] || 'Not specified'}
🧱 Materials: ${answers[5] || 'Not specified'}
✨ Features: ${answers[6] || 'Not specified'}
📁 Folder: ${driveFolder ? driveFolder.folderUrl : 'Not created'}`;

  // Добавляем ссылку на файл проекта если создан
  if (driveFolder && driveFolder.projectFile) {
    notification += `\n📝 Project Brief: ${driveFolder.projectFile.url}`;
  }

  return notification.trim();
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

// 🎯 ИСПРАВЛЕННАЯ ВЕРСИЯ processCompletedSurvey - БЕЗ ЗАВИСАНИЯ

async function processCompletedSurvey(chatId, userId, answers) {
  try {
    console.log('🎯 === STARTING processCompletedSurvey (FIXED VERSION) ===');
    console.log('✅ Survey completed, answers:', answers);
    
    // Send summary
    console.log('📤 Step 1: Sending summary message...');
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

Creating Google Drive folder...`;
    
    await sendMessage(chatId, summaryMessage);
    console.log('✅ Step 1 completed: Summary message sent');
    
    // Отправляем сообщение о процессе сразу
    await sendMessage(chatId, "⏳ Creating folder and saving data...");
    
    try {
      // Создаем Google Drive папку
      console.log('📁 Step 2: Starting createProjectFolder...');
      const driveFolder = await createProjectFolder(
        answers[0] || 'Unknown Client',
        answers[1] || 'Unknown Room', 
        answers[2] || 'Unknown Location'
      );
      console.log('✅ Step 2 completed: Drive folder created');
      
      // Создаем файл проекта АСИНХРОННО (не блокируем основной поток)
      console.log('📝 Step 2.5: Creating project file asynchronously...');
      createProjectFileAsync(answers, driveFolder).catch(err => {
        console.error('❌ Async file creation error (non-blocking):', err);
      });
      
      // Save to Google Sheets
      console.log('📊 Step 3: Starting addRowToSheet...');
      await addRowToSheet(answers, driveFolder);
      console.log('✅ Step 3 completed: addRowToSheet finished');
      
      // Send notification to admin
      console.log('👤 Step 4: Sending admin notification...');
      const adminChatId = process.env.ADMIN_CHAT_ID;
      if (adminChatId) {
        const notificationText = createAdminNotification(answers, driveFolder);
        await sendMessage(adminChatId, notificationText);
        console.log('✅ Step 4 completed: Admin notification sent');
      } else {
        console.log('⚠️ Step 4 skipped: No admin chat ID configured');
      }
      
      // КОРОТКОЕ ФИНАЛЬНОЕ СООБЩЕНИЕ
      console.log('💬 Step 5: Sending final confirmation...');
      const confirmationMessage = `🎉 *Project successfully processed!*

✅ Data saved to Google Sheets
📁 Google Drive folder created

🔗 **Folder:** ${driveFolder.folderUrl}

**Structure:**
📁 Before | 📁 After | 📁 3D | 📁 Plans

Use /start for main menu`;

      await sendMessage(chatId, confirmationMessage, {
        reply_markup: { remove_keyboard: true }
      });
      
      console.log('✅ Step 5 completed: Final confirmation sent');
      
    } catch (error) {
      console.error('❌ ERROR in Steps 2-5:', error);
      console.error('❌ Error name:', error.name);
      console.error('❌ Error message:', error.message);
      
      await sendMessage(chatId, `❌ Error: ${error.message}. Please try again later.`);
    }
    
    // Удаляем сессию из Redis
    console.log('🗑️ Step 6: Deleting Redis session...');
    await deleteSession(userId);
    console.log('✅ Step 6 completed: Redis session deleted');
    
    console.log('🎯 === processCompletedSurvey FINISHED SUCCESSFULLY ===');
    
  } catch (error) {
    console.error('❌ CRITICAL ERROR in processCompletedSurvey:', error);
    console.log('📤 Sending error message to user...');
    await sendMessage(chatId, '❌ Error processing survey. Please try again later.');
  }
}

// Асинхронная функция создания файла (не блокирует основной поток)
async function createProjectFileAsync(answers, driveFolder) {
  try {
    console.log('📝 === ASYNC FILE CREATION START ===');
    
    const fullFileContent = generateProjectFileContent(answers, driveFolder);
    const fileName = `${answers[0] || 'Project'} - Project Brief.txt`;
    
    const projectFile = await createProjectFile(
      driveFolder.folderId,
      fileName,
      fullFileContent,
      driveFolder.token
    );
    
    console.log('✅ Async file creation completed:', projectFile.id);
    
    // Можно добавить дополнительную логику, например, обновить уведомление админу
    
  } catch (error) {
    console.error('❌ Async file creation failed:', error);
    // Не критично - основной функционал работает
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
4️⃣ Get Google Drive folder with project files

*Questions Asked:*
- Client name, Room type, Location
- Client's goals, Work completed
- Materials used, Special features

*After completion:*
- Automatic Google Drive folder creation
- Project Brief text file
- Data saved to Google Sheets

Use /start anytime to return to the main menu.`;
        
        await sendMessage(chatId, helpText);
        
      } else if (data === 'about_bot') {
        const aboutText = `
*📊 About Renovation Project Bot*

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

After completing the survey, you'll receive:
- Google Drive folder link
- Project Brief text file

Need to go back to the main menu? Just type /start`;
      
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
