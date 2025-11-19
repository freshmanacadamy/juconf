// api/bot.js - Complete Community Bot with Comments & Private Chat
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

// ==================== HOME PAGE ====================
function getHomeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💡 Submit Idea', 'submit_idea')],
    [Markup.button.callback('📋 Browse Ideas', 'browse_ideas')],
    [Markup.button.callback('🆘 Help', 'show_help')]
  ]);
}

bot.command('start', async (ctx) => {
  await showHomePage(ctx);
});

bot.action('home', async (ctx) => {
  await showHomePage(ctx);
});

async function showHomePage(ctx) {
  const welcomeText = `🏠 *Community Ideas Hub*\n\n` +
    `💡 Share your ideas with the community\n` +
    `💬 Discuss ideas with others\n` +
    `💌 Message idea writers privately\n\n` +
    `*Choose an option below:*`;

  if (ctx.updateType === 'callback_query') {
    await ctx.editMessageText(welcomeText, {
      parse_mode: 'Markdown',
      reply_markup: getHomeKeyboard().reply_markup
    });
  } else {
    await ctx.replyWithMarkdown(welcomeText, getHomeKeyboard());
  }
}

// ==================== IDEA SUBMISSION ====================
bot.action('submit_idea', async (ctx) => {
  await ctx.editMessageText(
    '💡 *Submit New Idea*\n\nPlease write your idea below. It will be reviewed by admin before posting.',
    { parse_mode: 'Markdown' }
  );
  ctx.session.waitingForIdea = true;
  await ctx.answerCbQuery();
});

bot.command('submit', async (ctx) => {
  await ctx.replyWithMarkdown(
    '💡 *Submit New Idea*\n\nPlease write your idea below. It will be reviewed by admin before posting.'
  );
  ctx.session.waitingForIdea = true;
});

// ==================== BROWSE IDEAS ====================
bot.action('browse_ideas', async (ctx) => {
  await showIdeasList(ctx);
});

bot.command('ideas', async (ctx) => {
  await showIdeasList(ctx);
});

async function showIdeasList(ctx) {
  try {
    const ideasSnapshot = await db.collection('ideas')
      .where('status', '==', 'approved')
      .orderBy('ideaNumber', 'desc')
      .limit(10)
      .get();

    if (ideasSnapshot.empty) {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('💡 Submit First Idea', 'submit_idea')],
        [Markup.button.callback('🏠 Home', 'home')]
      ]);
      
      await ctx.editMessageText(
        '📝 No ideas yet. Be the first to submit one!',
        { reply_markup: keyboard.reply_markup }
      );
      return;
    }

    let ideasText = `📋 *Community Ideas*\n\n*Select an idea to view:*\n\n`;
    
    ideasSnapshot.forEach((doc) => {
      const idea = doc.data();
      ideasText += `#${idea.ideaNumber} - 💬 ${idea.commentCount || 0} comments\n`;
    });

    const keyboardButtons = ideasSnapshot.docs.map(doc => {
      const idea = doc.data();
      return [Markup.button.callback(`#${idea.ideaNumber} - 💬 ${idea.commentCount || 0}`, `view_idea_${idea.ideaId}`)];
    });

    keyboardButtons.push([Markup.button.callback('🏠 Home', 'home')]);

    await ctx.editMessageText(ideasText, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard(keyboardButtons).reply_markup
    });

  } catch (error) {
    console.error('Error fetching ideas:', error);
    await ctx.editMessageText('❌ Error loading ideas. Please try again.');
  }
}

// ==================== VIEW IDEA DETAILS ====================
bot.action(/view_idea_(.+)/, async (ctx) => {
  const ideaId = ctx.match[1];
  await showIdeaDetails(ctx, ideaId);
});

