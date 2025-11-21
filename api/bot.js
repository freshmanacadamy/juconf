const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
require('dotenv').config();

// Environment validation
const requiredEnv = [
  'BOT_TOKEN',
  'FIREBASE_PROJECT_ID', 
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_CLIENT_EMAIL',
  'ADMIN_IDS',
  'CHANNEL_ID',
  'BOT_USERNAME' // Added this requirement
];

for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Initialize Firebase
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log('✅ Firebase initialized successfully');
}

const db = admin.firestore();
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

// Global variables
let confessionCounter = 0;

// Initialize confession counter
async function initializeCounter() {
  try {
    const counterDoc = await db.collection('system').doc('counters').get();
    
    if (!counterDoc.exists) {
      const snapshot = await db.collection('confessions')
        .where('status', '==', 'approved')
        .orderBy('confessionNumber', 'desc')
        .limit(1)
        .get();
      
      let maxConfession = 0;
      if (!snapshot.empty) {
        maxConfession = snapshot.docs[0].data().confessionNumber || 0;
      }
      
      await db.collection('system').doc('counters').set({
        confessionNumber: maxConfession,
        lastAssigned: new Date().toISOString(),
        initialized: new Date().toISOString()
      });
      
      confessionCounter = maxConfession;
    } else {
      const data = counterDoc.data();
      confessionCounter = data.confessionNumber || 0;
    }
  } catch (error) {
    console.error('Counter init error:', error);
    confessionCounter = 0;
  }
}

// Get next confession number
async function getNextConfessionNumber() {
  const counterRef = db.collection('system').doc('counters');
  
  try {
    const result = await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(counterRef);
      
      if (!doc.exists) {
        transaction.set(counterRef, {
          confessionNumber: 1,
          lastAssigned: new Date().toISOString()
        });
        return 1;
      }
      
      const current = doc.data().confessionNumber;
      const next = current + 1;
      
      transaction.update(counterRef, {
        confessionNumber: next,
        lastAssigned: new Date().toISOString()
      });
      
      return next;
    });
    
    return result;
  } catch (error) {
    console.error('Transaction failed: ', error);
    throw error;
  }
}

// Persistent cooldown system
async function checkCooldown(userId, action = 'confession', cooldownMs = 60000) {
  const cooldownRef = db.collection('user_cooldowns').doc(userId.toString());
  const doc = await cooldownRef.get();
  
  if (!doc.exists) return true;
  
  const data = doc.data();
  const lastAction = data[action];
  
  if (!lastAction) return true;
  
  return (Date.now() - lastAction) > cooldownMs;
}

async function setCooldown(userId, action = 'confession') {
  const cooldownRef = db.collection('user_cooldowns').doc(userId.toString());
  await cooldownRef.set({
    [action]: Date.now(),
    updatedAt: new Date().toISOString()
  }, { merge: true });
}

// Comment rate limiting
async function checkCommentRateLimit(userId, windowMs = 30000, maxComments = 3) {
  const rateLimitRef = db.collection('user_rate_limits').doc(userId.toString());
  const doc = await rateLimitRef.get();
  
  if (!doc.exists) return true;
  
  const data = doc.data();
  const recentComments = data.commentTimestamps || [];
  
  const now = Date.now();
  const recent = recentComments.filter(ts => (now - ts) <= windowMs);
  
  return recent.length < maxComments;
}

async function recordComment(userId) {
  const rateLimitRef = db.collection('user_rate_limits').doc(userId.toString());
  const now = Date.now();
  
  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(rateLimitRef);
    
    if (!doc.exists) {
      transaction.set(rateLimitRef, {
        commentTimestamps: [now],
        updatedAt: new Date().toISOString()
      });
    } else {
      transaction.update(rateLimitRef, {
        commentTimestamps: admin.firestore.FieldValue.arrayUnion(now),
        updatedAt: new Date().toISOString()
      });
    }
  });
}

// Admin verification
function isAdmin(userId) {
  if (!userId || typeof userId !== 'number' && typeof userId !== 'string') {
    return false;
  }
  
  const adminIds = process.env.ADMIN_IDS?.split(',').map(id => id.trim()) || [];
  return adminIds.includes(userId.toString());
}

// Input sanitization
function sanitizeInput(text) {
  if (!text) return '';
  
  let sanitized = text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .replace(/<[^>]*>/g, '')
    .trim();
  
  return sanitized;
}

// Reputation system
async function updateReputation(userId, points) {
  try {
    await db.collection('users').doc(userId.toString()).update({
      reputation: admin.firestore.FieldValue.increment(points)
    });
  } catch (error) {
    console.error('Reputation update error:', error);
  }
}

