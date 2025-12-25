require("dotenv").config();
const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");

/* ===================== ENV ===================== */
const {
  BOT_TOKEN,
  ADMIN_IDS,
  QUIZ_GROUP_ID,
  QUIZ_CHANNEL_ID,
  GROUP_INVITE_LINK
} = process.env;

if (!BOT_TOKEN || !ADMIN_IDS || !QUIZ_GROUP_ID || !QUIZ_CHANNEL_ID) {
  console.error("❌ Missing ENV values");
  process.exit(1);
}

const ADMINS = ADMIN_IDS.split(",").map(Number);
const GROUP_ID = Number(QUIZ_GROUP_ID);
const CHANNEL_ID = Number(QUIZ_CHANNEL_ID);

/* ===================== BOT ===================== */
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("🤖 Quiz Bot is Online and Ready!");

/* ===================== FILE HELPERS ===================== */
const safeRead = (file, def) => {
  try {
    if (!fs.existsSync(file)) return def;
    const data = fs.readFileSync(file, "utf8");
    return data ? JSON.parse(data) : def;
  } catch { return def; }
};

const safeWrite = (file, data) => {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) { console.error(`Error writing ${file}:`, err); }
};

/* ===================== DATA INITIALIZATION ===================== */
let sessions = safeRead("sessions.json", {});
let schedules = safeRead("schedule.json", []);

let quiz = {
  active: false,
  session: null,
  index: 0,
  pollMap: {},
  scores: {},
  users: {},
  answered: {}
};

/* ===================== HELPERS ===================== */
const isAdmin = id => ADMINS.includes(id);

const setGroupPermission = (canTalk) => {
  bot.setChatPermissions(GROUP_ID, {
    can_send_messages: canTalk,
    can_send_audios: canTalk,
    can_send_documents: canTalk,
    can_send_photos: canTalk,
    can_send_videos: canTalk,
    can_send_video_notes: canTalk,
    can_send_voice_notes: canTalk,
    can_send_polls: canTalk,
    can_send_other_messages: canTalk,
    can_add_web_page_previews: canTalk
  }).catch(err => console.error("Permission Error:", err.message));
};

/* ===================== COMMANDS ===================== */
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, `👋 Hello ${msg.from.first_name}!\n\nI manage automated quizzes.\n📢 Join: ${GROUP_INVITE_LINK || 'Not Set'}`);
});

/* ===================== ADMIN COMMAND FIXED ===================== */
bot.onText(/\/admin/, msg => {
  if (!isAdmin(msg.from.id)) return;
  
  // Markdown ki jagah HTML use karein taaki symbols error na dein
  const adminText = 
    `<b>🛠 Admin Commands</b>\n\n` +
    `/status - Check sessions/schedules\n` +
    `/stop - Force stop current quiz\n` +
    `/delete SESSION_KEY - Delete a session`;

  bot.sendMessage(msg.chat.id, adminText, { parse_mode: "HTML" });
});

/* ===================== QUIZ PARSER ===================== */
bot.on("message", msg => {
  if (!isAdmin(msg.from.id) || msg.chat.type !== "private" || !msg.text || msg.text.startsWith("/")) return;

  const lines = msg.text.split("\n");
  let dateText = null, sessionName = null, timeText = null, buf = [];

  const flush = () => {
    if (!dateText || !sessionName || !timeText || !buf.length) return;

    const key = `${dateText}_${sessionName}`.replace(/\s+/g, '_');
    
    // Convert Date/Time to Timestamp
    const [d, m, y] = dateText.split("-");
    const startTime = new Date(`${y}-${m}-${d}T${timeText}:00`).getTime();

    if (isNaN(startTime)) {
        bot.sendMessage(msg.chat.id, "❌ Invalid Date or Time format.");
        return;
    }

    sessions[key] = [];
    const blocks = buf.join("\n").split(/\n\s*\n/);

    blocks.forEach(block => {
      let q = "", o = [], a = "";
      block.split("\n").forEach(l => {
        l = l.trim();
        if (/^Q/.test(l)) q = l.replace(/^Q\d*\.\s*/, "");
        else if (/^[A-D]\)/.test(l)) o.push(l.slice(2).trim());
        else if (l.toUpperCase().startsWith("ANS:")) a = l.replace(/ANS:/i, "").trim().toUpperCase();
      });

      if (q && o.length >= 2 && a) {
        sessions[key].push({
          question: q,
          options: o,
          correct: a.charCodeAt(0) - 65
        });
      }
    });

    if (sessions[key].length > 0) {
        schedules.push({
            session: key,
            startAt: startTime,
            notified: false,
            started: false
        });
        bot.sendMessage(msg.chat.id, `✅ Added: ${key}\n❓ Questions: ${sessions[key].length}\n⏰ Time: ${new Date(startTime).toLocaleString()}`);
    }
    buf = [];
  };

  lines.forEach(l => {
    const line = l.trim();
    if (line.startsWith("DATE:")) { flush(); dateText = line.replace("DATE:", "").trim(); }
    else if (line.startsWith("SESSION:")) { flush(); sessionName = line.replace("SESSION:", "").trim(); }
    else if (line.startsWith("TIME:")) { timeText = line.replace("TIME:", "").trim(); }
    else { buf.push(line); }
  });
  flush();

  safeWrite("sessions.json", sessions);
  safeWrite("schedule.json", schedules);
});

