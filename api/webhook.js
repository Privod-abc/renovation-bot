import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { Redis } from '@upstash/redis';
import https from 'https';

// ============================================================================
// КОНФИГУРАЦИЯ И КОНСТАНТЫ
// ============================================================================

// Настройки для продакшна
const DEBUG_MODE = process.env.NODE_ENV === 'development';
const REQUEST_TIMEOUT = 8000;
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 минут
const MAX_CONSECUTIVE_ERRORS = 3;

// Настройки уведомлений
const NOTIFICATION_SETTINGS = {
  NOTIFY_RECOVERY: true,
  NOTIFY_CRITICAL: true,
  MIN_NOTIFICATION_INTERVAL: 30 * 60 * 1000,
  QUIET_HOURS: { enabled: false, start: 23, end: 7 }
};

// Константы валидации
const MAX_CLIENT_NAME_LENGTH = 50;
const MAX_ROOM_TYPE_LENGTH = 30;
const REDIS_SESSION_TTL = 3600;

// Переменные состояния системы восстановления
let lastHealthCheck = 0;
let consecutiveErrors = 0;
let lastNotifications = { recovery: 0, critical: 0 };

// Текстовые константы
const HELP_TEXT = `*❓ Renovation Project Bot Help*

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

const ABOUT_TEXT = `*📊 About Renovation Project Bot*

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

const SURVEY_START_TEXT = `📝 *Starting Project Survey*

I will guide you through 7 questions about your completed renovation project.

⚠️ First 2 questions are required (client name and room type).

Let's begin!`;

const WELCOME_TEXT = `🏠 *Welcome to Renovation Project Bot!*

I help collect information about completed renovation projects for content creation, CRM management, and business analytics.

*Choose an option below to get started:*`;

// Структурированные вопросы анкеты
const questions = [
  {
    id: 'client_name',
    text: "🙋‍♂️ What is the client's name?\n\n📏 Maximum 50 characters\n💡 Examples: John Smith, Maria Rodriguez, ABC Construction",
    required: true,
    maxLength: MAX_CLIENT_NAME_LENGTH,
    field: 'Client Name'
  },
  {
    id: 'room_type',
    text: "🏗️ What room did you work on?\n\n📏 Maximum 30 characters\n💡 Enter only room names or list of rooms\n\nExamples: Kitchen, Living Room, Bathroom, House",
    required: true,
    maxLength: MAX_ROOM_TYPE_LENGTH,
    field: 'Room Type'
  },
  {
    id: 'location',
    text: "📍 In which city and state was this project completed?",
    required: false,
    field: 'Location'
  },
  {
    id: 'goal',
    text: "🌟 What was the client's goal for this space?\n\nExamples: modernize layout, fix poor lighting, update style, old renovation, etc.",
    required: false,
    field: 'Goal'
  },
  {
    id: 'work_done',
    text: "💪 What work was done during the remodel?",
    required: false,
    field: 'Work Done'
  },
  {
    id: 'materials',
    text: "🧱 What materials were used?\n\nInclude names, colors, manufacturers if possible",
    required: false,
    field: 'Materials'
  },
  {
    id: 'features',
    text: "✨ Were there any interesting features or smart solutions implemented?\n\nExamples: round lighting, hidden drawers, custom panels",
    required: false,
    field: 'Features'
  }
];

// Заголовки для Google Sheets
const COLUMN_HEADERS = [
  'Date', 'Client Name', 'Room Type', 'Location',
  'Goal', 'Work Done', 'Materials', 'Features', 'Drive Folder'
];

// ============================================================================
// УТИЛИТЫ И ЛОГИРОВАНИЕ
// ============================================================================

// Безопасное debug логирование
function debugLog(message, ...args) {
  if (DEBUG_MODE) {
    console.log(message, ...args);
  }
}

// Безопасное логирование сообщений пользователей
function logUserMessage(userId, text, type = 'message') {
  const maskedUserId = '***' + userId.toString().slice(-4);
  const sanitizedText = text ? text.substring(0, 50).replace(/[^\w\s\-]/g, '') : 'empty';
  console.log(`${type} from user [${maskedUserId}]: [${sanitizedText}...]`);
}