// Achievement system
async function checkAchievements(userId) {
  const profile = await getUserProfile(userId);
  
  const achievements = [];
  
  if (profile.totalConfessions >= 1 && !profile.achievements?.includes('first_confession')) {
    achievements.push('first_confession');
    await awardAchievement(userId, 'first_confession', 'First Confession!');
  }
  
  if (profile.totalConfessions >= 10 && !profile.achievements?.includes('ten_confessions')) {
    achievements.push('ten_confessions');
    await awardAchievement(userId, 'ten_confessions', 'Confession Master (10)!');
  }
  
  if (profile.followers?.length >= 50 && !profile.achievements?.includes('fifty_followers')) {
    achievements.push('fifty_followers');
    await awardAchievement(userId, 'fifty_followers', 'Popular User (50 followers)!');
  }
  
  if (profile.dailyStreak >= 7 && !profile.achievements?.includes('week_streak')) {
    achievements.push('week_streak');
    await awardAchievement(userId, 'week_streak', 'Week Streak!');
  }
}

async function awardAchievement(userId, achievementId, message) {
  try {
    await db.collection('users').doc(userId.toString()).update({
      achievements: admin.firestore.FieldValue.arrayUnion(achievementId),
      achievementCount: admin.firestore.FieldValue.increment(1)
    });
    
    await bot.sendMessage(userId, `🎉 Achievement Unlocked!\n\n${message}`);
  } catch (error) {
    console.error('Achievement award error:', error);
  }
}

// Hashtag system
function extractHashtags(text) {
  const hashtagRegex = /#[a-zA-Z0-9_]+/g;
  return text.match(hashtagRegex) || [];
}

// User profile management
async function getUserProfile(userId) {
  const userDoc = await db.collection('users').doc(userId.toString()).get();
  
  if (!userDoc.exists) {
    const newProfile = {
      userId: userId,
      username: null,
      bio: null,
      followers: [],
      following: [],
      joinDate: new Date().toISOString(),
      totalConfessions: 0,
      reputation: 0,
      isActive: true,
      isRegistered: false,
      achievements: [],
      achievementCount: 0,
      dailyStreak: 0,
      lastCheckin: null,
      notifications: {
        confessionApproved: true,
        newComment: true,
        newFollower: true,
        newConfession: true
      },
      tags: []
    };
    
    await db.collection('users').doc(userId.toString()).set(newProfile);
    return newProfile;
  }
  
  return userDoc.data();
}

// Bot commands and message handling
const commandHandlers = {
  '/start': async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const args = msg.text.split(' ')[1];
    
    if (args && args.startsWith('comments_')) {
      // Handle comment redirection - for now just show a message
      await bot.sendMessage(chatId, 'Comments feature coming soon!');
      return;
    }
    
    const profile = await getUserProfile(userId);
    
    if (!profile.isActive) {
      await bot.sendMessage(chatId, '❌ Your account has been blocked by admin.');
      return;
    }
    
    if (!profile.isRegistered) {
      await db.collection('users').doc(userId.toString()).update({
        isRegistered: true
      });
    }
    
    const text = `🤫 *Welcome to JU Confession Bot!*\n\nSend me your confession and it will be submitted anonymously for admin approval.\n\nYour identity will never be revealed!`;
    
    const keyboard = {
      reply_markup: {
        keyboard: [
          ['📝 Send Confession', '👤 My Profile'],
          ['🔥 Trending', '🎯 Daily Check-in'],
          ['🏷️ Hashtags', '🏆 Achievements'],
          ['⚙️ Settings', 'ℹ️ About Us'],
          ['🔍 Browse Users', '📌 Rules']
        ],
        resize_keyboard: true
      }
    };
    
    await bot.sendMessage(chatId, text, { 
      parse_mode: 'Markdown',
      ...keyboard
    });
  },

  '/checkin': async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const profile = await getUserProfile(userId);
    
    if (!profile.isActive) {
      await bot.sendMessage(chatId, '❌ Your account has been blocked by admin.');
      return;
    }
    
    const today = new Date().toDateString();
    const lastCheckin = profile.lastCheckin ? new Date(profile.lastCheckin).toDateString() : null;
    
    if (lastCheckin === today) {
      await bot.sendMessage(chatId, `✅ You already checked in today!\n\nCurrent streak: ${profile.dailyStreak} days`);
      return;
    }
    
    let newStreak = 1;
    if (lastCheckin) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      
      if (lastCheckin === yesterday.toDateString()) {
        newStreak = profile.dailyStreak + 1;
      }
    }
    
    await db.collection('users').doc(userId.toString()).update({
      dailyStreak: newStreak,
      lastCheckin: new Date().toISOString()
    });
    
    await updateReputation(userId, 2);
    
    await bot.sendMessage(chatId, `🎉 Daily Check-in!\n\n✅ +2 reputation points\nCurrent streak: ${newStreak} days`);
    
    await checkAchievements(userId);
  },

  '/admin': async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    
    if (!isAdmin(userId)) {
      await bot.sendMessage(chatId, '❌ Access denied. Admin only command.');
      return;
    }
    
    const stats = await getBotStats();
    
    const text = `🔐 *Admin Dashboard*\n\n`;
    const users = `**Total Users:** ${stats.totalUsers}\n`;
    const confessions = `**Pending Confessions:** ${stats.pendingConfessions}\n`;
    const approved = `**Approved Confessions:** ${stats.approvedConfessions}\n`;
    const rejected = `**Rejected Confessions:** ${stats.rejectedConfessions}\n`;
    
    const fullText = text + users + confessions + approved + rejected;
    
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '👥 Manage Users', callback_data: 'manage_users' },
            { text: '📝 Review Confessions', callback_data: 'review_confessions' }
          ],
          [
            { text: '📢 Broadcast Message', callback_data: 'broadcast_message' },
            { text: '📊 Bot Statistics', callback_ 'bot_stats' }
          ],
          [
            { text: '❌ Block User', callback_data: 'block_user' },
            { text: '✅ Unblock User', callback_data: 'unblock_user' }
          ]
        ]
      }
    };
    
    await bot.sendMessage(chatId, fullText, { 
      parse_mode: 'Markdown',
      ...keyboard
    });
  }
};

