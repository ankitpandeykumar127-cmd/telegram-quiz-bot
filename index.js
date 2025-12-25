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

const ADMINS = ADMIN_IDS.split(",").map(Number);
const GROUP_ID = Number(QUIZ_GROUP_ID);
const CHANNEL_ID = Number(QUIZ_CHANNEL_ID);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// UI Helpers
const icons = {
  success: "✅",
  error: "❌",
  clock: "⏰",
  trophy: "🏆",
  rocket: "🚀",
  admin: "🛠",
  stop: "🛑"
};

/* ===================== DATA PERSISTENCE ===================== */
const safeRead = (file, def) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return def; }
};

const safeWrite = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

let sessions = safeRead("sessions.json", {});
let schedules = safeRead("schedule.json", []);

let quiz = {
  active: false,
  session: null,
  index: 0,
  pollMap: {},
  scores: {},
  users: {},
  timer: null
};

/* ===================== PERMISSIONS ===================== */
const setGroupMute = async (isMuted) => {
  try {
    await bot.setChatPermissions(GROUP_ID, {
      can_send_messages: !isMuted,
      can_send_audios: !isMuted,
      can_send_documents: !isMuted,
      can_send_photos: !isMuted,
      can_send_videos: !isMuted,
      can_send_video_notes: !isMuted,
      can_send_voice_notes: !isMuted,
      can_send_polls: !isMuted,
      can_send_other_messages: !isMuted,
      can_add_web_page_previews: !isMuted
    });
  } catch (e) { console.error("Permission Error:", e.message); }
};

/* ===================== CORE COMMANDS ===================== */

// /start command with better UI
bot.onText(/\/start/, (msg) => {
  const welcome = `<b>👋 Welcome ${msg.from.first_name}!</b>\n\n` +
    `🧠 <b>Quiz Mode:</b> Automated\n` +
    `📢 <b>Channel:</b> <a href="${GROUP_INVITE_LINK}">Join Here</a>\n\n` +
    `<i>Main group is automatically muted during active quizzes.</i>`;
  bot.sendMessage(msg.chat.id, welcome, { parse_mode: "HTML", disable_web_page_preview: true });
});

// Admin Panel
bot.onText(/\/admin/, (msg) => {
  if (!ADMINS.includes(msg.from.id)) return;
  const menu = `<b>${icons.admin} Admin Control Panel</b>\n\n` +
    `<code>/status</code> - View all schedules\n` +
    `<code>/startquiz KEY</code> - Start immediately\n` +
    `<code>/delete KEY</code> - Remove session\n` +
    `<code>/stop</code> - Kill active quiz`;
  bot.sendMessage(msg.chat.id, menu, { parse_mode: "HTML" });
});

/* ===================== QUIZ PARSER (IMPROVED) ===================== */
bot.on("message", (msg) => {
  if (!ADMINS.includes(msg.from.id) || msg.chat.type !== "private" || !msg.text || msg.text.startsWith("/")) return;

  const lines = msg.text.split("\n");
  let dateText, sessionName, timeText, buf = [];

  const processBlock = () => {
    if (!dateText || !sessionName || !timeText || !buf.length) return;

    // IST to Date Object conversion logic
    const [d, m, y] = dateText.split("-");
    const startTime = new Date(`${y}-${m}-${d}T${timeText}:00+05:30`).getTime();

    if (isNaN(startTime)) return bot.sendMessage(msg.chat.id, `${icons.error} Invalid Date/Time.`);

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

      if (q && o.length >= 2 && a) {
        sessions[key].push({ question: q, options: o, correct: a.charCodeAt(0) - 65 });
      }
    });

    if (sessions[key].length > 0) {
      schedules = schedules.filter(s => s.session !== key); // Remove old same-key
      schedules.push({ session: key, startAt: startTime, notified: false, started: false });
      bot.sendMessage(msg.chat.id, `${icons.success} <b>Quiz Scheduled!</b>\n\n🏷 <b>Key:</b> <code>${key}</code>\n❓ <b>Total:</b> ${sessions[key].length} Questions\n⏰ <b>Time:</b> ${new Date(startTime).toLocaleString('en-IN')}`, { parse_mode: "HTML" });
    }
    buf = [];
  };

  lines.forEach(l => {
    if (l.startsWith("DATE:")) { processBlock(); dateText = l.replace("DATE:", "").trim(); }
    else if (l.startsWith("SESSION:")) { processBlock(); sessionName = l.replace("SESSION:", "").trim(); }
    else if (l.startsWith("TIME:")) { timeText = l.replace("TIME:", "").trim(); }
    else { buf.push(l); }
  });
  processBlock();

  safeWrite("sessions.json", sessions);
  safeWrite("schedule.json", schedules);
});