// Безопасное логирование обновлений
function logUpdate(update) {
  if (DEBUG_MODE) {
    console.log('Update received:', {
      type: update.message ? 'message' : update.callback_query ? 'callback_query' : 'unknown',
      userId: update.message?.from?.id ? '***' + update.message.from.id.toString().slice(-4) :
              update.callback_query?.from?.id ? '***' + update.callback_query.from.id.toString().slice(-4) : 'unknown',
      hasText: !!update.message?.text,
      hasCallback: !!update.callback_query?.data
    });
  }
}

// ============================================================================
// СИСТЕМА АВТОМАТИЧЕСКОГО ВОССТАНОВЛЕНИЯ WEBHOOK
// ============================================================================

// Проверка возможности отправки уведомления
function canSendNotification(type) {
  const now = Date.now();
  const lastSent = lastNotifications[type] || 0;
  
  if (now - lastSent < NOTIFICATION_SETTINGS.MIN_NOTIFICATION_INTERVAL) {
    return false;
  }
  
  if (NOTIFICATION_SETTINGS.QUIET_HOURS.enabled) {
    const currentHour = new Date().getHours();
    const start = NOTIFICATION_SETTINGS.QUIET_HOURS.start;
    const end = NOTIFICATION_SETTINGS.QUIET_HOURS.end;
    
    if (start > end) {
      if (currentHour >= start || currentHour < end) return false;
    } else {
      if (currentHour >= start && currentHour < end) return false;
    }
  }
  
  return true;
}

// Автоматическая самодиагностика webhook
async function selfHealingCheck() {
  const now = Date.now();
  
  if (now - lastHealthCheck < HEALTH_CHECK_INTERVAL) {
    return true;
  }
  
  lastHealthCheck = now;
  
  try {
    debugLog('🔍 Self-healing check started');
    
    const botToken = process.env.BOT_TOKEN;
    const expectedUrl = 'https://renovation-bot-six.vercel.app/api/webhook';
    
    const webhookInfo = await getWebhookInfo(botToken);
    if (!webhookInfo.ok) throw new Error('Failed to get webhook info');
    
    const currentUrl = webhookInfo.result?.url;
    const pendingCount = webhookInfo.result?.pending_update_count || 0;
    const lastErrorDate = webhookInfo.result?.last_error_date || 0;
    const hasRecentErrors = lastErrorDate > 0 && (now/1000 - lastErrorDate) < 300;
    
    debugLog(`Webhook status: URL match=${currentUrl === expectedUrl}, Pending=${pendingCount}`);
    
    const needsHealing = (
      currentUrl !== expectedUrl ||
      pendingCount > 5 ||
      hasRecentErrors
    );
    
    if (needsHealing) {
      console.log('🚨 Bot needs healing - attempting recovery');
      
      const healResult = await healWebhook(botToken, expectedUrl);
      
      if (healResult.success) {
        consecutiveErrors = 0;
        console.log('✅ Bot self-healed successfully');
        
        await notifyAdminSafe('recovery', {
          previousUrl: currentUrl,
          pendingCount: pendingCount,
          healedAt: new Date().toLocaleString()
        });
        
        return true;
      } else {
        consecutiveErrors++;
        console.error(`❌ Self-healing failed (attempt ${consecutiveErrors})`);
        
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          await notifyAdminSafe('critical', {
            consecutiveErrors,
            lastError: healResult.error
          });
        }
        return false;
      }
    } else {
      consecutiveErrors = 0;
      debugLog('✅ Bot is healthy');
      return true;
    }
    
  } catch (error) {
    consecutiveErrors++;
    console.error('❌ Self-healing check error:', error.message);
    
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      await notifyAdminSafe('critical', {
        consecutiveErrors,
        lastError: error.message
      });
    }
    return false;
  }
}