// Keyboard command handlers
const keyboardCommandHandlers = {
  '📝 Send Confession': async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    
    const profile = await getUserProfile(userId);
    if (!profile.isActive) {
      await bot.sendMessage(chatId, '❌ Your account has been blocked by admin.');
      return;
    }
    
    const canSubmit = await checkCooldown(userId, 'confession', 60000);
    if (!canSubmit) {
      const cooldownRef = await db.collection('user_cooldowns').doc(userId.toString()).get();
      if (cooldownRef.exists) {
        const data = cooldownRef.data();
        const lastSubmit = data.confession || 0;
        const waitTime = Math.ceil((60000 - (Date.now() - lastSubmit)) / 1000);
        await bot.sendMessage(chatId, `Please wait ${waitTime} seconds before submitting another confession.`);
        return;
      }
    }

    await bot.sendMessage(chatId, 
      `✍️ *Send Your Confession*\n\nType your confession below (max 1000 characters):\n\nYou can add hashtags like #love #study #funny`,
      { parse_mode: 'Markdown' }
    );
  },

  '👤 My Profile': async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const profile = await getUserProfile(userId);
    
    const profileText = `👤 *Your Profile*\n\n`;
    const username = profile.username ? `**Username:** @${profile.username}\n` : `**Username:** Not set\n`;
    const bio = profile.bio ? `**Bio:** ${profile.bio}\n` : `**Bio:** Not set\n`;
    const followers = `**Followers:** ${profile.followers.length}\n`;
    const following = `**Following:** ${profile.following.length}\n`;
    const confessions = `**Total Confessions:** ${profile.totalConfessions}\n`;
    const reputation = `**Reputation:** ${profile.reputation}\n`;
    const achievements = `**Achievements:** ${profile.achievementCount}\n`;
    const streak = `**Daily Streak:** ${profile.dailyStreak} days\n`;
    const joinDate = `**Member Since:** ${new Date(profile.joinDate).toLocaleDateString()}\n`;
    
    const fullText = profileText + username + bio + followers + following + confessions + reputation + achievements + streak + joinDate;
    
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📝 Set Username', callback_ 'set_username' },
            { text: '📝 Set Bio', callback_data: 'set_bio' }
          ],
          [
            { text: '👥 Followers', callback_ 'show_followers' },
            { text: '👥 Following', callback_ 'show_following' }
          ],
          [
            { text: '🏆 View Achievements', callback_ 'view_achievements' },
            { text: '🔍 Browse Users', callback_data: 'browse_users' }
          ],
          [
            { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
          ]
        ]
      }
    };
    
    await bot.sendMessage(chatId, fullText, { 
      parse_mode: 'Markdown',
      ...keyboard
    });
  },

  '🔥 Trending': async (msg) => {
    const chatId = msg.chat.id;
    const trending = await getTrendingConfessions(5);
    
    if (trending.length === 0) {
      await bot.sendMessage(chatId, 'No trending confessions yet. Be the first to submit one!');
      return;
    }
    
    let trendingText = `🔥 *Trending Confessions*\n\n`;
    
    trending.forEach((confession, index) => {
      trendingText += `${index + 1}. #${confession.confessionNumber}\n`;
      trendingText += `   ${confession.text.substring(0, 100)}${confession.text.length > 100 ? '...' : ''}\n`;
      trendingText += `   Comments: ${confession.totalComments || 0}\n\n`;
    });
    
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📝 Send Confession', callback_ 'send_confession' },
            { text: '🔍 Browse Users', callback_data: 'browse_users' }
          ],
          [
            { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
          ]
        ]
      }
    };
    
    await bot.sendMessage(chatId, trendingText, { 
      parse_mode: 'Markdown',
      ...keyboard
    });
  },

  '🎯 Daily Check-in': async (msg) => {
    await commandHandlers['/checkin'](msg);
  },

  '🏷️ Hashtags': async (msg) => {
    const chatId = msg.chat.id;
    const confessionsSnapshot = await db.collection('confessions')
      .where('status', '==', 'approved')
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    
    const hashtagCount = {};
    
    confessionsSnapshot.forEach(doc => {
      const data = doc.data();
      const hashtags = extractHashtags(data.text);
      hashtags.forEach(tag => {
        hashtagCount[tag] = (hashtagCount[tag] || 0) + 1;
      });
    });
    
    const sortedHashtags = Object.entries(hashtagCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    
    if (sortedHashtags.length === 0) {
      await bot.sendMessage(chatId, 'No hashtags found yet. Use #hashtags in your confessions!');
      return;
    }
    
    let hashtagsText = `🏷️ *Popular Hashtags*\n\n`;
    
    sortedHashtags.forEach(([tag, count], index) => {
      hashtagsText += `${index + 1}. ${tag} (${count} uses)\n`;
    });
    
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📝 Send Confession', callback_ 'send_confession' },
            { text: '🔍 Browse Users', callback_ 'browse_users' }
          ],
          [
            { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
          ]
        ]
      }
    };
    
    await bot.sendMessage(chatId, hashtagsText, { 
      parse_mode: 'Markdown',
      ...keyboard
    });
  },

  '🏆 Achievements': async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const profile = await getUserProfile(userId);
    
    const achievements = profile.achievements || [];
    
    if (achievements.length === 0) {
      await bot.sendMessage(chatId, 'No achievements yet. Start using the bot to unlock achievements!');
      return;
    }
    
    let achievementsText = `🏆 *Your Achievements*\n\n`;
    
    const achievementNames = {
      'first_confession': 'First Confession',
      'ten_confessions': 'Confession Master',
      'fifty_followers': 'Popular User',
      'week_streak': 'Week Streak'
    };
    
    achievements.forEach(achievement => {
      achievementsText += `• ${achievementNames[achievement] || achievement}\n`;
    });
    
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🎯 Daily Check-in', callback_ 'daily_checkin' },
            { text: '📝 Send Confession', callback_ 'send_confession' }
          ],
          [
            { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
          ]
        ]
      }
    };
    
    await bot.sendMessage(chatId, achievementsText, { 
      parse_mode: 'Markdown',
      ...keyboard
    });
  },

  '⚙️ Settings': async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const profile = await getUserProfile(userId);
    
    const text = `⚙️ *Settings*\n\nConfigure your bot preferences:\n\n`;
    const notifications = `**Notifications:** ${profile.notifications.confessionApproved ? '✅' : '❌'} Confession Approved\n`;
    const comments = `**Comments:** ${profile.notifications.newComment ? '✅' : '❌'} New Comments\n`;
    const followers = `**Followers:** ${profile.notifications.newFollower ? '✅' : '❌'} New Followers\n`;
    
    const fullText = text + notifications + comments + followers;
    
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📝 Set Username', callback_data: 'set_username' },
            { text: '📝 Set Bio', callback_data: 'set_bio' }
          ],
          [
            { text: '🔍 Browse Users', callback_data: 'browse_users' },
            { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
          ]
        ]
      }
    };
    
    await bot.sendMessage(chatId, fullText, { 
      parse_mode: 'Markdown',
      ...keyboard
    });
  },

  'ℹ️ About Us': async (msg) => {
    const chatId = msg.chat.id;
    const text = `ℹ️ *About Us*\n\nThis is an anonymous confession platform for JU students.\n\nFeatures:\n• Anonymous confessions\n• Admin approval system\n• User profiles\n• Social features\n• Comment system\n• Reputation system\n• Achievements\n• Daily check-ins\n\n100% private and secure.`;
    
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📝 Send Confession', callback_data: 'send_confession' },
            { text: '🎯 Daily Check-in', callback_ 'daily_checkin' }
          ],
          [
            { text: '🔍 Browse Users', callback_ 'browse_users' },
            { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
          ]
        ]
      }
    };
    
    await bot.sendMessage(chatId, text, { 
      parse_mode: 'Markdown',
      ...keyboard
    });
  },

  '🔍 Browse Users': async (msg) => {
    const chatId = msg.chat.id;
    const usersSnapshot = await db.collection('users')
      .where('username', '!=', null)
      .where('isActive', '==', true)
      .orderBy('reputation', 'desc')
      .limit(10)
      .get();
    
    if (usersSnapshot.empty) {
      await bot.sendMessage(chatId, `🔍 *Browse Users*\n\nNo users found.`);
      return;
    }
    
    let usersText = `🔍 *Browse Users*\n\n`;
    const keyboard = [];
    
    for (const doc of usersSnapshot.docs) {
      const userData = doc.data();
      if (userData.userId === msg.from.id) continue;
      
      const name = userData.username;
      const bio = userData.bio || 'No bio';
      const followers = userData.followers.length;
      const reputation = userData.reputation;
      
      usersText += `• @${name} (${reputation}⭐, ${followers} followers)\n`;
      usersText += `  ${bio}\n\n`;
      
      keyboard.push([
        { text: `👤 View @${name}`, callback_ `view_profile_${userData.userId}` }
      ]);
    }
    
    keyboard.push([{ text: '🔙 Back to Menu', callback_ 'back_to_menu' }]);
    
    const inlineKeyboard = {
      reply_markup: {
        inline_keyboard: keyboard
      }
    };
    
    await bot.sendMessage(chatId, usersText, { 
      parse_mode: 'Markdown',
      ...inlineKeyboard
    });
  },

  '📌 Rules': async (msg) => {
    const chatId = msg.chat.id;
    const text = `📌 *Confession Rules*\n\n✅ Be respectful\n✅ No personal attacks\n✅ No spam or ads\n✅ Keep it anonymous\n✅ No hate speech\n✅ No illegal content\n✅ No harassment\n✅ Use appropriate hashtags`;
    
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📝 Send Confession', callback_data: 'send_confession' },
            { text: '🎯 Daily Check-in', callback_ 'daily_checkin' }
          ],
          [
            { text: '🔍 Browse Users', callback_data: 'browse_users' },
            { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
          ]
        ]
      }
    };
    
    await bot.sendMessage(chatId, text, { 
      parse_mode: 'Markdown',
      ...keyboard
    });
  }
};

