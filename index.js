require("dotenv").config();
const fs = require("fs");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

// ================= BASIC APP =================
const app = express();
app.use(express.json());

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS.split(",").map(Number);
const GROUP_ID = Number(process.env.QUIZ_GROUP_ID);
const CHANNEL_ID = Number(process.env.QUIZ_CHANNEL_ID);
const GROUP_LINK = process.env.GROUP_INVITE_LINK;
const APP_URL = process.env.APP_URL;

if (!BOT_TOKEN || !GROUP_ID || !CHANNEL_ID || !GROUP_LINK || !APP_URL) {
  console.error("❌ Missing ENV values");
  process.exit(1);
}

// ================= BOT (WEBHOOK ONLY) =================
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

bot.setWebHook(`${APP_URL}/bot${BOT_TOKEN}`);

app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 Webhook server running on", PORT)
);

console.log("🤖 Quiz Bot Running (Webhook Mode)");

// ================= FILE HELPERS =================
const readJSON = (f, d) => {
  try {
    if (!fs.existsSync(f)) return d;
    return JSON.parse(fs.readFileSync(f));
  } catch {
    return d;
  }
};

const writeJSON = (f, d) =>
  fs.writeFileSync(f, JSON.stringify(d, null, 2));

// ================= DATA =================
let sessions = readJSON("sessions.json", {});
let schedules = readJSON("schedule.json", []);

let quiz = {
  session: null,
  index: 0,
  pollMap: {},
  scores: {},
  users: {},
  answered: {},
  active: false
};

// ================= HELPERS =================
const isAdmin = id => ADMIN_IDS.includes(id);

const setGroupPermission = canTalk => {
  bot.setChatPermissions(GROUP_ID, {
    can_send_messages: canTalk,
    can_send_media_messages: canTalk,
    can_send_other_messages: canTalk,
    can_add_web_page_previews: canTalk
  }).catch(() => {});
};

// ================= START =================
bot.onText(/\/start/, msg => {
  bot.sendMessage(
    msg.chat.id,
`👋 Welcome ${msg.from.first_name}

🧠 Quiz → Group
📢 Notices → Channel
⚙️ Admin Controlled`
  );
});

// ================= ADMIN =================
bot.onText(/\/admin/, msg => {
  if (!isAdmin(msg.from.id)) return;
  bot.sendMessage(
    msg.chat.id,
`🛠 Admin Panel

/status
/deleteschedule SESSION_NAME

📥 Send quiz data in ONE message`
  );
});

// ================= SMART PARSER =================
bot.on("message", msg => {
  if (!isAdmin(msg.from.id)) return;
  if (msg.chat.type !== "private") return;
  if (!msg.text || msg.text.startsWith("/")) return;

  const lines = msg.text.split("\n");
  let currentDate = null;
  let currentSession = null;
  let currentTime = null;
  let buffer = [];

  const flush = () => {
    if (!currentDate || !currentSession || !currentTime || !buffer.length) return;

    const key = `${currentDate}_${currentSession}`;
    sessions[key] = [];

    buffer.join("\n").split(/\n\s*\n/).forEach(b => {
      let q="", o=[], a="";
      b.split("\n").forEach(l => {
        l = l.trim();
        if (/^Q/.test(l)) q = l.replace(/^Q\d*\.\s*/, "");
        if (/^[A-D]\)/.test(l)) o.push(l.slice(2).trim());
        if (l.startsWith("ANS:")) a = l.replace("ANS:", "").trim();
      });

      if (q && o.length === 4 && a) {
        sessions[key].push({
          question: q,
          options: o,
          correct: a.charCodeAt(0) - 65
        });
      }
    });

    schedules.push({
      session: key,
      date: currentDate,
      time: currentTime,
      notice: false,
      discussion: false,
      started: false
    });

    buffer = [];
  };

  lines.forEach(line => {
    line = line.trim();
    if (line.startsWith("DATE:")) {
      flush();
      currentDate = line.replace("DATE:", "").trim().split("-").reverse().join("-");
    } else if (line.startsWith("SESSION:")) {
      flush();
      currentSession = line.replace("SESSION:", "").trim();
    } else if (line.startsWith("TIME:")) {
      currentTime = line.replace("TIME:", "").trim();
    } else buffer.push(line);
  });

  flush();
  writeJSON("sessions.json", sessions);
  writeJSON("schedule.json", schedules);

  bot.sendMessage(msg.chat.id, "✅ Sessions & schedules saved");
});