async function showIdeaDetails(ctx, ideaId) {
  try {
    const ideaDoc = await db.collection('ideas').doc(ideaId).get();
    if (!ideaDoc.exists) {
      await ctx.answerCbQuery('❌ Idea not found.');
      return;
    }

    const idea = ideaDoc.data();
    
    // Get comments for this idea
    const commentsSnapshot = await db.collection('comments')
      .where('ideaId', '==', ideaId)
      .orderBy('createdAt', 'asc')
      .get();

    let ideaText = `💡 *Idea #${idea.ideaNumber}*\n\n`;
    ideaText += `${idea.text}\n\n`;
    ideaText += `─────────────────────\n`;
    ideaText += `💬 *Comments (${commentsSnapshot.size})*\n\n`;

    if (commentsSnapshot.empty) {
      ideaText += `No comments yet. Be the first to comment!`;
    } else {
      commentsSnapshot.forEach((doc, index) => {
        const comment = doc.data();
        ideaText += `${index + 1}. ${comment.text}\n\n`;
      });
    }

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('💬 Add Comment', `add_comment_${ideaId}`),
        Markup.button.callback('💌 Message Writer', `message_writer_${ideaId}`)
      ],
      [
        Markup.button.callback('📋 Browse Ideas', 'browse_ideas'),
        Markup.button.callback('🏠 Home', 'home')
      ]
    ]);

    await ctx.editMessageText(ideaText, {
      parse_mode: 'Markdown',
      reply_markup: keyboard.reply_markup
    });

  } catch (error) {
    console.error('Error showing idea details:', error);
    await ctx.answerCbQuery('❌ Error loading idea.');
  }
}

// ==================== PUBLIC COMMENT SYSTEM ====================
bot.action(/add_comment_(.+)/, async (ctx) => {
  const ideaId = ctx.match[1];
  await startAddComment(ctx, ideaId);
});

async function startAddComment(ctx, ideaId) {
  const ideaDoc = await db.collection('ideas').doc(ideaId).get();
  const idea = ideaDoc.data();

  await ctx.editMessageText(
    `💬 *Add Comment to Idea #${idea.ideaNumber}*\n\n` +
    `*Idea:* ${idea.text}\n\n` +
    `Your comment will be visible to everyone.\n` +
    `Please write your comment below:`,
    { parse_mode: 'Markdown' }
  );
  
  ctx.session.waitingForComment = true;
  ctx.session.commentIdeaId = ideaId;
  await ctx.answerCbQuery();
}

// ==================== PRIVATE CHAT SYSTEM ====================
bot.action(/message_writer_(.+)/, async (ctx) => {
  const ideaId = ctx.match[1];
  await startPrivateMessage(ctx, ideaId);
});

async function startPrivateMessage(ctx, ideaId) {
  const ideaDoc = await db.collection('ideas').doc(ideaId).get();
  const idea = ideaDoc.data();

  await ctx.editMessageText(
    `💌 *Private Message to Idea Writer*\n\n` +
    `*Idea #${idea.ideaNumber}:* ${idea.text}\n\n` +
    `Your message will be sent privately to the idea writer.\n` +
    `Only they will see your message.\n\n` +
    `Please write your private message below:`,
    { parse_mode: 'Markdown' }
  );
  
  ctx.session.waitingForPrivateMessage = true;
  ctx.session.privateMessageIdeaId = ideaId;
  await ctx.answerCbQuery();
}

