import { Telegraf, Scenes, session } from 'telegraf';
import { addRowToSheet } from './googleSheets.js';
import { validateDriveLink, createAdminNotification } from './utils.js';

// Create bot instance
export function createBot() {
  const bot = new Telegraf(process.env.BOT_TOKEN);
  
  // Add middleware for session handling
  bot.use(session());
  
  // Create survey scene
  const surveyScene = new Scenes.WizardScene(
    'SURVEY_SCENE',
    // Step 1: Client name
    (ctx) => {
      ctx.wizard.state.data = {}; // Initialize data storage object
      ctx.reply('🙋‍♂️ What is the *client\'s name*?', {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [
            [{ text: 'Skip this question ⏭️' }]
          ],
          resize_keyboard: true
        }
      });
      return ctx.wizard.next();
    },
    // Step 2: Room type
    (ctx) => {
      if (ctx.message.text !== 'Skip this question ⏭️') {
        ctx.wizard.state.data.client_name = ctx.message.text;
      } else {
        ctx.wizard.state.data.client_name = "Not specified";
      }
      
      ctx.reply('🏗️ What *room* did you work on? (e.g. kitchen, bathroom, laundry room)', {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [
            [{ text: 'Skip this question ⏭️' }]
          ],
          resize_keyboard: true
        }
      });
      return ctx.wizard.next();
    },
    // Step 3: Location (city, state)
    (ctx) => {
      if (ctx.message.text !== 'Skip this question ⏭️') {
        ctx.wizard.state.data.room_type = ctx.message.text;
      } else {
        ctx.wizard.state.data.room_type = "Not specified";
      }
      
      ctx.reply('📍 In which *city and state* was this project completed?', {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [
            [{ text: 'Skip this question ⏭️' }]
          ],
          resize_keyboard: true
        }
      });
      return ctx.wizard.next();
    },
    // Step 4: Client's goal
    (ctx) => {
      if (ctx.message.text !== 'Skip this question ⏭️') {
        ctx.wizard.state.data.location = ctx.message.text;
      } else {
        ctx.wizard.state.data.location = "Not specified";
      }
      
      ctx.reply('🌟 What was the *client\'s goal* for this space? (e.g. modernize layout, fix poor lighting, update style, old renovation, etc.)', {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [
            [{ text: 'Skip this question ⏭️' }]
          ],
          resize_keyboard: true
        }
      });
      return ctx.wizard.next();
    },
    // Step 5: Work done
    (ctx) => {
      if (ctx.message.text !== 'Skip this question ⏭️') {
        ctx.wizard.state.data.goal = ctx.message.text;
      } else {
        ctx.wizard.state.data.goal = "Not specified";
      }
      
      ctx.reply('💪 What *work was done* during the remodel?', {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [
            [{ text: 'Skip this question ⏭️' }]
          ],
          resize_keyboard: true
        }
      });
      return ctx.wizard.next();
    },
    // Step 6: Materials used
    (ctx) => {
      if (ctx.message.text !== 'Skip this question ⏭️') {
        ctx.wizard.state.data.what_done = ctx.message.text;
      } else {
        ctx.wizard.state.data.what_done = "Not specified";
      }
      
      ctx.reply('🧱 What *materials* were used? (Include names, colors, manufacturers if possible)', {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [
            [{ text: 'Skip this question ⏭️' }]
          ],
          resize_keyboard: true
        }
      });
      return ctx.wizard.next();
    },
    // Step 7: Interesting features
    (ctx) => {
      if (ctx.message.text !== 'Skip this question ⏭️') {
        ctx.wizard.state.data.materials = ctx.message.text;
      } else {
        ctx.wizard.state.data.materials = "Not specified";
      }
      
      ctx.reply('✨ Were there any *interesting features* or smart solutions implemented? (e.g. round lighting, hidden drawers, custom panels)', {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [
            [{ text: 'Skip this question ⏭️' }]
          ],
          resize_keyboard: true
        }
      });
      return ctx.wizard.next();
    },
    // Step 8: Google Drive link
    (ctx) => {
      if (ctx.message.text !== 'Skip this question ⏭️') {
        ctx.wizard.state.data.features = ctx.message.text;
      } else {
        ctx.wizard.state.data.features = "Not specified";
      }
      
      ctx.reply('📂 Please *paste the Google Drive folder link* (with subfolders: before / after / 3D / drawings)', {
        parse_mode: 'Markdown',
        reply_markup: {
          remove_keyboard: true
        }
      });
      return ctx.wizard.next();
    },
    // Final step: data processing
    async (ctx) => {
      if (!ctx.message || !ctx.message.text) {
        ctx.reply('Please provide a valid Google Drive link.');
        return;
      }
      
      const driveLink = ctx.message.text;
      
      // Check if it's a Google Drive link
      if (!validateDriveLink(driveLink)) {
        ctx.reply('Please provide a valid Google Drive link. Send /start to try again.');
        return ctx.scene.leave();
      }
      
      // Save Google Drive link
      ctx.wizard.state.data.drive_link = driveLink;
      
      // Display collected data to user
      const data = ctx.wizard.state.data;
      const summaryMessage = `
*Summary of the submitted project:*
👤 Client: ${data.client_name}
🏗️ Room: ${data.room_type}
📍 Location: ${data.location}
🌟 Goal: ${data.goal}
💪 Work done: ${data.what_done}
🧱 Materials: ${data.materials}
✨ Features: ${data.features}
📂 Drive: ${data.drive_link}

Processing your data...
      `;
      
      await ctx.reply(summaryMessage, {
        parse_mode: 'Markdown'
      });
      
      try {
        // Add data to Google Sheets
        await addRowToSheet(data);
        
        // Send notification to admin
        const adminChatId = process.env.ADMIN_CHAT_ID;
        if (adminChatId) {
          const notificationText = createAdminNotification(data);
          
          await ctx.telegram.sendMessage(adminChatId, notificationText);
        }
        
        // Confirmation to user
        await ctx.reply('✅ Project data has been successfully saved! Thank you for your submission.', {
          reply_markup: {
            remove_keyboard: true
          }
        });
      } catch (error) {
        console.error('Error processing project data:', error);
        await ctx.reply('❌ An error occurred while saving your data. Please try again later or contact support.');
      }
      
      return ctx.scene.leave();
    }
  );
  
  // Create scene manager
  const stage = new Scenes.Stage([surveyScene]);
  bot.use(stage.middleware());
  
  // /start command handler
  bot.command('start', (ctx) => {
    ctx.reply('👋 Welcome to the Renovation Project Bot! I will guide you through the process of submitting information about completed renovation projects.', {
      reply_markup: {
        remove_keyboard: true
      }
    });
    
    // Small delay before starting survey
    setTimeout(() => {
      ctx.scene.enter('SURVEY_SCENE');
    }, 500);
  });
  
  // /help command handler
  bot.command('help', (ctx) => {
    ctx.reply(`
*Renovation Project Bot Help*

This bot collects information about completed renovation projects.

*Available commands:*
/start - Start the survey
/help - Show this help message
/cancel - Cancel the current survey

During the survey, you can skip any question by clicking the "Skip this question ⏭️" button.
    `, {
      parse_mode: 'Markdown'
    });
  });
  
  // /cancel command handler
  bot.command('cancel', (ctx) => {
    ctx.reply('Survey cancelled. Use /start to begin a new survey.', {
      reply_markup: {
        remove_keyboard: true
      }
    });
    ctx.scene.leave();
  });
  
  return bot;
}