// ================= STATUS =================
bot.onText(/\/status/, msg => {
  if (!isAdmin(msg.from.id)) return;

  let text = `📊 *Bot Status*\n\n📘 Sessions:\n`;
  Object.keys(sessions).forEach((k,i)=>{
    text += `${i+1}. ${k} (${sessions[k].length}Q)\n`;
  });

  text += `\n⏰ Schedules:\n`;
  schedules.forEach((s,i)=>{
    text += `${i+1}. ${s.session} — ${s.date} ${s.time}\n`;
  });

  bot.sendMessage(msg.chat.id, text, { parse_mode:"Markdown" });
});

// ================= SCHEDULER (MISS-PROOF) =================
setInterval(() => {
  const now = new Date();

  schedules.forEach(s => {
    if (s.started) return;

    const [h, m] = s.time.split(":").map(Number);
    const t = new Date(s.date);
    t.setHours(h, m, 0, 0);

    const diff = t - now;

    if (!s.discussion && diff <= 30*60*1000 && diff > 0) {
      s.discussion = true;
      setGroupPermission(true);
      bot.sendMessage(GROUP_ID, "💬 Discussion opened (30 min before quiz)");
    }

    if (!s.notice && diff <= 5*60*1000 && diff > 0) {
      s.notice = true;
      bot.sendMessage(
        CHANNEL_ID,
`🚨 *Quiz Alert*
📘 ${s.session}
⏳ Starts in 5 minutes`,
{
  parse_mode:"Markdown",
  reply_markup:{
    inline_keyboard:[[{ text:"🚀 Join Quiz Group", url: GROUP_LINK }]]
  }
});
    }

    // 🔒 Grace window (2 min)
    if (diff <= 60*1000 && diff >= -120*1000) {
      s.started = true;
      startQuiz(s.session);
    }
  });

  writeJSON("schedule.json", schedules);
}, 15000);

// ================= QUIZ =================
function startQuiz(session) {
  quiz = {
    session,
    index: 0,
    pollMap: {},
    scores: {},
    users: {},
    answered: {},
    active: true
  };

  setGroupPermission(false);
  bot.sendMessage(GROUP_ID, `🟢 Quiz Started: ${session}`);
  sendNext();
}

function sendNext() {
  if (!quiz.active) return;

  const q = sessions[quiz.session]?.[quiz.index];
  if (!q) return setTimeout(showLeaderboard, 3000);

  const idx = quiz.index;

  bot.sendPoll(
    GROUP_ID,
    `Q${idx+1}. ${q.question}`,
    q.options,
    {
      type:"quiz",
      correct_option_id:q.correct,
      is_anonymous:false,
      open_period:20
    }
  ).then(p => {
    quiz.pollMap[p.poll.id] = { correct:q.correct, index:idx };
    quiz.index++;
    setTimeout(sendNext, 25000);
  });
}

// ================= SCORE (FIXED) =================
bot.on("poll_answer", a => {
  if (!quiz.active) return;

  const map = quiz.pollMap[a.poll_id];
  if (!map) return;

  const uid = a.user.id;
  quiz.users[uid] = a.user.first_name || "User";
  quiz.answered[uid] ??= new Set();

  if (quiz.answered[uid].has(map.index)) return;
  quiz.answered[uid].add(map.index);

  if (a.option_ids[0] === map.correct) {
    quiz.scores[uid] = (quiz.scores[uid] || 0) + 1;
  }
});

function showLeaderboard() {
  setGroupPermission(true);
  const total = sessions[quiz.session]?.length || 0;

  let text = "🏆 *Leaderboard*\n\n";
  Object.keys(quiz.users)
    .map(id => ({ name:quiz.users[id], score:quiz.scores[id]||0 }))
    .sort((a,b)=>b.score-a.score)
    .forEach((u,i)=>{
      text += `${i+1}. *${u.name}* — ${u.score}/${total}\n`;
    });

  bot.sendMessage(GROUP_ID, text, { parse_mode:"Markdown" });
  bot.sendMessage(GROUP_ID, "💬 Discussion opened (15 min)");

  delete sessions[quiz.session];
  schedules = schedules.filter(s=>s.session!==quiz.session);
  writeJSON("sessions.json", sessions);
  writeJSON("schedule.json", schedules);

  setTimeout(()=>{
    setGroupPermission(false);
    bot.sendMessage(GROUP_ID, "🔒 Discussion closed");
  }, 15*60*1000);
}

// ================= SAFETY =================
process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);