/* ===================== SCHEDULER & ENGINE ===================== */
setInterval(() => {
  const now = Date.now();
  schedules.forEach(async (s, index) => {
    if (s.started) return;

    // 5 Min Warning
    if (!s.notified && now >= s.startAt - 5 * 60 * 1000) {
      s.notified = true;
      bot.sendMessage(CHANNEL_ID, `<b>${icons.clock} UPCOMING QUIZ</b>\n\nThe session <u>${s.session}</u> starts in 5 minutes!`, { parse_mode: "HTML" });
    }

    // Auto Start
    if (now >= s.startAt) {
      s.started = true;
      startQuiz(s.session);
    }
  });
}, 10000);

async function startQuiz(key) {
  if (quiz.active) return;
  const qs = sessions[key];
  if (!qs) return;

  quiz = { active: true, session: key, index: 0, pollMap: {}, scores: {}, users: {} };
  
  await setGroupMute(true);
  await bot.sendMessage(GROUP_ID, `<b>${icons.rocket} QUIZ STARTED!</b>\n\nTopic: <code>${key}</code>\nQuestions: ${qs.length}\n\n<i>Group is now muted. Good luck!</i>`, { parse_mode: "HTML" });
  
  setTimeout(sendNext, 3000);
}

async function sendNext() {
  if (!quiz.active) return;
  const currentQs = sessions[quiz.session];

  if (quiz.index >= currentQs.length) {
    return showLeaderboard();
  }

  const q = currentQs[quiz.index];
  try {
    const p = await bot.sendPoll(GROUP_ID, `[Q${quiz.index + 1}/${currentQs.length}] ${q.question}`, q.options, {
      type: "quiz",
      correct_option_id: q.correct,
      is_anonymous: false,
      open_period: 30
    });

    quiz.pollMap[p.poll.id] = { correct: q.correct };
    quiz.index++;
    
    // Logic: Wait for poll (30s) + Buffer (5s)
    quiz.timer = setTimeout(sendNext, 35000);
  } catch (e) {
    console.error("Poll Error:", e.message);
    quiz.index++;
    sendNext();
  }
}

/* ===================== SCORING & RESULTS ===================== */
bot.on("poll_answer", (ans) => {
  if (!quiz.active) return;
  const data = quiz.pollMap[ans.poll_id];
  if (!data) return;

  const uid = ans.user.id;
  quiz.users[uid] = ans.user.first_name || "Anonymous";

  if (ans.option_ids[0] === data.correct) {
    quiz.scores[uid] = (quiz.scores[uid] || 0) + 1;
  }
});

async function showLeaderboard() {
  const sessionKey = quiz.session;
  const total = sessions[sessionKey]?.length || 0;
  
  let board = `<b>${icons.trophy} QUIZ COMPLETED!</b>\n\nSession: <code>${sessionKey}</code>\n\n`;
  
  const sorted = Object.entries(quiz.scores)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);

  if (sorted.length === 0) {
    board += "<i>No participants scored points.</i>";
  } else {
    sorted.forEach(([id, score], i) => {
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "🔹";
      board += `${medal} <b>${quiz.users[id]}</b>: ${score}/${total}\n`;
    });
  }

  await bot.sendMessage(GROUP_ID, board, { parse_mode: "HTML" });
  
  // Cleanup
  await setGroupMute(false);
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
  let text = `<b>📊 Current System Status</b>\n\n<b>Pending Sessions:</b>\n`;
  schedules.forEach((s, i) => {
    text += `${i + 1}. <code>${s.session}</code>\n   📅 ${new Date(s.startAt).toLocaleString('en-IN')}\n`;
  });
  bot.sendMessage(msg.chat.id, text || "No pending sessions.", { parse_mode: "HTML" });
});

bot.onText(/\/stop/, async (msg) => {
  if (!ADMINS.includes(msg.from.id)) return;
  quiz.active = false;
  clearTimeout(quiz.timer);
  await setGroupMute(false);
  bot.sendMessage(GROUP_ID, `${icons.stop} <b>The quiz has been terminated by Admin.</b>`, { parse_mode: "HTML" });
});

bot.onText(/\/delete (.+)/, (msg, match) => {
  if (!ADMINS.includes(msg.from.id)) return;
  const key = match[1].trim();
  delete sessions[key];
  schedules = schedules.filter(s => s.session !== key);
  safeWrite("sessions.json", sessions);
  safeWrite("schedule.json", schedules);
  bot.sendMessage(msg.chat.id, `${icons.success} Session <code>${key}</code> deleted.`, { parse_mode: "HTML" });
});

bot.onText(/\/startquiz (.+)/, (msg, match) => {
  if (!ADMINS.includes(msg.from.id)) return;
  const key = match[1].trim();
  if (sessions[key]) {
    startQuiz(key);
  } else {
    bot.sendMessage(msg.chat.id, `${icons.error} Session key not found.`);
  }
});

// Error Handling
process.on("unhandledRejection", (err) => console.log("Critical Error:", err.message));