// ==================== TEXT MESSAGE HANDLER ====================
bot.on('text', async (ctx) => {
  if (ctx.session.waitingForIdea) {
    await handleIdeaSubmission(ctx, ctx.message.text);
    return;
  }
  
  if (ctx.session.waitingForComment) {
    await handleCommentSubmission(ctx, ctx.message.text);
    return;
  }
  
  if (ctx.session.waitingForPrivateMessage) {
    await handlePrivateMessage(ctx, ctx.message.text);
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

// Handle idea submission
async function handleIdeaSubmission(ctx, ideaText) {
  const userId = ctx.from.id;
  const username = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
  
  try {
    const ideaId = `idea_${userId}_${Date.now()}`;
    
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

    await notifyAdminNewIdea(ideaId, ideaText, username, userId);
    
    ctx.session.waitingForIdea = false;
    
    await ctx.replyWithMarkdown(
      `✅ *Idea Submitted!*\n\n` +
      `Your idea has been sent for admin approval.\n` +
      `You'll be notified when it's approved.`,
      getHomeKeyboard()
    );
    
  } catch (error) {
    console.error('Error submitting idea:', error);
    await ctx.reply('❌ Error submitting idea. Please try again.', getHomeKeyboard());
  }
}

// Handle public comment submission
async function handleCommentSubmission(ctx, commentText) {
  const userId = ctx.from.id;
  const username = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
  const ideaId = ctx.session.commentIdeaId;

  try {
    const commentId = `comment_${userId}_${Date.now()}`;
    
    // Save public comment
    await db.collection('comments').doc(commentId).set({
      commentId: commentId,
      ideaId: ideaId,
      userId: userId,
      username: username,
      text: commentText,
      createdAt: new Date().toISOString(),
      isPublic: true
    });

    // Update comment count
    const ideaDoc = await db.collection('ideas').doc(ideaId).get();
    const idea = ideaDoc.data();
    const newCount = (idea.commentCount || 0) + 1;

    await db.collection('ideas').doc(ideaId).update({
      commentCount: newCount
    });

    // Update channel button
    await updateChannelCommentCount(ideaId, newCount);

    // Notify admins about new comment
    await notifyAdminNewComment(idea, username, commentText);

    ctx.session.waitingForComment = false;
    ctx.session.commentIdeaId = null;

    await ctx.replyWithMarkdown(
      `✅ *Comment Added!*\n\n` +
      `Your comment is now visible to everyone.`,
      getHomeKeyboard()
    );

  } catch (error) {
    console.error('Error submitting comment:', error);
    await ctx.reply('❌ Error submitting comment. Please try again.', getHomeKeyboard());
  }
}

// Handle private message submission
async function handlePrivateMessage(ctx, messageText) {
  const userId = ctx.from.id;
  const username = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
  const ideaId = ctx.session.privateMessageIdeaId;

  try {
    const ideaDoc = await db.collection('ideas').doc(ideaId).get();
    const idea = ideaDoc.data();

    const privateMessageId = `private_${userId}_${Date.now()}`;
    
    // Save private message
    await db.collection('private_messages').doc(privateMessageId).set({
      messageId: privateMessageId,
      ideaId: ideaId,
      fromUserId: userId,
      fromUsername: username,
      toUserId: idea.userId,
      message: messageText,
      createdAt: new Date().toISOString(),
      isPrivate: true
    });

    // Send to idea writer
    await bot.telegram.sendMessage(
      idea.userId,
      `💌 *New Private Message*\n\n` +
      `Someone sent you a private message about your Idea #${idea.ideaNumber}:\n\n` +
      `💡 *Your Idea:*\n${idea.text}\n\n` +
      `📝 *Message:*\n${messageText}\n\n` +
      `💬 *Reply:* Click the button below to reply anonymously`,
      {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('💌 Reply Anonymously', `reply_private_${privateMessageId}`)],
          [Markup.button.callback('🏠 Home', 'home')]
        ]).reply_markup
      }
    );

    // Notify admins
    await notifyAdminPrivateMessage(idea, username, messageText);

    ctx.session.waitingForPrivateMessage = false;
    ctx.session.privateMessageIdeaId = null;

    await ctx.replyWithMarkdown(
      `✅ *Private Message Sent!*\n\n` +
      `Your message has been sent to the idea writer.`,
      getHomeKeyboard()
    );

  } catch (error) {
    console.error('Error sending private message:', error);
    await ctx.reply('❌ Error sending message. Please try again.', getHomeKeyboard());
  }
}

