// api/bot.js - Community Idea Bot with Numbering & Notifications
require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const admin = require('firebase-admin');

// Firebase setup
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
}

const db = admin.firestore();
const bot = new Telegraf(process.env.BOT_TOKEN);

// Initialize idea counter
let ideaCounter = 0;
async function initializeIdeaCounter() {
  try {
    const ideasSnapshot = await db.collection('ideas')
      .where('status', '==', 'approved')
      .orderBy('ideaNumber', 'desc')
      .limit(1)
      .get();
    
    if (!ideasSnapshot.empty) {
      const latestIdea = ideasSnapshot.docs[0].data();
      ideaCounter = latestIdea.ideaNumber || 0;
      console.log(`Initialized idea counter: ${ideaCounter}`);
    }
  } catch (error) {
    console.error('Error initializing idea counter:', error);
  }
}

// Middleware
bot.use(session());
bot.use(async (ctx, next) => {
  ctx.session = ctx.session || {};
  await next();
});

// ==================== IDEA SUBMISSION ====================
bot.command('submit', async (ctx) => {
  await ctx.reply(
    '💡 *Share Your Idea!*\n\nPlease write your idea below. It will be reviewed by admin before posting.',
    { parse_mode: 'Markdown' }
  );
  ctx.session.waitingForIdea = true;
});

bot.command('start', async (ctx) => {
  await ctx.replyWithMarkdown(
    `🌟 *Community Ideas Bot*\n\n` +
    `Share your ideas with the community! Here's what you can do:\n\n` +
    `💡 /submit - Share a new idea\n` +
    `📋 /ideas - View recent ideas\n` +
    `🆘 /help - Get help\n\n` +
    `Ideas are reviewed by admin before appearing in the community channel.`
  );
});

bot.command('help', async (ctx) => {
  await ctx.replyWithMarkdown(
    `🆘 *Community Ideas Bot Help*\n\n` +
    `*Commands:*\n` +
    `💡 /submit - Submit a new idea for review\n` +
    `📋 /ideas - Browse recent approved ideas\n` +
    `🆘 /help - Show this help message\n\n` +
    `*How it works:*\n` +
    `1. Submit your idea using /submit\n` +
    `2. Admin reviews and approves\n` +
    `3. Idea gets posted to community channel with number (#1, #2, etc.)\n` +
    `4. Community members can comment on ideas\n` +
    `5. Get notified when someone comments on your idea\n\n` +
    `💬 Comments are anonymous to other members.`
  );
});

// Handle idea text submission
bot.on('text', async (ctx) => {
  if (ctx.session.waitingForIdea) {
    await handleIdeaSubmission(ctx, ctx.message.text);
    return;
  }
  
  if (ctx.session.waitingForComment) {
    await handleCommentSubmission(ctx, ctx.message.text);
    return;
  }
  
  if (ctx.session.rejectingIdea) {
    await handleIdeaRejection(ctx, ctx.message.text);
    return;
  }
  
  if (ctx.session.messagingUser) {
    await handleAdminMessage(ctx, ctx.message.text);
    return;
  }
});

async function handleIdeaSubmission(ctx, ideaText) {
  const userId = ctx.from.id;
  const username = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
  
  try {
    const ideaId = `idea_${userId}_${Date.now()}`;
    
    // Save to Firebase
    await db.collection('ideas').doc(ideaId).set({
      ideaId: ideaId,
      userId: userId,
      username: username,
      text: ideaText,
      status: 'pending',
      commentCount: 0,
      createdAt: new Date().toISOString(),
      submittedAt: new Date().toISOString()
    });

    // Notify admin
    await notifyAdminNewIdea(ideaId, ideaText, username, userId);
    
    ctx.session.waitingForIdea = false;
    
    await ctx.replyWithMarkdown(
      `✅ *Idea Submitted!*\n\n` +
      `Your idea has been received and sent for admin approval.\n\n` +
      `You'll get notified when it's approved and posted to the community channel.\n` +
      `You'll also receive notifications when people comment on your idea!`
    );
    
  } catch (error) {
    console.error('Error submitting idea:', error);
    await ctx.reply('❌ Error submitting idea. Please try again.');
  }
}

// ==================== ADMIN APPROVAL SYSTEM ====================
async function notifyAdminNewIdea(ideaId, ideaText, username, userId) {
  const adminIds = process.env.ADMIN_IDS?.split(',') || [];
  
  const message = `💡 *NEW IDEA SUBMISSION*\n\n` +
    `👤 From: ${username}\n` +
    `🆔 User ID: ${userId}\n\n` +
    `*Idea Text:*\n${ideaText}\n\n` +
    `*Admin Actions:*`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Approve', `approve_idea_${ideaId}`),
      Markup.button.callback('❌ Reject', `reject_idea_${ideaId}`)
    ],
    [
      Markup.button.callback('📩 Message User', `message_user_${userId}`)
    ]
  ]);

  for (const adminId of adminIds) {
    try {
      await bot.telegram.sendMessage(adminId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
      });
    } catch (error) {
      console.error(`Failed to notify admin ${adminId}:`, error);
    }
  }
}