// Get bot statistics
async function getBotStats() {
  const usersSnapshot = await db.collection('users').get();
  const confessionsSnapshot = await db.collection('confessions').get();
  
  let pending = 0, approved = 0, rejected = 0;
  
  confessionsSnapshot.forEach(doc => {
    const data = doc.data();
    switch (data.status) {
      case 'pending': pending++; break;
      case 'approved': approved++; break;
      case 'rejected': rejected++; break;
    }
  });
  
  return {
    totalUsers: usersSnapshot.size,
    pendingConfessions: pending,
    approvedConfessions: approved,
    rejectedConfessions: rejected
  };
}

// Get trending confessions
async function getTrendingConfessions(limit = 5) {
  const confessionsSnapshot = await db.collection('confessions')
    .where('status', '==', 'approved')
    .orderBy('totalComments', 'desc')
    .limit(limit)
    .get();
  
  return confessionsSnapshot.docs.map(doc => doc.data());
}

// Handle callback queries
const callbackQueryHandlers = {
  'manage_users': async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    
    if (!isAdmin(userId)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Access denied' });
      return;
    }
    
    const usersSnapshot = await db.collection('users').limit(10).get();
    
    if (usersSnapshot.empty) {
      await bot.editMessageText(
        `👥 *Manage Users*\n\nNo users found.`,
        { 
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Admin Menu', callback_ 'admin_menu' }]
            ]
          }
        }
      );
      return;
    }
    
    let usersText = `👥 *Manage Users*\n\n`;
    const keyboard = [];
    
    for (const doc of usersSnapshot.docs) {
      const userData = doc.data();
      const username = userData.username || 'No username';
      const joinDate = new Date(userData.joinDate).toLocaleDateString();
      const confessions = userData.totalConfessions || 0;
      const reputation = userData.reputation || 0;
      const status = userData.isActive ? '✅ Active' : '❌ Blocked';
      
      usersText += `• ID: ${userData.userId}\n`;
      usersText += `  Username: @${username}\n`;
      usersText += `  Confessions: ${confessions}\n`;
      usersText += `  Reputation: ${reputation}\n`;
      usersText += `  Status: ${status}\n`;
      usersText += `  Joined: ${joinDate}\n\n`;
      
      keyboard.push([
        { text: `🔍 View @${username}`, callback_ `view_user_${userData.userId}` }
      ]);
    }
    
    keyboard.push([{ text: '🔙 Admin Menu', callback_ 'admin_menu' }]);
    
    await bot.editMessageText(usersText, { 
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: keyboard
      }
    });
  },

  'review_confessions': async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    
    if (!isAdmin(userId)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Access denied' });
      return;
    }
    
    const pendingSnapshot = await db.collection('confessions')
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'asc')
      .limit(10)
      .get();
    
    if (pendingSnapshot.empty) {
      await bot.editMessageText(
        `📝 *Pending Confessions*\n\nNo pending confessions to review.`,
        { 
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Admin Menu', callback_ 'admin_menu' }]
            ]
          }
        }
      );
      return;
    }
    
    let confessionsText = `📝 *Pending Confessions*\n\n`;
    const keyboard = [];
    
    for (const doc of pendingSnapshot.docs) {
      const data = doc.data();
      const user = await getUserProfile(data.userId);
      const username = user.username ? `@${user.username}` : `ID: ${data.userId}`;
      
      confessionsText += `• From: ${username}\n`;
      confessionsText += `  Confession: "${data.text.substring(0, 50)}${data.text.length > 50 ? '...' : ''}"\n\n`;
      
      keyboard.push([
        { text: `✅ Approve #${doc.id}`, callback_data: `approve_${doc.id}` },
        { text: `❌ Reject #${doc.id}`, callback_data: `reject_${doc.id}` }
      ]);
    }
    
    keyboard.push([{ text: '🔙 Admin Menu', callback_data: 'admin_menu' }]);
    
    await bot.editMessageText(confessionsText, { 
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: keyboard
      }
    });
  },

  'approve_': async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    const confessionId = callbackQuery.data.replace('approve_', '');
    
    if (!isAdmin(userId)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Access denied' });
      return;
    }
    
    try {
      const doc = await db.collection('confessions').doc(confessionId).get();
      if (!doc.exists) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Confession not found' });
        return;
      }

      const confession = doc.data();
      const nextNumber = await getNextConfessionNumber();
      
      await db.collection('confessions').doc(confessionId).update({
        status: 'approved',
        confessionNumber: nextNumber,
        approvedAt: new Date().toISOString()
      });

      await postToChannel(confession.text, nextNumber, confessionId);
      await updateReputation(confession.userId, 10);
      await notifyUser(confession.userId, nextNumber, 'approved');

      await bot.editMessageText(
        `✅ *Confession #${nextNumber} Approved!*\n\nPosted to channel successfully.`,
        { 
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
          parse_mode: 'Markdown'
        }
      );
      
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Approved!' });
      await checkAchievements(confession.userId);
    } catch (error) {
      console.error('Approval error:', error);
      await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Approval failed' });
    }
  },

  'reject_': async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    const confessionId = callbackQuery.data.replace('reject_', '');
    
    if (!isAdmin(userId)) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Access denied' });
      return;
    }
    
    await bot.editMessageText(
      `❌ *Rejecting Confession*\n\nPlease provide rejection reason:`,
      { 
        chat_id: chatId,
        message_id: callbackQuery.message.message_id,
        parse_mode: 'Markdown'
      }
    );
  }
};