// Получение информации о webhook
function getWebhookInfo(botToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${botToken}/getWebhookInfo`,
      method: 'GET'
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy();
      reject(new Error('Webhook info timeout'));
    });
    
    req.end();
  });
}

// Восстановление webhook
async function healWebhook(botToken, url) {
  try {
    debugLog('🔧 Healing webhook');
    
    await deleteWebhook(botToken);
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const setResult = await setWebhookHTTPS(botToken, url);
    
    if (setResult.ok) {
      debugLog('✅ Webhook healed successfully');
      return { success: true };
    } else {
      throw new Error(setResult.description || 'Unknown error');
    }
    
  } catch (error) {
    console.error('❌ Webhook healing failed:', error.message);
    return { success: false, error: error.message };
  }
}

function deleteWebhook(botToken) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ url: '' });
    
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${botToken}/setWebhook`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          resolve({ ok: true });
        }
      });
    });
    
    req.on('error', () => resolve({ ok: true }));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ ok: true });
    });
    
    req.write(postData);
    req.end();
  });
}

function setWebhookHTTPS(botToken, url) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      url: url,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true
    });
    
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${botToken}/setWebhook`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy();
      reject(new Error('Set webhook timeout'));
    });
    
    req.write(postData);
    req.end();
  });
}

// Безопасные уведомления админа
async function notifyAdminSafe(type, data) {
  try {
    const adminChatId = process.env.ADMIN_CHAT_ID;
    if (!adminChatId) return;
    
    if (type === 'recovery' && !NOTIFICATION_SETTINGS.NOTIFY_RECOVERY) return;
    if (type === 'critical' && !NOTIFICATION_SETTINGS.NOTIFY_CRITICAL) return;
    
    if (!canSendNotification(type)) {
      debugLog(`Notification ${type} skipped (rate limited)`);
      return;
    }
    
    let message = '';
    
    if (type === 'recovery') {
      message = `🤖 Bot Auto-Recovery!\n\n` +
                `✅ Automatically fixed\n` +
                `Previous URL: ${data.previousUrl?.substring(0, 40)}...\n` +
                `Pending: ${data.pendingCount}\n` +
                `Time: ${data.healedAt}`;
                
    } else if (type === 'critical') {
      message = `🚨 Bot Critical Issue!\n\n` +
                `❌ ${data.consecutiveErrors} healing failures\n` +
                `Time: ${new Date().toLocaleString()}\n\n` +
                `Check: https://renovation-bot-six.vercel.app/api/webhook`;
    }
    
    if (message) {
      await sendMessage(adminChatId, message);
      lastNotifications[type] = Date.now();
      debugLog(`Admin notification sent: ${type}`);
    }
    
  } catch (error) {
    console.error('❌ Admin notification failed:', error.message);
  }
}

// ============================================================================
// ИНИЦИАЛИЗАЦИЯ СЕРВИСОВ
// ============================================================================

// Инициализация Redis
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Авторизованные пользователи
const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS ? 
  process.env.AUTHORIZED_USERS.split(',').map(id => parseInt(id.trim())) : 
  [];

debugLog('Authorized users loaded:', AUTHORIZED_USERS.length);

// Функция проверки авторизации
function isUserAuthorized(userId) {
  if (AUTHORIZED_USERS.length === 0) return true;
  return AUTHORIZED_USERS.includes(userId);
}

// ============================================================================
// REDIS ФУНКЦИИ (С УЛУЧШЕННОЙ ОБРАБОТКОЙ ОШИБОК)
// ============================================================================

async function getSession(userId) {
  try {
    debugLog(`Getting session for user ***${userId.toString().slice(-4)}`);
    const session = await redis.get(`session_${userId}`);
    return session;
  } catch (error) {
    console.error('❌ Redis get session error:', error.message);
    throw error; // Пробрасываем ошибку выше для обработки
  }
}

async function saveSession(userId, step, answers) {
  try {
    debugLog(`Saving session for user ***${userId.toString().slice(-4)}, step ${step}`);
    const sessionData = { step, answers, timestamp: Date.now() };
    await redis.set(`session_${userId}`, sessionData, { ex: REDIS_SESSION_TTL });
    return true;
  } catch (error) {
    console.error('❌ Redis save session error:', error.message);
    throw error; // Пробрасываем ошибку выше для обработки
  }
}

