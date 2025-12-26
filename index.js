require("dotenv").config();
const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");
const schedule = require("node-schedule");

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
  rocket: "🚀", admin: "🛠", stop: "🛑", megaphone: "📢", stats: "📊",
  star: "🌟", fire: "🔥", badge: "🎖", crown: "👑"
};

/* ===================== DATA PERSISTENCE ===================== */
const safeRead = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const safeWrite = (f, d) => { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch (e) { console.error(e); } };

let sessions = safeRead("sessions.json", {});
let schedules = safeRead("schedule.json", []);
let userStats = safeRead("stats.json", {});
let weeklyStats = safeRead("weekly_stats.json", {});

let quiz = { active: false, session: null, index: 0, pollMap: {}, scores: {}, users: {}, timer: null };

/* ===================== GAMIFICATION HELPERS ===================== */
const getBadge = (xp) => {
    if (xp >= 5000) return "🏆 Legend";
    if (xp >= 2000) return "🥇 Master";
    if (xp >= 1000) return "🥈 Scholar";
    if (xp >= 500) return "🥉 Warrior";
    return "👶 Beginner";
};

const getProgressBar = (xp) => {
    const progress = Math.floor(((xp % 500) / 500) * 10);
    return "█".repeat(progress) + "░".repeat(10 - progress);
};

const formatIST = (dateObj) => {
  return dateObj.toLocaleString('en-IN', { 
    timeZone: 'Asia/Kolkata', hour12: true, timeStyle: 'short', dateStyle: 'medium' 
  });
};

const setGroupMute = async (mute) => {
  try {
    await bot.setChatPermissions(GROUP_ID, { can_send_messages: !mute });
  } catch (e) { console.error("Permission Error:", e.message); }
};

/* ===================== USER COMMANDS ===================== */

bot.onText(/\/start/, (msg) => {
  const welcome = `<b>👋 Hello ${msg.from.first_name}!</b>\n\n` +
    `${icons.megaphone} <b>Channel:</b> <a href="${GROUP_INVITE_LINK}">Join Here</a>\n\n` +
    `${icons.stats} <b>User Commands:</b>\n` +
    `• <code>/profile</code> - Your Level, XP & Badges\n` +
    `• <code>/mytop</code> - Lifetime stats summary\n\n` +
    `<i>Quizzes start automatically as per schedule!</i>`;
  bot.sendMessage(msg.chat.id, welcome, { parse_mode: "HTML", disable_web_page_preview: true });
});

bot.onText(/\/profile/, (msg) => {
    const uid = msg.from.id;
    const stats = userStats[uid];
    if (!stats) return bot.sendMessage(msg.chat.id, "❌ Apne abhi tak koi quiz nahi khela hai!");

    const xp = stats.xp || 0;
    const level = Math.floor(xp / 500) + 1;
    const badge = getBadge(xp);
    const pBar = getProgressBar(xp);

    let subText = "";
    if (stats.subjects) {
        Object.entries(stats.subjects).forEach(([s, v]) => subText += `  ├ ${s}: <b>${v} pts</b>\n`);
    }

    const profile = `<b>👤 USER PROGRESS CARD</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Name:</b> ${msg.from.first_name}\n` +
        `🎖 <b>Badge:</b> ${badge}\n` +
        `🆙 <b>Level:</b> ${level}\n` +
        `✨ <b>XP Progress:</b>\n` +
        `<code>[${pBar}]</code> ${xp} XP\n\n` +
        `<b>📊 Subject Performance:</b>\n${subText || "  └ No data yet"}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💰 <b>Points:</b> ${Math.floor(xp / 10)}`;

    bot.sendMessage(msg.chat.id, profile, { parse_mode: "HTML" });
});