// Handle callback query prefixes
function handleCallbackPrefix(callbackQuery) {
  const data = callbackQuery.data;
  
  if (data.startsWith('approve_')) {
    return callbackQueryHandlers['approve_'](callbackQuery);
  }
  if (data.startsWith('reject_')) {
    return callbackQueryHandlers['reject_'](callbackQuery);
  }
  if (data.startsWith('view_user_')) {
    return handleViewUser(callbackQuery);
  }
  if (data.startsWith('view_profile_')) {
    return handleViewProfile(callbackQuery);
  }
  
  const handler = callbackQueryHandlers[data];
  if (handler) {
    return handler(callbackQuery);
  }
  
  // Default handler for unknown callbacks
  return bot.answerCallbackQuery(callbackQuery.id, { text: 'Unknown action' });
}

// Handle view user
async function handleViewUser(callbackQuery) {
  const userId = parseInt(callbackQuery.data.replace('view_user_', ''));
  const chatId = callbackQuery.message.chat.id;
  
  if (!isAdmin(callbackQuery.from.id)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Access denied' });
    return;
  }
  
  const profile = await getUserProfile(userId);
  
  const text = `👤 *User Details*\n\n`;
  const id = `**User ID:** ${profile.userId}\n`;
  const username = profile.username ? `**Username:** @${profile.username}\n` : '';
  const bio = profile.bio ? `**Bio:** ${profile.bio}\n` : '';
  const followers = `**Followers:** ${profile.followers.length}\n`;
  const following = `**Following:** ${profile.following.length}\n`;
  const confessions = `**Confessions:** ${profile.totalConfessions}\n`;
  const reputation = `**Reputation:** ${profile.reputation}\n`;
  const achievements = `**Achievements:** ${profile.achievementCount}\n`;
  const streak = `**Daily Streak:** ${profile.dailyStreak} days\n`;
  const status = `**Status:** ${profile.isActive ? '✅ Active' : '❌ Blocked'}\n`;
  const joinDate = `**Join Date:** ${new Date(profile.joinDate).toLocaleDateString()}\n`;
  
  const fullText = text + id + username + bio + followers + following + confessions + reputation + achievements + streak + status + joinDate;
  
  const keyboard = {
    inline_keyboard: [
      [
        { text: '✉️ Message User', callback_ `message_${userId}` },
        { text: profile.isActive ? '❌ Block User' : '✅ Unblock User', callback_ `toggle_block_${userId}` }
      ],
      [
        { text: '👥 View Confessions', callback_data: `view_user_confessions_${userId}` },
        { text: '🔙 Back to Users', callback_ 'manage_users' }
      ]
    ]
  };
  
  await bot.editMessageText(fullText, { 
    chat_id: chatId,
    message_id: callbackQuery.message.message_id,
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
}

// Handle view profile
async function handleViewProfile(callbackQuery) {
  const targetUserId = parseInt(callbackQuery.data.replace('view_profile_', ''));
  const chatId = callbackQuery.message.chat.id;
  const currentUserProfile = await getUserProfile(callbackQuery.from.id);
  
  const targetProfile = await getUserProfile(targetUserId);
  
  const profileText = `👤 *Profile*\n\n`;
  const username = targetProfile.username ? `**Username:** @${targetProfile.username}\n` : '';
  const bio = targetProfile.bio ? `**Bio:** ${targetProfile.bio}\n` : `**Bio:** No bio\n`;
  const followers = `**Followers:** ${targetProfile.followers.length}\n`;
  const following = `**Following:** ${targetProfile.following.length}\n`;
  const confessions = `**Confessions:** ${targetProfile.totalConfessions}\n`;
  const reputation = `**Reputation:** ${targetProfile.reputation}⭐\n`;
  const achievements = `**Achievements:** ${targetProfile.achievementCount}\n`;
  const joinDate = `**Member Since:** ${new Date(targetProfile.joinDate).toLocaleDateString()}\n`;
  
  const fullText = profileText + username + bio + followers + following + confessions + reputation + achievements + joinDate;
  
  const isFollowing = currentUserProfile.following.includes(targetUserId);
  
  const keyboard = [
    [isFollowing 
      ? { text: '✅ Following', callback_data: `unfollow_${targetUserId}` }
      : { text: '➕ Follow', callback_ `follow_${targetUserId}` }
    ]
  ];
  
  keyboard.push([{ text: '🔙 Back to Menu', callback_ 'back_to_menu' }]);
  
  await bot.editMessageText(fullText, { 
    chat_id: chatId,
    message_id: callbackQuery.message.message_id,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Handle messages
async function handleMessage(msg) {
  const text = msg.text;
  const userId = msg.from.id;
  
  // Check if it's a command
  if (text && text.startsWith('/')) {
    const command = text.split(' ')[0];
    const handler = commandHandlers[command];
    if (handler) {
      await handler(msg);
      return;
    }
  }
  
  // Check if it's a keyboard command
  if (text && keyboardCommandHandlers[text]) {
    await keyboardCommandHandlers[text](msg);
    return;
  }
  
  // Handle confession submission (if user is waiting for confession)
  // This would require session management, simplified for now
  if (text && text.length > 5 && text.length < 1000) {
    // Check if this looks like a confession (not a command)
    if (!text.startsWith('/')) {
      await handleConfession(msg, text);
      return;
    }
  }
  
  // Default response
  await commandHandlers['/start'](msg);
}

// Handle confession submission
async function handleConfession(msg, text) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (!text || text.trim().length < 5) {
    await bot.sendMessage(chatId, '❌ Confession too short. Minimum 5 characters.');
    return;
  }

  if (text.length > 1000) {
    await bot.sendMessage(chatId, '❌ Confession too long. Maximum 1000 characters.');
    return;
  }

  try {
    const sanitizedText = sanitizeInput(text);
    const confessionId = `confess_${userId}_${Date.now()}`;
    const hashtags = extractHashtags(sanitizedText);
    
    await db.collection('confessions').doc(confessionId).set({
      confessionId: confessionId,
      userId: userId,
      text: sanitizedText.trim(),
      status: 'pending',
      createdAt: new Date().toISOString(),
      hashtags: hashtags,
      totalComments: 0
    });

    await db.collection('users').doc(userId.toString()).update({
      totalConfessions: admin.firestore.FieldValue.increment(1)
    });

    await setCooldown(userId, 'confession');

    await notifyAdmins(confessionId, sanitizedText);
    
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📝 Send Another', callback_data: 'send_confession' },
            { text: '🎯 Daily Check-in', callback_ 'daily_checkin' }
          ],
          [
            { text: '🔙 Back to Menu', callback_ 'back_to_menu' }
          ]
        ]
      }
    };

    await bot.sendMessage(chatId,
      `✅ *Confession Submitted!*\n\nYour confession is under review. You'll be notified when approved.`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    
    await checkAchievements(userId);
    
  } catch (error) {
    console.error('Submission error:', error);
    await bot.sendMessage(chatId, '❌ Error submitting confession. Please try again.');
  }
}

// Notify admins
async function notifyAdmins(confessionId, text) {
  const adminIds = process.env.ADMIN_IDS?.split(',').map(id => id.trim()) || [];
  
  const message = `🤫 *New Confession*\n\n${text}\n\n*Actions:*`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `approve_${confessionId}` },
          { text: '❌ Reject', callback_ `reject_${confessionId}` }
        ]
      ]
    }
  };

  for (const adminId of adminIds) {
    try {
      await bot.sendMessage(parseInt(adminId), message, { 
        parse_mode: 'Markdown', 
        ...keyboard 
      });
    } catch (error) {
      console.error(`Admin notify error ${adminId}:`, error);
    }
  }
}