async function deleteSession(userId) {
  try {
    debugLog(`Deleting session for user ***${userId.toString().slice(-4)}`);
    await redis.del(`session_${userId}`);
    return true;
  } catch (error) {
    console.error('❌ Redis delete session error:', error.message);
    // Для удаления сессии не критично если не удалось
    return false;
  }
}

// ============================================================================
// ВАЛИДАЦИЯ И ОБРАБОТКА ДАННЫХ
// ============================================================================

// Универсальная функция валидации
function validateUserInput(questionConfig, input) {
  const trimmedInput = input.trim();
  
  if (questionConfig.required && trimmedInput.length === 0) {
    return { 
      valid: false, 
      error: `${questionConfig.field} cannot be empty` 
    };
  }
  
  if (questionConfig.maxLength && trimmedInput.length > questionConfig.maxLength) {
    return { 
      valid: false, 
      error: `${questionConfig.field} is too long (${trimmedInput.length}/${questionConfig.maxLength} characters)` 
    };
  }
  
  return { valid: true, cleanInput: trimmedInput };
}

// Санитизация и валидация названий папок
function sanitizeAndValidateFolderName(clientName, roomType) {
  const cleanClient = clientName.replace(/[<>:"/\\|?*]/g, '').trim().substring(0, MAX_CLIENT_NAME_LENGTH);
  const cleanRoom = roomType.replace(/[<>:"/\\|?*]/g, '').trim().substring(0, MAX_ROOM_TYPE_LENGTH);
  
  return { 
    clientName: cleanClient.replace(/\s+/g, ' ') || 'Unknown Client', 
    roomType: cleanRoom.replace(/\s+/g, ' ') || 'Unknown Room' 
  };
}

// Генерация содержимого файла проекта
function generateProjectFileContent(answers, driveFolder) {
  const date = new Date().toLocaleDateString('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric'
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

// ============================================================================
// GOOGLE SERVICES (С УЛУЧШЕННОЙ ОБРАБОТКОЙ ОШИБОК)
// ============================================================================

// Создание файла в Google Drive
async function createProjectFile(folderId, fileName, content, accessToken) {
  return new Promise((resolve, reject) => {
    debugLog(`Creating file: ${fileName}`);
    
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
        if (res.statusCode === 200) {
          try {
            const result = JSON.parse(data);
            debugLog(`File created: ${result.id}`);
            resolve(result);
          } catch (parseError) {
            reject(new Error(`File creation parse error: ${parseError.message}`));
          }
        } else {
          reject(new Error(`Drive API error: ${res.statusCode}`));
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy();
      reject(new Error('File creation timeout'));
    });
    
    req.write(multipartRequestBody);
    req.end();
  });
}

// Создание проектной папки с параллельным созданием подпапок
async function createProjectFolder(clientName, roomType, location) {
  try {
    debugLog('Creating project folder');
    
    const cleaned = sanitizeAndValidateFolderName(clientName, roomType);
    
    let serviceAccountKey;
    try {
      serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    } catch (parseError) {
      console.error('❌ Invalid Google service account configuration');
      throw new Error('Google service account parsing failed');
    }
    
    const serviceAccountAuth = new JWT({
      email: serviceAccountKey.client_email,
      key: serviceAccountKey.private_key,
      scopes: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive'
      ],
    });

    const token = await serviceAccountAuth.getAccessToken();
    
    const date = new Date().toLocaleDateString('en-US', {
      month: '2-digit', day: '2-digit', year: 'numeric'
    });
    const folderName = `${cleaned.clientName} - ${cleaned.roomType} - ${date}`;
    
    const mainFolderData = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [process.env.PARENT_FOLDER_ID]
    };
    
    const mainFolder = await createDriveFolder(mainFolderData, token.token);
    debugLog(`Main folder created: ${mainFolder.id}`);
    
    // Параллельное создание подпапок (оптимизация!)
    const subfolders = ['Before', 'After', '3D Visualization', 'Floor Plans'];
    const subfolderPromises = subfolders.map(name => 
      createDriveFolder({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [mainFolder.id]
      }, token.token).catch(error => {
        debugLog(`Error creating subfolder "${name}":`, error.message);
        return null;
      })
    );
    
    const createdSubfolders = await Promise.all(subfolderPromises);
    debugLog(`Created ${createdSubfolders.filter(Boolean).length} subfolders`);
    
    // Установка прав доступа (не критично если не удастся)
    setFolderPermissions(mainFolder.id, token.token).catch(() => {});
    
    const folderUrl = `https://drive.google.com/drive/folders/${mainFolder.id}?usp=sharing`;
    
    return {
      folderId: mainFolder.id,
      folderName: folderName,
      folderUrl: folderUrl,
      subfolders: createdSubfolders.filter(Boolean),
      token: token.token
    };
    
  } catch (error) {
    console.error('❌ Error creating project folder:', error.message);
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
            reject(new Error(`Drive folder parse error: ${parseError.message}`));
          }
        } else {
          reject(new Error(`Drive API error: ${res.statusCode}`));
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy();
      reject(new Error('Drive folder timeout'));
    });
    
    req.write(postData);
    req.end();
  });
}

