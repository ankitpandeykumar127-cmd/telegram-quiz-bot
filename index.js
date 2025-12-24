require("dotenv").config();
const fs = require("fs");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

/* ===================== APP ===================== */
const app = express();
app.use(express.json());

/* ===================== ENV ===================== */
const {
  BOT_TOKEN,
  ADMIN_IDS,
  QUIZ_GROUP_ID,
  QUIZ_CHANNEL_ID,
  GROUP_INVITE_LINK,
  APP_URL,
  PORT
} = process.env;

if (
  !BOT_TOKEN ||
  !ADMIN_IDS ||
  !QUIZ_GROUP_ID ||
  !QUIZ_CHANNEL_ID ||
  !GROUP_INVITE_LINK ||
  !APP_URL
) {
  console.error("❌ Missing ENV values");
  process.exit(1);
}

const ADMINS = ADMIN_IDS.split(",").map(Number);
const GROUP_ID = Number(QUIZ_GROUP_ID);
const CHANNEL_ID = Number(QUIZ_CHANNEL_ID);

/* ===================== BOT (WEBHOOK ONLY) ===================== */
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

const WEBHOOK_PATH = `/bot${BOT_TOKEN}`;
const WEBHOOK_URL = `${APP_URL}${WEBHOOK_PATH}`;

bot.setWebHook(WEBHOOK_URL)
  .then(() => console.log("✅ Webhook set:", WEBHOOK_URL))
  .catch(console.error);

app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT || 8080, () =>
  console.log("🚀 Webhook server running")
);

console.log("🤖 Quiz Bot Running (Webhook Mode)");

/* ===================== FILE HELPERS ===================== */
const safeRead = (file, def) => {
  try {
    if (!fs.existsSync(file)) return def;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return def;
  }
};

const safeWrite = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

/* ===================== DATA ===================== */
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

const setGroupPermission = canTalk => {
  bot.setChatPermissions(GROUP_ID, {
    can_send_messages: canTalk,
    can_send_media_messages: canTalk,
    can_send_other_messages: canTalk,
    can_add_web_page_previews: canTalk
  }).catch(() => {});
};

/* ===================== START ===================== */
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id,
`👋 Welcome ${msg.from.first_name}

🧠 Quiz → Group
📢 Notices → Channel
⚙️ Admin Controlled`
  );
});

/* ===================== ADMIN ===================== */
bot.onText(/\/admin/, msg => {
  if (!isAdmin(msg.from.id)) return;
  bot.sendMessage(msg.chat.id,
`🛠 Admin Panel

/status
/deleteschedule SESSION_NAME

📥 Send quiz in ONE message`
  );
});

/* ===================== QUIZ PARSER ===================== */
bot.on("message", msg => {
  if (!isAdmin(msg.from.id)) return;
  if (msg.chat.type !== "private") return;
  if (!msg.text || msg.text.startsWith("/")) return;

  const lines = msg.text.split("\n");
  let date=null, session=null, time=null, buf=[];

  const flush = () => {
    if (!date || !session || !time || !buf.length) return;

    const key = `${date}_${session}`;
    sessions[key] = [];

    buf.join("\n").split(/\n\s*\n/).forEach(b => {
      let q="", o=[], a="";
      b.split("\n").forEach(l => {
        l=l.trim();
        if (/^Q/.test(l)) q=l.replace(/^Q\d*\.\s*/,"");
        if (/^[A-D]\)/.test(l)) o.push(l.slice(2).trim());
        if (l.startsWith("ANS:")) a=l.replace("ANS:","").trim();
      });
      if (q && o.length===4 && a)
        sessions[key].push({
          question:q,
          options:o,
          correct:a.charCodeAt(0)-65
        });
    });

    schedules.push({
      session:key,
      date,
      time,
      notice:false,
      discussion:false,
      started:false
    });

    buf=[];
  };

  lines.forEach(l=>{
    l=l.trim();
    if (l.startsWith("DATE:")) {
      flush();
      date=l.replace("DATE:","").trim().split("-").reverse().join("-");
    }
    else if (l.startsWith("SESSION:")) {
      flush();
      session=l.replace("SESSION:","").trim();
    }
    else if (l.startsWith("TIME:")) time=l.replace("TIME:","").trim();
    else buf.push(l);
  });

  flush();
  safeWrite("sessions.json",sessions);
  safeWrite("schedule.json",schedules);

  bot.sendMessage(msg.chat.id,"✅ Quiz saved successfully");
});