// Post to channel
async function postToChannel(text, number, confessionId) {
  const channelId = process.env.CHANNEL_ID;
  
  const message = `#${number}\n\n${text}`;

  try {
    const channelMessage = await bot.sendMessage(channelId, message);
    
    // Note: node-telegram-bot-api doesn't have editMessageText for channels
    // We'll send a new message with the comment button instead
    const commentMessage = `${message}\n\n[ 👁️‍🗨️ View/Add Comments (0) ]`;
    
    await bot.sendMessage(channelId, commentMessage, {
      reply_markup: {
        inline_keyboard: [
          [
            { 
              text: '👁️‍🗨️ View/Add Comments', 
              url: `https://t.me/${process.env.BOT_USERNAME}?start=comments_${confessionId}`
            }
          ]
        ]
      }
    });
    
    await createCommentSection(confessionId, number, text);
    
  } catch (error) {
    console.error('Channel post error:', error);
  }
}

// Create comment section
async function createCommentSection(confessionId, number, confessionText) {
  await db.collection('comments').doc(confessionId).set({
    confessionId: confessionId,
    confessionNumber: number,
    confessionText: confessionText,
    comments: [],
    totalComments: 0
  });
}

// Notify user
async function notifyUser(userId, number, status, reason = '') {
  try {
    let message = '';
    if (status === 'approved') {
      message = `🎉 *Your Confession #${number} was approved!*\n\nIt has been posted to the channel.\n\n⭐ +10 reputation points`;
    } else {
      message = `❌ *Confession Not Approved*\n\nReason: ${reason}\n\nYou can submit a new one.`;
    }

    await bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('User notify error:', error);
  }
}

// Vercel handler
module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method === 'GET') {
    return res.json({ 
      status: 'Confession Bot is running!',
      version: '1.0.0'
    });
  }
  
  if (req.method === 'POST') {
    try {
      const update = req.body;
      
      if (update.message) {
        await handleMessage(update.message);
      } else if (update.callback_query) {
        await handleCallbackPrefix(update.callback_query);
      }
      
      return res.json({ ok: true });
    } catch (error) {
      console.error('Webhook processing error:', error);
      return res.status(200).json({ error: error.message, acknowledged: true });
    }
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
};