// Admin approval handlers
bot.action(/approve_idea_(.+)/, async (ctx) => {
  const ideaId = ctx.match[1];
  await approveIdea(ctx, ideaId);
});

bot.action(/reject_idea_(.+)/, async (ctx) => {
  const ideaId = ctx.match[1];
  await rejectIdea(ctx, ideaId);
});

async function approveIdea(ctx, ideaId) {
  try {
    const ideaDoc = await db.collection('ideas').doc(ideaId).get();
    if (!ideaDoc.exists) {
      await ctx.answerCbQuery('❌ Idea not found.');
      return;
    }

    const idea = ideaDoc.data();
    
    // Increment idea counter
    ideaCounter += 1;
    
    // Update status to approved with idea number
    await db.collection('ideas').doc(ideaId).update({
      status: 'approved',
      ideaNumber: ideaCounter,
      approvedAt: new Date().toISOString(),
      approvedBy: ctx.from.username
    });

    // Post to channel with idea number
    const channelMessage = await postIdeaToChannel(idea, ideaCounter);
    
    // Store channel message ID
    await db.collection('ideas').doc(ideaId).update({
      channelMessageId: channelMessage.message_id
    });

    // Notify user
    await bot.telegram.sendMessage(
      idea.userId,
      `🎉 *Your Idea Was Approved!*\n\n` +
      `Your idea has been approved and posted to the community channel!\n\n` +
      `🔢 *Idea #${ideaCounter}*\n` +
      `💡 *Your Idea:*\n${idea.text}\n\n` +
      `Community members can now comment on your idea.\n` +
      `You'll get notified when someone comments!`
    );

    await ctx.editMessageText(`✅ Idea #${ideaCounter} approved and posted to channel!`);
    await ctx.answerCbQuery('Idea approved!');

  } catch (error) {
    console.error('Error approving idea:', error);
    await ctx.answerCbQuery('❌ Error approving idea.');
  }
}

async function rejectIdea(ctx, ideaId) {
  await ctx.editMessageText(
    `❌ Rejecting idea\n\nPlease send the rejection reason:`
  );
  ctx.session.rejectingIdea = ideaId;
}

async function handleIdeaRejection(ctx, reason) {
  const ideaId = ctx.session.rejectingIdea;
  
  const ideaDoc = await db.collection('ideas').doc(ideaId).get();
  if (ideaDoc.exists) {
    const idea = ideaDoc.data();
    
    await db.collection('ideas').doc(ideaId).update({
      status: 'rejected',
      rejectionReason: reason,
      rejectedBy: ctx.from.username,
      rejectedAt: new Date().toISOString()
    });

    // Notify user
    await bot.telegram.sendMessage(
      idea.userId,
      `❌ *Idea Not Approved*\n\n` +
      `Your idea was not approved for the community channel.\n\n` +
      `📝 *Reason:* ${reason}\n\n` +
      `You can submit a new idea using /submit`
    );

    await ctx.reply(`✅ Idea rejected with reason.`);
  }
  
  ctx.session.rejectingIdea = null;
}

// ==================== CHANNEL POSTING ====================
async function postIdeaToChannel(idea, ideaNumber) {
  const channelId = process.env.CHANNEL_ID;
  
  const message = `💡 *Idea #${ideaNumber}*\n\n` +
    `${idea.text}\n\n` +
    `─────────────────────`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`💬 Comments (0)`, `comment_idea_${idea.ideaId}`)
    ]
  ]);

  return await bot.telegram.sendMessage(channelId, message, {
    parse_mode: 'Markdown',
    reply_markup: keyboard.reply_markup
  });
}

// ==================== COMMENT SYSTEM ====================
bot.action(/comment_idea_(.+)/, async (ctx) => {
  const ideaId = ctx.match[1];
  await handleCommentButtonClick(ctx, ideaId);
});

async function handleCommentButtonClick(ctx, ideaId) {
  const ideaDoc = await db.collection('ideas').doc(ideaId).get();
  if (!ideaDoc.exists) {
    await ctx.answerCbQuery('❌ Idea not found.');
    return;
  }

  const idea = ideaDoc.data();
  
  // Store in session
  ctx.session.waitingForComment = true;
  ctx.session.commentIdeaId = ideaId;

  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
    `💬 *Comment on Idea #${idea.ideaNumber}*\n\n` +
    `*Idea:* ${idea.text}\n\n` +
    `Your comment will be anonymous to other community members.\n` +
    `Only admins can see your username.\n\n` +
    `Please write your comment below:`
  );
}