bot.onText(/\/mytop/, (msg) => {
  const uid = msg.from.id;
  const stats = userStats[uid] || { played: 0, correct: 0 };
  const avg = stats.played > 0 ? (stats.correct / stats.played).toFixed(1) : 0;

  const text = `<b>${icons.stats} QUICK PERFORMANCE</b>\n\n` +
    `📝 <b>Total Played:</b> ${stats.played}\n` +
    `✅ <b>Total Correct:</b> ${stats.correct}\n` +
    `📈 <b>Average:</b> ${avg} per quiz`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

/* ===================== ADMIN COMMANDS ===================== */

bot.onText(/\/dashboard/, async (msg) => {
    if (!ADMINS.includes(msg.from.id)) return;
    const totalUsers = Object.keys(userStats).length;
    let memberCount = "N/A";
    try { memberCount = await bot.getChatMemberCount(GROUP_ID); } catch(e){}

    const dashText = `<b>${icons.admin} ADMIN DASHBOARD</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👥 <b>Total Users:</b> ${totalUsers}\n` +
        `📈 <b>Group Members:</b> ${memberCount}\n` +
        `📝 <b>Saved Sessions:</b> ${Object.keys(sessions).length}\n` +
        `⏰ <b>Scheduled:</b> ${schedules.filter(s=>!s.started).length}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📢 <i>Use /announce [text] for broadcast</i>`;
    bot.sendMessage(msg.chat.id, dashText, { parse_mode: "HTML" });
});

bot.onText(/\/announce (.+)/, async (msg, match) => {
    if (!ADMINS.includes(msg.from.id)) return;
    const announcement = `<b>${icons.megaphone} ANNOUNCEMENT</b>\n\n${match[1]}`;
    await bot.sendMessage(GROUP_ID, announcement, { parse_mode: "HTML" }).catch(()=>{});
    await bot.sendMessage(CHANNEL_ID, announcement, { parse_mode: "HTML" }).catch(()=>{});
    bot.sendMessage(msg.chat.id, "✅ Broadcast Sent!");
});

bot.onText(/\/status/, (msg) => {
  if (!ADMINS.includes(msg.from.id)) return;
  let t = `<b>${icons.clock} PENDING QUIZZES</b>\n\n`;
  const pending = schedules.filter(s => !s.started);
  if (pending.length === 0) t += "No quizzes scheduled.";
  pending.forEach((s, i) => {
    t += `${i + 1}. <code>${s.session}</code>\n   IST: ${formatIST(new Date(s.startAt))}\n\n`;
  });
  bot.sendMessage(msg.chat.id, t, { parse_mode: "HTML" });
});

bot.onText(/\/stop/, async (msg) => {
  if (!ADMINS.includes(msg.from.id)) return;
  quiz.active = false; clearTimeout(quiz.timer); await setGroupMute(false);
  bot.sendMessage(GROUP_ID, `🛑 <b>Quiz stopped by Admin.</b>`, { parse_mode: "HTML" });
});

/* ===================== QUIZ PARSER (PRIVATE CHAT) ===================== */

bot.on("message", (msg) => {
  if (!ADMINS.includes(msg.from.id) || msg.chat.type !== "private" || !msg.text || msg.text.startsWith("/")) return;

  const lines = msg.text.split("\n");
  let dateText, sessionName, timeText, buf = [];

  const processBlock = () => {
    if (!dateText || !sessionName || !timeText || !buf.length) return;
    const [d, m, y] = dateText.split("-");
    const [hh, mm] = timeText.split(":");
    const startTime = new Date(`${y}-${m}-${d}T${hh}:${mm}:00+05:30`).getTime();
    if (isNaN(startTime)) return;

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
      bot.sendMessage(msg.chat.id, `${icons.success} <b>Scheduled:</b> ${key}\n⏰ ${formatIST(new Date(startTime))}`, { parse_mode: "HTML" });
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

/* ===================== SCHEDULER & ENGINE ===================== */

setInterval(() => {
  const now = Date.now();
  schedules.forEach(async (s) => {
    if (s.started) return;
    if (!s.notified && now >= s.startAt - 10 * 60 * 1000) {
      s.notified = true;
      bot.sendMessage(CHANNEL_ID, `<b>${icons.clock} QUIZ ALERT</b>\n━━━━━━━━━━━━━━━━━━━━\n📝 <b>Topic:</b> ${s.session}\n⏰ <b>In 10 Minutes!</b>\n━━━━━━━━━━━━━━━━━━━━`, { 
          parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🚀 Join Group", url: GROUP_INVITE_LINK }]] }
      });
    }
    if (now >= s.startAt) { s.started = true; startQuiz(s.session); }
  });
}, 10000);

async function startQuiz(key) {
  if (quiz.active || !sessions[key]) return;
  quiz = { active: true, session: key, index: 0, pollMap: {}, scores: {}, users: {}, timer: null };
  await setGroupMute(true);
  await bot.sendMessage(GROUP_ID, `<b>${icons.rocket} QUIZ STARTED!</b>\n🏷 <b>Topic:</b> <code>${key}</code>\n❓ <b>Total Questions:</b> ${sessions[key].length}`, { parse_mode: "HTML" });
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
    quiz.timer = setTimeout(sendNext, 35000);
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
  const subject = sessionKey.split('_')[1] || "General";

  let board = `<b>${icons.trophy} QUIZ COMPLETED!</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  const sorted = Object.entries(quiz.scores).sort(([, a], [, b]) => b - a).slice(0, 10);

  sorted.forEach(([id, score], i) => {
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "🔹";
      board += `${medal} <b>${quiz.users[id]}</b>: ${score}/${total}\n`;
      
      // Update Detailed Stats
      if (!userStats[id]) userStats[id] = { played: 0, correct: 0, xp: 0, subjects: {}, name: "" };
      userStats[id].played++;
      userStats[id].correct += score;
      userStats[id].xp = (userStats[id].xp || 0) + (score * 10);
      userStats[id].name = quiz.users[id];
      if(!userStats[id].subjects) userStats[id].subjects = {};
      userStats[id].subjects[subject] = (userStats[id].subjects[subject] || 0) + score;

      // Update Weekly
      if (!weeklyStats[id]) weeklyStats[id] = { score: 0, name: "" };
      weeklyStats[id].score += score;
      weeklyStats[id].name = quiz.users[id];
  });

  const summary = `\n━━━━━━━━━━━━━━━━━━━━\n👥 <b>Active Players:</b> ${Object.keys(quiz.users).length}\n🔥 <b>Top Scorer:</b> ${sorted[0] ? quiz.users[sorted[0][0]] : "N/A"}\n━━━━━━━━━━━━━━━━━━━━`;

  await bot.sendMessage(GROUP_ID, board + summary, { parse_mode: "HTML" });
  await setGroupMute(false);
  
  safeWrite("stats.json", userStats);
  safeWrite("weekly_stats.json", weeklyStats);

  quiz.active = false;
  clearTimeout(quiz.timer);
  delete sessions[sessionKey];
  schedules = schedules.filter(s => s.session !== sessionKey);
  safeWrite("sessions.json", sessions);
  safeWrite("schedule.json", schedules);
}

/* ===================== WEEKLY AUTOMATION (SUNDAY 9PM) ===================== */

schedule.scheduleJob('0 21 * * 0', () => {
    const sorted = Object.entries(weeklyStats).sort(([, a], [, b]) => b.score - a.score).slice(0, 10);
    if (sorted.length === 0) return;
    let hof = `<b>${icons.crown} WEEKLY HALL OF FAME ${icons.crown}</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    sorted.forEach(([id, data], i) => {
        const m = i === 0 ? "👑" : i === 1 ? "🥈" : i === 2 ? "🥉" : "✨";
        hof += `${m} <b>${data.name.toUpperCase()}</b>: ${data.score} pts\n`;
    });
    hof += `\n━━━━━━━━━━━━━━━━━━━━\n<i>Sunday Special: Stats reset for New Week!</i>`;
    bot.sendMessage(CHANNEL_ID, hof, { parse_mode: "HTML" });
    weeklyStats = {}; 
    safeWrite("weekly_stats.json", weeklyStats);
});

process.on("unhandledRejection", (err) => console.log("Critical Error:", err.message));