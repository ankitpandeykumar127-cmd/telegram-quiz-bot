require("dotenv").config();
const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");

/* ===================== CONFIG & ENV ===================== */
const { 
  BOT_TOKEN, 
  ADMIN_IDS, 
  QUIZ_GROUP_ID, 
  QUIZ_CHANNEL_ID, 
  GROUP_INVITE_LINK 
} = process.env;

if (!BOT_TOKEN || !ADMIN_IDS || !QUIZ_GROUP_ID || !QUIZ_CHANNEL_ID) {
  console.error("❌ Missing Environment Variables!");
  process.exit(1);
}

const ADMINS = ADMIN_IDS.split(",").map(Number);
const GROUP_ID = Number(QUIZ_GROUP_ID);
const CHANNEL_ID = Number(QUIZ_CHANNEL_ID);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const icons = {
  success: "✅", error: "❌", clock: "⏰", trophy: "🏆",
  rocket: "🚀", admin: "🛠", stop: "🛑", megaphone: "📢", stats: "📊"
};

/* ===================== DATA PERSISTENCE ===================== */
const safeRead = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const safeWrite = (f, d) => { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch (e) { console.error(e); } };

let sessions = safeRead("sessions.json", {});
let schedules = safeRead("schedule.json", []);
let userStats = safeRead("stats.json", {});

let quiz = { active: false, session: null, index: 0, pollMap: {}, scores: {}, users: {}, timer: null };

/* ===================== HELPERS ===================== */
const formatIST = (dateObj) => {
  return dateObj.toLocaleString('en-IN', { 
    timeZone: 'Asia/Kolkata', 
    hour12: true, 
    timeStyle: 'short', 
    dateStyle: 'medium' 
  });
};

const setGroupMute = async (mute) => {
  try {
    await bot.setChatPermissions(GROUP_ID, { can_send_messages: !mute });
  } catch (e) { console.error("Permission Error:", e.message); }
};

/* ===================== CORE COMMANDS ===================== */

// Start Command
bot.onText(/\/start/, (msg) => {
  const welcome = `<b>👋 Hello ${msg.from.first_name}!</b>\n\n` +
    `${icons.megaphone} <b>Channel:</b> <a href="${GROUP_INVITE_LINK}">Join Here</a>\n` +
    `🧠 <b>Quiz Mode:</b> Automated Scheduling\n\n` +
    `${icons.stats} <b>User Commands:</b>\n` +
    `<code>/mytop</code> - Check your lifetime quiz performance.\n\n` +
    `<i>Admin will schedule quizzes. Stay tuned!</i>`;
  bot.sendMessage(msg.chat.id, welcome, { parse_mode: "HTML", disable_web_page_preview: true });
});

// MyTop Stats
bot.onText(/\/mytop/, (msg) => {
  const uid = msg.from.id;
  const stats = userStats[uid] || { played: 0, correct: 0 };
  const avg = stats.played > 0 ? (stats.correct / stats.played).toFixed(1) : 0;

  const text = `<b>${icons.stats} YOUR PERFORMANCE</b>\n\n` +
    `👤 <b>User:</b> ${msg.from.first_name}\n` +
    `📝 <b>Quizzes Played:</b> ${stats.played}\n` +
    `✅ <b>Lifetime Correct:</b> ${stats.correct}\n` +
    `📈 <b>Avg Score:</b> ${avg} per quiz`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// Admin Broadcast
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (!ADMINS.includes(msg.from.id)) return;
  const announcement = match[1];
  const text = `📢 <b>IMPORTANT ANNOUNCEMENT</b>\n\n${announcement}`;

  try {
    await bot.sendMessage(GROUP_ID, text, { parse_mode: "HTML" });
    await bot.sendMessage(CHANNEL_ID, text, { parse_mode: "HTML" });
    bot.sendMessage(msg.chat.id, `${icons.success} Broadcast sent to Group & Channel!`);
  } catch (e) { bot.sendMessage(msg.chat.id, `${icons.error} Broadcast failed.`); }
});