// ==================== ADMIN SYSTEM ====================
async function notifyAdminNewIdea(ideaId, ideaText, username, userId) {
  const adminIds = process.env.ADMIN_IDS?.split(',') || [];
  
  const message = `💡 *NEW IDEA SUBMISSION*\n\n` +
    `👤 From: ${username}\n` +
    `🆔 User ID: ${userId}\n\n` +
    `*Idea Text:*\n${ideaText}`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Approve', `approve_idea_${ideaId}`),
      Markup.button.callback('❌ Reject', `reject_idea_${ideaId}`)
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

async function notifyAdminNewComment(idea, username, commentText) {
  const adminIds = process.env.ADMIN_IDS?.split(',') || [];
  
  const message = `💬 *NEW PUBLIC COMMENT*\n\n` +
    `👤 From: ${username}\n` +
    `💡 Idea #${idea.ideaNumber}\n` +
    `*Comment:* ${commentText}`;

  for (const adminId of adminIds) {
    try {
      await bot.telegram.sendMessage(adminId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error(`Failed to notify admin ${adminId}:`, error);
    }
  }
}

async function notifyAdminPrivateMessage(idea, username, messageText) {
  const adminIds = process.env.ADMIN_IDS?.split(',') || [];
  
  const message = `💌 *NEW PRIVATE MESSAGE*\n\n` +
    `👤 From: ${username}\n` +
    `💡 Idea #${idea.ideaNumber}\n` +
    `👥 To: ${idea.username}\n` +
    `*Message:* ${messageText}`;

  for (const adminId of adminIds) {
    try {
      await bot.telegram.sendMessage(adminId, message, { parse_mode: 'Markdown' });
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
    const idea = ideaDoc.data();
    
    ideaCounter += 1;
    
    await db.collection('ideas').doc(ideaId).update({
      status: 'approved',
      ideaNumber: ideaCounter,
      approvedAt: new Date().toISOString(),
      approvedBy: ctx.from.username
    });

    const channelMessage = await postIdeaToChannel(idea, ideaCounter);
    
    await db.collection('ideas').doc(ideaId).update({
      channelMessageId: channelMessage.message_id
    });

    await bot.telegram.sendMessage(
      idea.userId,
      `🎉 *Your Idea #${ideaCounter} Was Approved!*\n\n` +
      `Your idea has been posted to the community channel!\n\n` +
      `💡 *Your Idea:*\n${idea.text}`,
      getHomeKeyboard()
    );

    await ctx.editMessageText(`✅ Idea #${ideaCounter} approved and posted!`);
    
  } catch (error) {
    console.error('Error approving idea:', error);
    await ctx.answerCbQuery('❌ Error approving idea.');
  }
}

async function rejectIdea(ctx, ideaId) {
  await ctx.editMessageText(`❌ Rejecting idea\n\nPlease send the rejection reason:`);
  ctx.session.rejectingIdea = ideaId;
}

async function handleIdeaRejection(ctx, reason) {
  const ideaId = ctx.session.rejectingIdea;
  const ideaDoc = await db.collection('ideas').doc(ideaId).get();
  const idea = ideaDoc.data();
    
  await db.collection('ideas').doc(ideaId).update({
    status: 'rejected',
    rejectionReason: reason
  });

  await bot.telegram.sendMessage(
    idea.userId,
    `❌ *Idea Not Approved*\n\nReason: ${reason}\n\nYou can submit a new idea.`,
    getHomeKeyboard()
  );

  await ctx.reply(`✅ Idea rejected.`);
  ctx.session.rejectingIdea = null;
}

// ==================== CHANNEL POSTING ====================
async function postIdeaToChannel(idea, ideaNumber) {
  const channelId = process.env.CHANNEL_ID;
  
  const message = `💡 *Idea #${ideaNumber}*\n\n` +
    `${idea.text}\n\n` +
    `─────────────────────`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(`💬 Comments (0)`, `view_idea_${idea.ideaId}`)]
  ]);

  return await bot.telegram.sendMessage(channelId, message, {
    parse_mode: 'Markdown',
    reply_markup: keyboard.reply_markup
  });
}

async function updateChannelCommentCount(ideaId, newCount) {
  try {
    const ideaDoc = await db.collection('ideas').doc(ideaId).get();
    const idea = ideaDoc.data();

    if (!idea.channelMessageId) return;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`💬 Comments (${newCount})`, `view_idea_${ideaId}`)]
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

// ==================== HELP COMMAND ====================
bot.action('show_help', async (ctx) => {
  const helpText = `🆘 *Community Bot Help*\n\n` +
    `*Public Comments:*\n` +
    `• Visible to everyone in the bot\n` +
    `• Discuss ideas openly\n\n` +
    `*Private Messages:*\n` +
    `• Send anonymous messages to idea writers\n` +
    `• Only the writer sees your message\n\n` +
    `*Admins can see all activities with usernames*`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🏠 Home', 'home')]
  ]);

  await ctx.editMessageText(helpText, {
    parse_mode: 'Markdown',
    reply_markup: keyboard.reply_markup
  });
});

bot.command('help', async (ctx) => {
  const helpText = `🆘 *Community Bot Help*\n\nUse the buttons to navigate or type:\n` +
    `/start - Main menu\n` +
    `/submit - Submit idea\n` +
    `/ideas - Browse ideas\n` +
    `/help - This message`;

  await ctx.replyWithMarkdown(helpText, getHomeKeyboard());
});

// ==================== ERROR HANDLER ====================
bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err);
  ctx.reply('❌ An error occurred. Please try again.', getHomeKeyboard());
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
  initializeIdeaCounter().then(() => {
    bot.launch().then(() => {
      console.log('🚀 Community Bot started in development mode');
    });
  });
  
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
        }
