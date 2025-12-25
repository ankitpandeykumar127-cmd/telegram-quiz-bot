require("dotenv").config();
const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");

/* ===================== CONFIG & ENV ===================== */
const { BOT_TOKEN, ADMIN_IDS, QUIZ_GROUP_ID, QUIZ_CHANNEL_ID, GROUP_INVITE_LINK } = process.env;
const ADMINS = ADMIN_IDS.split(",").map(Number);
const GROUP_ID = Number(QUIZ_GROUP_ID);
const CHANNEL_ID = Number(QUIZ_CHANNEL_ID);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

/* ===================== DATA PERSISTENCE ===================== */
const safeRead = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const safeWrite = (f, d) => { fs.writeFileSync(f, JSON.stringify(d, null, 2)); };

let sessions = safeRead("sessions.json", {});
let schedules = safeRead("schedule.json", []);
let userStats = safeRead("stats.json", {}); // For /mytop

let quiz = { active: false, session: null, index: 0, pollMap: {}, scores: {}, users: {}, timer: null };

/* ===================== HELPERS ===================== */
const formatIST = (dateObj) => {
  return dateObj.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, timeStyle: 'short', dateStyle: 'medium' });
};

const setGroupMute = async (mute) => {
  try {
    await bot.setChatPermissions(GROUP_ID, { can_send_messages: !mute });
  } catch (e) { console.error("Mute Error:", e.message); }
};

/* ===================== CORE COMMANDS ===================== */

bot.onText(/\/start/, (msg) => {
  const welcome = `<b>👋 Hello ${msg.from.first_name}!</b>\n\n` +
    `📢 <b>Channel:</b> <a href="${GROUP_INVITE_LINK}">Join Here</a>\n` +
    `🧠 <b>Quiz Mode:</b> Auto-Scheduled\n\n` +
    `📊 <b>User Commands:</b>\n` +
    `<code>/mytop</code> - Check your quiz performance and stats.\n\n` +
    `<i>Note: Group is muted during active quizzes for focus.</i>`;
  bot.sendMessage(msg.chat.id, welcome, { parse_mode: "HTML", disable_web_page_preview: true });
});

bot.onText(/\/mytop/, (msg) => {
  const uid = msg.from.id;
  const stats = userStats[uid] || { played: 0, correct: 0 };
  const avg = stats.played > 0 ? (stats.correct / stats.played).toFixed(1) : 0;

  const text = `<b>📊 Your Quiz Stats</b>\n\n` +
    `👤 <b>User:</b> ${msg.from.first_name}\n` +
    `📝 <b>Quizzes Played:</b> ${stats.played}\n` +
    `✅ <b>Total Correct:</b> ${stats.correct}\n` +
    `📈 <b>Average Score:</b> ${avg} per quiz`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

/* ===================== ADMIN: BROADCAST ===================== */
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (!ADMINS.includes(msg.from.id)) return;
  const announcement = match[1];
  const text = `📢 <b>OFFICIAL ANNOUNCEMENT</b>\n\n${announcement}`;

  try {
    // Send to Group
    await bot.sendMessage(GROUP_ID, text, { parse_mode: "HTML" });
    // Send to Channel
    await bot.sendMessage(CHANNEL_ID, text, { parse_mode: "HTML" });
    bot.sendMessage(msg.chat.id, "✅ Broadcast sent successfully!");
  } catch (e) {
    bot.sendMessage(msg.chat.id, "❌ Error sending broadcast.");
  }
});

/* ===================== QUIZ PARSER (FIXED IST) ===================== */
bot.on("message", (msg) => {
  if (!ADMINS.includes(msg.from.id) || msg.chat.type !== "private" || !msg.text || msg.text.startsWith("/")) return;

  const lines = msg.text.split("\n");
  let dText, sName, tText, buf = [];

  const flush = () => {
    if (!dText || !sName || !tText || !buf.length) return;

    // Fixed IST Timezone logic for Railway
    const [d, m, y] = dText.split("-");
    const [hh, mm] = tText.split(":");
    // Create date and adjust for IST (+5:30)
    const date = new Date(`${y}-${m}-${d}T${hh}:${mm}:00+05:30`);
    const startTime = date.getTime();

    if (isNaN(startTime)) return bot.sendMessage(msg.chat.id, "❌ Invalid format.");

    const key = `${dText}_${sName}`.replace(/\s+/g, "_");
    sessions[key] = [];
    buf.join("\n").split(/\n\s*\n/).forEach(block => {
      let q = "", o = [], a = "";
      block.split("\n").forEach(l => {
        if (/^Q/i.test(l)) q = l.replace(/^Q\d*\.\s*/i, "");
        else if (/^[A-D]\)/.test(l)) o.push(l.slice(2).trim());
        else if (/^ANS:/i.test(l)) a = l.replace(/^ANS:/i, "").trim().toUpperCase();
      });
      if (q && o.length >= 2 && a) sessions[key].push({ question: q, options: o, correct: a.charCodeAt(0) - 65 });
    });

    if (sessions[key].length > 0) {
      schedules = schedules.filter(s => s.session !== key);
      schedules.push({ session: key, startAt: startTime, notified: false, started: false });
      bot.sendMessage(msg.chat.id, `✅ <b>Quiz Scheduled!</b>\n\nTopic: <code>${key}</code>\nTime: <b>${formatIST(date)}</b>`, { parse_mode: "HTML" });
    }
    buf = [];
  };

  lines.forEach(l => {
    if (l.startsWith("DATE:")) { flush(); dText = l.replace("DATE:", "").trim(); }
    else if (l.startsWith("SESSION:")) { flush(); sName = l.replace("SESSION:", "").trim(); }
    else if (l.startsWith("TIME:")) { tText = l.replace("TIME:", "").trim(); }
    else buf.push(l);
  });
  flush();
  safeWrite("sessions.json", sessions);
  safeWrite("schedule.json", schedules);
});