/* ===================== QUIZ PARSER (STABLE IST) ===================== */
bot.on("message", (msg) => {
  if (!ADMINS.includes(msg.from.id) || msg.chat.type !== "private" || !msg.text || msg.text.startsWith("/")) return;

  const lines = msg.text.split("\n");
  let dateText, sessionName, timeText, buf = [];

  const processBlock = () => {
    if (!dateText || !sessionName || !timeText || !buf.length) return;

    // Stable Time Parsing for Railway (Forcing IST)
    const [d, m, y] = dateText.split("-");
    const [hh, mm] = timeText.split(":");
    const startTime = new Date(`${y}-${m}-${d}T${hh}:${mm}:00+05:30`).getTime();

    if (isNaN(startTime)) return bot.sendMessage(msg.chat.id, `${icons.error} Date/Time error. Use DD-MM-YYYY and HH:MM.`);

    const key = `${dateText}_${sessionName}`.replace(/\s+/g, "_");
    sessions[key] = [];

    const blocks = buf.join("\n").split(/\n\s*\n/);
    blocks.forEach(block => {
      let q = "", o = [], a = "";
      block.split("\n").forEach(l => {
        l = l.trim();
        if (/^Q/i.test(l)) q = l.replace(/^Q\d*\.\s*/i, "");
        else if (/^[A-D]\)/.test(l)) o.push(l.slice(2).trim());
        else if (/^ANS:/i.test(l)) a = l.replace(/^ANS:/i, "").trim().toUpperCase();
      });
      if (q && o.length >= 2 && a) sessions[key].push({ question: q, options: o, correct: a.charCodeAt(0) - 65 });
    });

    if (sessions[key].length > 0) {
      schedules = schedules.filter(s => s.session !== key);
      schedules.push({ session: key, startAt: startTime, notified: false, started: false });
      
      const display = formatIST(new Date(startTime));
      bot.sendMessage(msg.chat.id, 
        `${icons.success} <b>Quiz Scheduled!</b>\n\n` +
        `🏷 <b>Key:</b> <code>${key}</code>\n` +
        `⏰ <b>IST Time:</b> ${display}\n` +
        `❓ <b>Questions:</b> ${sessions[key].length}`, { parse_mode: "HTML" });
    }
    buf = [];
  };

  lines.forEach(l => {
    const line = l.trim();
    if (line.startsWith("DATE:")) { processBlock(); dateText = line.replace("DATE:", "").trim(); }
    else if (line.startsWith("SESSION:")) { processBlock(); sessionName = line.replace("SESSION:", "").trim(); }
    else if (line.startsWith("TIME:")) { timeText = line.replace("TIME:", "").trim(); }
    else { buf.push(line); }
  });
  processBlock();

  safeWrite("sessions.json", sessions);
  safeWrite("schedule.json", schedules);
});

/* ===================== SCHEDULER & NOTIFIER ===================== */
setInterval(() => {
  const now = Date.now();
  schedules.forEach(async (s) => {
    if (s.started) return;

    // 5 Min Notice with Join Button
    if (!s.notified && now >= s.startAt - 5 * 60 * 1000) {
      s.notified = true;
      bot.sendMessage(CHANNEL_ID, 
        `<b>${icons.clock} QUIZ ALERT (5 MINS)</b>\n\n` +
        `📝 <b>Session:</b> <u>${s.session}</u>\n` +
        `🚀 Quiz is about to start in the main group!`, { 
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "🚀 Join Quiz Group", url: GROUP_INVITE_LINK }]] }
        }).catch(console.error);
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

  quiz = { active: true, session: key, index: 0, pollMap: {}, scores: {}, users: {}, timer: null };
  
  await setGroupMute(true);
  await bot.sendMessage(GROUP_ID, `<b>${icons.rocket} QUIZ STARTED!</b>\n\n🏷 Topic: <code>${key}</code>\n❓ Total Questions: ${qs.length}\n\n<i>Group Muted. Focus!</i>`, { parse_mode: "HTML" });
  
  setTimeout(sendNext, 4000);
}