async function setFolderPermissions(folderId, accessToken) {
  return new Promise((resolve) => {
    const permissionData = { role: 'reader', type: 'anyone' };
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
      res.on('end', () => resolve(res.statusCode === 200));
    });
    
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(false);
    });
    
    req.write(postData);
    req.end();
  });
}

async function initializeGoogleSheets() {
  try {
    let serviceAccountKey;
    try {
      serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    } catch (parseError) {
      console.error('❌ Invalid Google service account configuration');
      throw new Error('Google service account parsing failed');
    }
    
    const serviceAccountAuth = new JWT({
      email: serviceAccountKey.client_email,
      key: serviceAccountKey.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    
    let sheet = doc.sheetsByIndex[0];
    if (!sheet) {
      sheet = await doc.addSheet({ title: 'Renovation Projects' });
    }
    
    await sheet.loadHeaderRow();
    
    if (!sheet.headerValues || sheet.headerValues.length === 0) {
      await sheet.setHeaderRow(COLUMN_HEADERS);
      await sheet.loadHeaderRow();
    }
    
    return sheet;
    
  } catch (error) {
    console.error('❌ Google Sheets error:', error.message);
    throw error;
  }
}

async function addRowToSheet(answers, driveFolder) {
  try {
    const sheet = await initializeGoogleSheets();
    
    if (!sheet) {
      throw new Error('Failed to initialize Google Sheets');
    }
    
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
    debugLog(`Row added: ${addedRow._rowNumber}`);
    
    return true;
    
  } catch (error) {
    console.error('❌ Google Sheets error:', error.message);
    throw error;
  }
}

// ============================================================================
// TELEGRAM API
// ============================================================================

// Отправка сообщения
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
    
    debugLog(`Sending message to ***${chatId.toString().slice(-4)}`);
    
    const request = https.request(requestOptions, (response) => {
      let data = '';
      response.on('data', (chunk) => data += chunk);
      response.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.ok) {
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
    
    request.setTimeout(REQUEST_TIMEOUT, () => {
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
    debugLog('Bot commands set up');
  } catch (error) {
    console.error('❌ Error setting up commands:', error.message);
  }
}

// ============================================================================
// UI КОМПОНЕНТЫ
// ============================================================================

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
  await sendMessage(chatId, WELCOME_TEXT, createMainMenu());
}

// ============================================================================
// БИЗНЕС-ЛОГИКА (С УЛУЧШЕННОЙ ОБРАБОТКОЙ ОШИБОК И ПАРАЛЛЕЛИЗМОМ)
// ============================================================================

async function processCompletedSurvey(chatId, userId, answers) {
  try {
    console.log('🎯 Processing completed survey');
    
    await sendMessage(chatId, "✅ Survey completed!\n\nCreating project folder...");
    
    // 1. Создаем папку и проверяем критический результат
    const driveFolder = await createProjectFolder(
      answers[0] || 'Unknown Client',
      answers[1] || 'Unknown Room', 
      answers[2] || 'Unknown Location'
    );
    
    // 2. КРИТИЧЕСКАЯ ПРОВЕРКА
    if (!driveFolder || !driveFolder.folderId) {
      throw new Error('Failed to create project folder - cannot continue');
    }
    
    // 3. ПАРАЛЛЕЛЬНЫЕ ОПЕРАЦИИ с правильной обработкой ошибок
    const [fileResult, sheetResult] = await Promise.allSettled([
      createProjectFile(
        driveFolder.folderId, 
        `${answers[0] || 'Project'} - Project Brief.txt`,
        generateProjectFileContent(answers, driveFolder),
        driveFolder.token
      ),
      addRowToSheet(answers, driveFolder)
    ]);
    
    // 4. Проверяем результаты операций
    if (fileResult.status === 'rejected') {
      console.error('❌ File creation failed:', fileResult.reason.message);
      // Не критично - продолжаем
    }
    
    if (sheetResult.status === 'rejected') {
      console.error('❌ Sheets update failed:', sheetResult.reason.message);
      // Это критическая ошибка - данные не сохранены
      throw sheetResult.reason;
    }
    
    // 5. ПАРАЛЛЕЛЬНЫЕ УВЕДОМЛЕНИЯ
    const adminChatId = process.env.ADMIN_CHAT_ID;
    const notificationPromises = [];
    
    if (adminChatId) {
      const notification = createAdminNotification(answers, driveFolder);
      notificationPromises.push(sendMessage(adminChatId, notification));
    }
    
    const confirmationMessage = `✅ Project successfully processed!

📁 Folder: ${driveFolder.folderName}

📤 Please upload your project files to these folders:

Before photos - Before folder
After photos - After folder  
3D renderings - 3D Visualization folder
Floor plans - Floor Plans folder

🔗 ${driveFolder.folderUrl}

Use /start for main menu`;

    notificationPromises.push(sendMessage(chatId, confirmationMessage, {
      reply_markup: { remove_keyboard: true }
    }));
    
    // 6. Отправляем уведомления параллельно
    await Promise.allSettled(notificationPromises);
    
    await deleteSession(userId);
    console.log('✅ Survey processing complete');
    
  } catch (error) {
    console.error('❌ Error processing survey:', error.message);
    await deleteSession(userId);
    await sendMessage(chatId, `❌ Error processing survey: ${error.message}`);
  }
}

// ============================================================================
// COMMAND HANDLERS (DRY ПРИНЦИП)
// ============================================================================

const commandHandlers = {
  '/start': async (chatId, userId) => {
    setupBotCommands().catch(() => {});
    await showMainMenu(chatId);
  },
  
  '/survey': async (chatId, userId) => {
    await saveSession(userId, 0, []);
    await sendMessage(chatId, SURVEY_START_TEXT);
    await sendMessage(chatId, questions[0].text, {
      reply_markup: { remove_keyboard: true }
    });
  },
  
  '/help': async (chatId, userId) => {
    await sendMessage(chatId, HELP_TEXT);
  },
  
  '/cancel': async (chatId, userId) => {
    await deleteSession(userId);
    await sendMessage(chatId, '❌ Survey cancelled.\n\nUse /start to return to the main menu.', {
      reply_markup: { remove_keyboard: true }
    });
  }
};

// ============================================================================
// ОСНОВНОЙ HANDLER
// ============================================================================

export default async function handler(req, res) {
  console.log(`${new Date().toISOString()} - ${req.method} request received`);
  
  // Автоматическая самодиагностика webhook (НЕ keepalive!)
  selfHealingCheck().catch(() => {});
  
  if (req.method === 'GET') {
    return res.status(200).json({ 
      message: 'Renovation Bot - Production Ready',
      status: 'active',
      timestamp: new Date().toISOString(),
      lastHealthCheck: new Date(lastHealthCheck).toISOString(),
      consecutiveErrors: consecutiveErrors
    });
  }

  if (req.method !== 'POST') {
    return res.status(200).json({ message: 'This endpoint handles Telegram webhook events' });
  }

  try {
    const update = req.body;
    logUpdate(update);
    
    // Обработка callback queries
    if (update.callback_query) {
      const { message, from, data, id } = update.callback_query;
      const chatId = message.chat.id;
      const userId = from.id;
      
      logUserMessage(userId, data, 'callback');
      
      if (!isUserAuthorized(userId)) {
        await makeApiCall('answerCallbackQuery', {
          callback_query_id: id,
          text: "Access denied",
          show_alert: true
        });
        await sendMessage(chatId, `🚫 Access denied. Your ID: ${userId}`);
        return res.status(200).json({ ok: true });
      }
      
      await makeApiCall('answerCallbackQuery', { callback_query_id: id });
      
      if (data === 'start_survey') {
        await saveSession(userId, 0, []);
        await sendMessage(chatId, SURVEY_START_TEXT);
        await sendMessage(chatId, questions[0].text, { reply_markup: { remove_keyboard: true } });
        
      } else if (data === 'show_help') {
        await sendMessage(chatId, `*❓ How to Use This Bot*

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

Use /start anytime to return to the main menu.`);
        
      } else if (data === 'about_bot') {
        await sendMessage(chatId, ABOUT_TEXT);
      }
      
      return res.status(200).json({ ok: true });
    }
    
    if (!update.message) {
      return res.status(200).json({ ok: true });
    }
    
    const { chat, text, from } = update.message;
    const chatId = chat.id;
    const userId = from.id;
    
    logUserMessage(userId, text);
    
    if (!isUserAuthorized(userId)) {
      await sendMessage(chatId, `🚫 Access denied. Your ID: ${userId}`);
      return res.status(200).json({ ok: true });
    }
    
    // Обработка команд через handlers (DRY принцип)
    const handler = commandHandlers[text];
    if (handler) {
      await handler(chatId, userId);
      return res.status(200).json({ ok: true });
    }
    
    // Обработка ответов на вопросы анкеты
    let session;
    try {
      session = await getSession(userId);
    } catch (redisError) {
      console.error('❌ Redis unavailable:', redisError.message);
      await sendMessage(chatId, 
        '⚠️ Service temporarily unavailable. Please try again in a few minutes.\n\n' +
        'Use /start to return to main menu.'
      );
      return res.status(200).json({ ok: true });
    }
    
    if (session) {
      debugLog(`Session found: step ${session.step}`);
      
      if (!session.answers || !Array.isArray(session.answers)) {
        console.error('❌ Invalid session data');
        await deleteSession(userId);
        await sendMessage(chatId, 'Session expired. Please start a new survey with /start', {
          reply_markup: { remove_keyboard: true }
        });
        return res.status(200).json({ ok: true });
      }
      
      let answer = text;
      if (text === 'Skip this question ⏭️') {
        answer = 'Not specified';
      }
      
      const currentStep = session.step;
      const questionConfig = questions[currentStep];
      
      // Валидация с использованием универсальной функции
      if (questionConfig.required && answer !== 'Not specified') {
        const validation = validateUserInput(questionConfig, answer);
        
        if (!validation.valid) {
          await sendMessage(chatId, `❌ ${validation.error}.\n\nPlease try again:\n\n${questionConfig.text}`, {
            reply_markup: { remove_keyboard: true }
          });
          return res.status(200).json({ ok: true });
        }
        
        answer = validation.cleanInput;
      }
      
      session.answers[session.step] = answer;
      session.step++;
      
      if (session.step >= questions.length) {
        await processCompletedSurvey(chatId, userId, session.answers);
      } else {
        try {
          await saveSession(userId, session.step, session.answers);
        } catch (redisError) {
          console.error('❌ Failed to save session progress:', redisError.message);
          await sendMessage(chatId, 
            '⚠️ Unable to save progress. Please restart the survey with /start'
          );
          return res.status(200).json({ ok: true });
        }
        
        const nextQuestion = questions[session.step];
        const isSkippable = !nextQuestion.required;
        
        const replyMarkup = isSkippable ? {
          keyboard: [[{ text: 'Skip this question ⏭️' }]],
          resize_keyboard: true
        } : {
          remove_keyboard: true
        };
        
        await sendMessage(chatId, nextQuestion.text, { reply_markup: replyMarkup });
      }
    } else {
      await sendMessage(chatId, 'Hi! 👋 Use /start to see the main menu and available options.');
    }
    
    return res.status(200).json({ ok: true });
    
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
    return res.status(200).json({ ok: true });
  }
}