async function handleCommentSubmission(ctx, commentText) {
  const userId = ctx.from.id;
  const username = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
  const ideaId = ctx.session.commentIdeaId;

  if (!ideaId) {
    await ctx.reply('❌ No idea selected for comment.');
    return;
  }

  try {
    const commentId = `comment_${userId}_${Date.now()}`;
    
    // Save comment to Firebase
    await db.collection('comments').doc(commentId).set({
      commentId: commentId,
      ideaId: ideaId,
      userId: userId,
      username: username,
      text: commentText,
      createdAt: new Date().toISOString(),
      isAnonymous: true
    });

    // Get idea data for notification
    const ideaDoc = await db.collection('ideas').doc(ideaId).get();
    const idea = ideaDoc.data();
    const newCount = (idea.commentCount || 0) + 1;

    // Update comment count
    await db.collection('ideas').doc(ideaId).update({
      commentCount: newCount
    });

    // Update channel button
    await updateChannelCommentCount(ideaId, newCount);

    // Notify idea owner (if it's not the owner commenting)
    if (idea.userId !== userId) {
      await notifyIdeaOwnerNewComment(idea, commentText, newCount);
    }

    // Clear session
    ctx.session.waitingForComment = false;
    ctx.session.commentIdeaId = null;

    await ctx.replyWithMarkdown(
      `✅ *Comment Added!*\n\n` +
      `Your comment has been added to Idea #${idea.ideaNumber}.\n\n` +
      `💬 Total comments: ${newCount}`
    );

  } catch (error) {
    console.error('Error submitting comment:', error);
    await ctx.reply('❌ Error submitting comment. Please try again.');
  }
}

// Notify idea owner about new comment
async function notifyIdeaOwnerNewComment(idea, commentText, totalComments) {
  try {
    await bot.telegram.sendMessage(
      idea.userId,
      `💬 *New Comment on Your Idea!*\n\n` +
      `Someone commented on your Idea #${idea.ideaNumber}:\n\n` +
      `💡 *Your Idea:*\n${idea.text}\n\n` +
      `💬 *New Comment:*\n"${commentText}"\n\n` +
      `📊 Total comments: ${totalComments}`
    );
  } catch (error) {
    console.error('Error notifying idea owner:', error);
  }
}

async function updateChannelCommentCount(ideaId, newCount) {
  try {
    const ideaDoc = await db.collection('ideas').doc(ideaId).get();
    const idea = ideaDoc.data();

    if (!idea.channelMessageId) return;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(`💬 Comments (${newCount})`, `comment_idea_${ideaId}`)
      ]
    ]);

    await bot.telegram.editMessageReplyMarkup(
      process.env.CHANNEL_ID,
      idea.channelMessageId,
      null,
      keyboard.reply_markup
    );

  } catch (error) {
    console.error('Error updating comment count:', error);
  }
}

// ==================== VIEW IDEAS COMMAND ====================
bot.command('ideas', async (ctx) => {
  try {
    const ideasSnapshot = await db.collection('ideas')
      .where('status', '==', 'approved')
      .orderBy('ideaNumber', 'desc')
      .limit(10)
      .get();

    if (ideasSnapshot.empty) {
      await ctx.reply('📝 No ideas have been posted yet. Be the first to submit one using /submit');
      return;
    }

    let ideasText = `📋 *Recent Community Ideas*\n\n`;
    
    ideasSnapshot.forEach((doc, index) => {
      const idea = doc.data();
      ideasText += `*${idea.ideaNumber}. 💡 Idea*\n`;
      ideasText += `${idea.text}\n`;
      ideasText += `💬 ${idea.commentCount || 0} comments\n`;
      ideasText += `📅 ${new Date(idea.approvedAt).toLocaleDateString()}\n\n`;
    });

    ideasText += `💡 Submit your own idea using /submit`;

    await ctx.replyWithMarkdown(ideasText);

  } catch (error) {
    console.error('Error fetching ideas:', error);
    await ctx.reply('❌ Error loading ideas. Please try again.');
  }
});

// ==================== ADMIN MESSAGE HANDLER ====================
bot.action(/message_user_(.+)/, async (ctx) => {
  const userId = ctx.match[1];
  await ctx.editMessageText(
    `📩 Messaging user ${userId}\n\nPlease type your message:`
  );
  ctx.session.messagingUser = userId;
});

async function handleAdminMessage(ctx, message) {
  const userId = ctx.session.messagingUser;

  try {
    await bot.telegram.sendMessage(
      userId,
      `📩 *Message from Admin*\n\n${message}`
    );
    await ctx.reply(`✅ Message sent to user.`);
  } catch (error) {
    await ctx.reply(`❌ Failed to send message. User may have blocked the bot.`);
  }
  
  ctx.session.messagingUser = null;
}

// ==================== ERROR HANDLER ====================
bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err);
  ctx.reply('❌ An error occurred. Please try again.');
});

// ==================== VERCEL HANDLER ====================
module.exports = async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(200).send('OK');
  }
};

// ==================== LOCAL DEVELOPMENT ====================
if (process.env.NODE_ENV === 'development') {
  // Initialize counter when bot starts
  initializeIdeaCounter().then(() => {
    bot.launch().then(() => {
      console.log('🚀 Community Ideas Bot started in development mode');
    });
  });
  
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