async function sendNext() {
  if (!quiz.active) return;
  const currentQs = sessions[quiz.session];

  if (quiz.index >= currentQs.length) return showLeaderboard();

  const q = currentQs[quiz.index];
  try {
    const p = await bot.sendPoll(GROUP_ID, `[Q${quiz.index + 1}/${currentQs.length}] ${q.question}`, q.options, {
      type: "quiz", correct_option_id: q.correct, is_anonymous: false, open_period: 30
    });
    quiz.pollMap[p.poll.id] = { correct: q.correct };
    quiz.index++;
    quiz.timer = setTimeout(sendNext, 35000); // 30s poll + 5s gap
  } catch (e) { quiz.index++; sendNext(); }
}

bot.on("poll_answer", (ans) => {
  if (!quiz.active) return;
  const data = quiz.pollMap[ans.poll_id];
  if (!data) return;

  const uid = ans.user.id;
  quiz.users[uid] = ans.user.first_name || "User";
  if (ans.option_ids[0] === data.correct) quiz.scores[uid] = (quiz.scores[uid] || 0) + 1;
});

async function showLeaderboard() {
  const sessionKey = quiz.session;
  const total = sessions[sessionKey]?.length || 0;
  let board = `<b>${icons.trophy} QUIZ COMPLETED!</b>\n\nSession: <code>${sessionKey}</code>\n\n`;

  const sorted = Object.entries(quiz.scores).sort(([, a], [, b]) => b - a).slice(0, 10);

  if (sorted.length === 0) board += "<i>No one participated.</i>";
  else {
    sorted.forEach(([id, score], i) => {
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "🔹";
      board += `${medal} <b>${quiz.users[id]}</b>: ${score}/${total}\n`;
      
      // Save Lifetime Stats
      if (!userStats[id]) userStats[id] = { played: 0, correct: 0 };
      userStats[id].played++;
      userStats[id].correct += score;
    });
  }

  safeWrite("stats.json", userStats);
  await bot.sendMessage(GROUP_ID, board, { parse_mode: "HTML" });
  await setGroupMute(false);
  
  // Cleanup
  quiz.active = false;
  clearTimeout(quiz.timer);
  delete sessions[sessionKey];
  schedules = schedules.filter(s => s.session !== sessionKey);
  safeWrite("sessions.json", sessions);
  safeWrite("schedule.json", schedules);
}

/* ===================== ADMIN TOOLS ===================== */
bot.onText(/\/status/, (msg) => {
  if (!ADMINS.includes(msg.from.id)) return;
  let t = `<b>${icons.stats} SYSTEM STATUS</b>\n\n<b>Pending Quizzes:</b>\n`;
  if (schedules.length === 0) t += "None scheduled.";
  schedules.forEach((s, i) => {
    t += `${i + 1}. <code>${s.session}</code>\n   ⏰ ${formatIST(new Date(s.startAt))}\n`;
  });
  bot.sendMessage(msg.chat.id, t, { parse_mode: "HTML" });
});

bot.onText(/\/stop/, async (msg) => {
  if (!ADMINS.includes(msg.from.id)) return;
  quiz.active = false;
  clearTimeout(quiz.timer);
  await setGroupMute(false);
  bot.sendMessage(GROUP_ID, `${icons.stop} <b>Quiz stopped by Admin.</b>`, { parse_mode: "HTML" });
});

bot.onText(/\/delete (.+)/, (msg, match) => {
  if (!ADMINS.includes(msg.from.id)) return;
  const key = match[1].trim();
  delete sessions[key];
  schedules = schedules.filter(s => s.session !== key);
  safeWrite("sessions.json", sessions);
  safeWrite("schedule.json", schedules);
  bot.sendMessage(msg.chat.id, `${icons.success} Deleted: <code>${key}</code>`, { parse_mode: "HTML" });
});

process.on("unhandledRejection", (err) => console.log("Critical Error:", err.message));