/* ===================== STATUS ===================== */
bot.onText(/\/status/, msg => {
  if (!isAdmin(msg.from.id)) return;
  let text = "📊 *Bot Status*\n\n📘 *Sessions:*";
  Object.keys(sessions).forEach((k, i) => { text += `\n${i + 1}. ${k} (${sessions[k].length}Q)`; });
  
  text += "\n\n⏰ *Schedules:*";
  schedules.forEach((s, i) => {
    text += `\n${i + 1}. ${s.session} - ${new Date(s.startAt).toLocaleString()} ${s.started ? '✅' : '⏳'}`;
  });
  bot.sendMessage(msg.chat.id, text || "No data found.", { parse_mode: "Markdown" });
});

// Isse aap kabhi bhi koi bhi saved session turant start kar sakte hain
bot.onText(/\/startquiz (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const key = match[1].trim();
  if (sessions[key]) {
    startQuiz(key);
    bot.sendMessage(msg.chat.id, `🚀 Starting Quiz: ${key}`);
  } else {
    bot.sendMessage(msg.chat.id, "❌ Session not found! Check /status");
  }
});

/* ===================== STOP QUIZ ===================== */
bot.onText(/\/stop/, msg => {
  if (!isAdmin(msg.from.id)) return;
  quiz.active = false;
  setGroupPermission(true);
  bot.sendMessage(GROUP_ID, "🛑 Quiz has been stopped by Admin.");
});

/* ===================== DELETE ===================== */
bot.onText(/\/delete (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const key = match[1].trim();
  delete sessions[key];
  schedules = schedules.filter(s => s.session !== key);
  safeWrite("sessions.json", sessions);
  safeWrite("schedule.json", schedules);
  bot.sendMessage(msg.chat.id, `🗑 Deleted session: ${key}`);
});

/* ===================== SCHEDULER ===================== */
setInterval(() => {
  const now = Date.now();
  schedules.forEach(s => {
    if (s.started) return;

    // 5 Minute Notification
    if (!s.notified && now >= s.startAt - 5 * 60 * 1000) {
      s.notified = true;
      bot.sendMessage(CHANNEL_ID, `🔔 *Upcoming Quiz!* \n\nSession: ${s.session}\nStarts in 5 minutes!`, { parse_mode: "Markdown" });
    }

    // Start Quiz
    if (now >= s.startAt) {
      s.started = true;
      startQuiz(s.session);
    }
  });
}, 10000);

/* ===================== QUIZ ENGINE ===================== */
function startQuiz(sessionKey) {
  if (!sessions[sessionKey]) return;
  
  quiz = {
    active: true,
    session: sessionKey,
    index: 0,
    pollMap: {},
    scores: {},
    users: {},
    answered: {}
  };

  setGroupPermission(false);
  bot.sendMessage(GROUP_ID, `🚀 *QUIZ STARTED!* \nTopic: ${sessionKey}\nGet ready!`, { parse_mode: "Markdown" });
  setTimeout(sendNext, 5000);
}

function sendNext() {
  if (!quiz.active) return;

  const currentQuestions = sessions[quiz.session];
  if (!currentQuestions || quiz.index >= currentQuestions.length) {
    return setTimeout(showLeaderboard, 2000);
  }

  const q = currentQuestions[quiz.index];
  bot.sendPoll(GROUP_ID, `Q${quiz.index + 1}: ${q.question}`, q.options, {
    type: "quiz",
    correct_option_id: q.correct,
    is_anonymous: false,
    open_period: 25 // 25 seconds to answer
  }).then(p => {
    quiz.pollMap[p.poll.id] = { correct: q.correct, index: quiz.index };
    quiz.index++;
    // Wait for poll to close + small buffer before next question
    setTimeout(sendNext, 30000); 
  }).catch(console.error);
}

/* ===================== RESULTS ===================== */
bot.on("poll_answer", a => {
  if (!quiz.active) return;
  const data = quiz.pollMap[a.poll_id];
  if (!data) return;

  const uid = a.user.id;
  quiz.users[uid] = a.user.first_name;
  
  if (a.option_ids[0] === data.correct) {
    quiz.scores[uid] = (quiz.scores[uid] || 0) + 1;
  }
});

function showLeaderboard() {
  quiz.active = false;
  setGroupPermission(true);

  const total = sessions[quiz.session]?.length || 0;
  let board = `🏆 *QUIZ RESULTS: ${quiz.session}*\n\n`;

  const sorted = Object.keys(quiz.users)
    .map(id => ({ name: quiz.users[id], score: quiz.scores[id] || 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10); // Top 10

  if (sorted.length === 0) board += "No participants.";
  else sorted.forEach((u, i) => { board += `${i + 1}. ${u.name} — ${u.score}/${total}\n`; });

  bot.sendMessage(GROUP_ID, board, { parse_mode: "Markdown" });

  // Cleanup
  delete sessions[quiz.session];
  schedules = schedules.filter(s => s.session !== quiz.session);
  safeWrite("sessions.json", sessions);
  safeWrite("schedule.json", schedules);
}

/* ===================== ERROR HANDLING ===================== */
process.on("unhandledRejection", (re) => console.error("Rejection:", re));
process.on("uncaughtException", (ex) => console.error("Exception:", ex));