/* ===================== STATUS ===================== */
bot.onText(/\/status/, msg => {
  if (!isAdmin(msg.from.id)) return;

  let t="📊 *Bot Status*\n\n📘 Sessions:\n";
  Object.keys(sessions).forEach((k,i)=>{
    t+=`${i+1}. ${k} (${sessions[k].length}Q)\n`;
  });

  t+="\n⏰ Schedules:\n";
  schedules.forEach((s,i)=>{
    t+=`${i+1}. ${s.session} — ${s.date} ${s.time}\n`;
  });

  bot.sendMessage(msg.chat.id,t,{parse_mode:"Markdown"});
});

/* ===================== SCHEDULER ===================== */
setInterval(()=>{
  const now=new Date();

  schedules.forEach(s=>{
    if (s.started) return;

    const [h,m]=s.time.split(":").map(Number);
    const t=new Date(s.date);
    t.setHours(h,m,0,0);
    const diff=t-now;

    if (!s.discussion && diff<=30*60*1000 && diff>0) {
      s.discussion=true;
      setGroupPermission(true);
      bot.sendMessage(GROUP_ID,"💬 Discussion opened");
    }

    if (!s.notice && diff<=5*60*1000 && diff>0) {
      s.notice=true;
      bot.sendMessage(
        CHANNEL_ID,
`🚨 *Quiz Alert*
📘 ${s.session}
⏳ Starts in 5 minutes`,
{
  parse_mode:"Markdown",
  reply_markup:{
    inline_keyboard:[
      [{text:"🚀 Join Quiz Group",url:GROUP_INVITE_LINK}]
    ]
  }
});
    }

    if (diff<=60*1000 && diff>=-120*1000) {
      s.started=true;
      startQuiz(s.session);
    }
  });

  safeWrite("schedule.json",schedules);
},15000);

/* ===================== QUIZ ===================== */
function startQuiz(session){
  quiz={
    active:true,
    session,
    index:0,
    pollMap:{},
    scores:{},
    users:{},
    answered:{}
  };

  setGroupPermission(false);
  bot.sendMessage(GROUP_ID,`🟢 Quiz Started: ${session}`);
  sendNext();
}

function sendNext(){
  if(!quiz.active) return;
  const q=sessions[quiz.session]?.[quiz.index];
  if(!q) return setTimeout(showLeaderboard,3000);

  const idx=quiz.index;

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
  ).then(p=>{
    quiz.pollMap[p.poll.id]={correct:q.correct,index:idx};
    quiz.index++;
    setTimeout(sendNext,25000);
  });
}

/* ===================== SCORE ===================== */
bot.on("poll_answer",a=>{
  if(!quiz.active) return;
  const map=quiz.pollMap[a.poll_id];
  if(!map) return;

  const uid=a.user.id;
  quiz.users[uid]=a.user.first_name||"User";
  quiz.answered[uid] ??= {};

  if(quiz.answered[uid][map.index]) return;
  quiz.answered[uid][map.index]=true;

  if(a.option_ids[0]===map.correct)
    quiz.scores[uid]=(quiz.scores[uid]||0)+1;
});

function showLeaderboard(){
  setGroupPermission(true);
  const total=sessions[quiz.session]?.length||0;

  let t="🏆 *Leaderboard*\n\n";
  Object.keys(quiz.users)
    .map(id=>({n:quiz.users[id],s:quiz.scores[id]||0}))
    .sort((a,b)=>b.s-a.s)
    .forEach((u,i)=>{
      t+=`${i+1}. *${u.n}* — ${u.s}/${total}\n`;
    });

  bot.sendMessage(GROUP_ID,t,{parse_mode:"Markdown"});
  bot.sendMessage(GROUP_ID,"💬 Discussion opened (15 min)");

  delete sessions[quiz.session];
  schedules=schedules.filter(s=>s.session!==quiz.session);

  safeWrite("sessions.json",sessions);
  safeWrite("schedule.json",schedules);

  setTimeout(()=>{
    setGroupPermission(false);
    bot.sendMessage(GROUP_ID,"🔒 Discussion closed");
  },15*60*1000);
}

/* ===================== SAFETY ===================== */
process.on("unhandledRejection",console.error);
process.on("uncaughtException",console.error);