/* ===================== SCHEDULER & JOIN BUTTON ===================== */
setInterval(() => {
  const now = Date.now();
  schedules.forEach(s => {
    if (s.started) return;
    
    // 5 Min Warning with Join Button
    if (!s.notified && now >= s.startAt - 300000) {
      s.notified = true;
      bot.sendMessage(CHANNEL_ID, `⏰ <b>Upcoming Quiz!</b>\n\nTopic: <u>${s.session}</u>\nStarts in 5 minutes!`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "🚀 Join Quiz Group", url: GROUP_INVITE_LINK }]]
        }
      });
    }

    if (now >= s.startAt) {
      s.started = true;
      startQuiz(s.session);
    }
  });
}, 10000);

/* ===================== QUIZ ENGINE ===================== */
async function startQuiz(key) {
  if (quiz.active) return;
  const qs = sessions[key];
  if (!qs) return;

  quiz = { active: true, session: key, index: 0, pollMap: {}, scores: {}, users: {} };
  await setGroupMute(true);
  await bot.sendMessage(GROUP_ID, `🚀 <b>QUIZ STARTED!</b>\n\nTopic: <code>${key}</code>\nQuestions: ${qs.length}\n\n<i>Group Muted. Be fast!</i>`, { parse_mode: "HTML" });
  setTimeout(sendNext, 3000);
}

async function sendNext() {
  if (!quiz.active) return;
  const qs = sessions[quiz.session];
  if (quiz.index >= qs.length) return showLeaderboard();

  const q = qs[quiz.index];
  const p = await bot.sendPoll(GROUP_ID, `[Q${quiz.index + 1}/${qs.length}] ${q.question}`, q.options, {
    type: "quiz", correct_option_id: q.correct, is_anonymous: false, open_period: 30
  });

  quiz.pollMap[p.poll.id] = { correct: q.correct };
  quiz.index++;
  quiz.timer = setTimeout(sendNext, 35000);
}

bot.on("poll_answer", a => {
  if (!quiz.active) return;
  const map = quiz.pollMap[a.poll_id];
  if (!map) return;

  const uid = a.user.id;
  quiz.users[uid] = a.user.first_name;
  if (a.option_ids[0] === map.correct) {
    quiz.scores[uid] = (quiz.scores[uid] || 0) + 1;
  }
});

async function showLeaderboard() {
  const total = sessions[quiz.session]?.length || 0;
  let b = `🏆 <b>LEADERBOARD: ${quiz.session}</b>\n\n`;
  const sorted = Object.entries(quiz.scores).sort(([,x],[,y])=>y-x).slice(0, 10);

  sorted.forEach(([id, score], i) => {
    b += `${i+1}. <b>${quiz.users[id]}</b>: ${score}/${total}\n`;
    
    // Update User Stats for /mytop
    if (!userStats[id]) userStats[id] = { played: 0, correct: 0 };
    userStats[id].played += 1;
    userStats[id].correct += score;
  });

  safeWrite("stats.json", userStats);
  await bot.sendMessage(GROUP_ID, b || "No participants.", { parse_mode: "HTML" });
  await setGroupMute(false);
  quiz.active = false;
  schedules = schedules.filter(s => s.session !== quiz.session);
  safeWrite("schedule.json", schedules);
}

/* ===================== ADMIN TOOLS ===================== */
bot.onText(/\/status/, (msg) => {
  if (!ADMINS.includes(msg.from.id)) return;
  let t = "📊 <b>Status:</b>\n\n";
  schedules.forEach(s => t += `- <code>${s.session}</code>\n⏰ ${formatIST(new Date(s.startAt))}\n\n`);
  bot.sendMessage(msg.chat.id, t || "No active schedules.", { parse_mode: "HTML" });
});

bot.onText(/\/stop/, async (m) => {
  if (!ADMINS.includes(m.from.id)) return;
  quiz.active = false; clearTimeout(quiz.timer);
  await setGroupMute(false);
  bot.sendMessage(GROUP_ID, "🛑 Quiz stopped by Admin.");
});

bot.onText(/\/delete (.+)/, (msg, match) => {
  if (!ADMINS.includes(msg.from.id)) return;
  const key = match[1].trim();
  delete sessions[key];
  schedules = schedules.filter(s => s.session !== key);
  safeWrite("sessions.json", sessions);
  safeWrite("schedule.json", schedules);
  bot.sendMessage(msg.chat.id, `✅ Deleted: ${key}`);
});