require("dotenv").config();
const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");

/* ================= ENV ================= */
const {
  BOT_TOKEN,
  ADMIN_IDS,
  QUIZ_GROUP_ID,
  QUIZ_CHANNEL_ID,
  GROUP_INVITE_LINK
} = process.env;

if (!BOT_TOKEN || !ADMIN_IDS || !QUIZ_GROUP_ID || !QUIZ_CHANNEL_ID || !GROUP_INVITE_LINK) {
  console.error("❌ Missing ENV values");
  process.exit(1);
}

const ADMINS = ADMIN_IDS.split(",").map(Number);
const GROUP_ID = Number(QUIZ_GROUP_ID);
const CHANNEL_ID = Number(QUIZ_CHANNEL_ID);

/* ================= BOT ================= */
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("🤖 Quiz Bot Running (POLLING MODE)");

/* ================= HELPERS ================= */
const read = (f, d) => {
  try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : d; }
  catch { return d; }
};
const write = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));
const isAdmin = id => ADMINS.includes(id);
const IST = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000);

const setGroup = canTalk => {
  bot.setChatPermissions(GROUP_ID, {
    can_send_messages: canTalk,
    can_send_media_messages: canTalk,
    can_send_other_messages: canTalk
  }).catch(()=>{});
};

/* ================= DATA ================= */
let sessions = read("sessions.json", {});
let schedules = read("schedule.json", []);

let quiz = {
  active:false, session:null, index:0,
  pollMap:{}, scores:{}, users:{}, answered:{}
};

/* ================= BASIC ================= */
bot.onText(/\/start/, m =>
  bot.sendMessage(m.chat.id,"👋 Quiz Bot Active")
);

/* ================= ADMIN ================= */
bot.onText(/\/admin/, m => {
  if (!isAdmin(m.from.id)) return;
  bot.sendMessage(m.chat.id,
`🛠 Admin Commands
/status
/stop
/deleteschedule SESSION_KEY`
);
});

/* ================= DELETE ================= */
bot.onText(/\/deleteschedule (.+)/, (m, match) => {
  if (!isAdmin(m.from.id)) return;
  const key = match[1].trim();

  schedules = schedules.filter(s => s.session !== key);
  delete sessions[key];

  write("schedule.json", schedules);
  write("sessions.json", sessions);

  bot.sendMessage(m.chat.id, `✅ Deleted: ${key}`);
});

/* ================= STOP ================= */
bot.onText(/\/stop/, m => {
  if (!isAdmin(m.from.id)) return;
  if (!quiz.active) return bot.sendMessage(m.chat.id,"❌ No active quiz");

  quiz.active = false;
  setGroup(true);
  bot.sendMessage(GROUP_ID,"⛔ Quiz stopped by admin");
});

/* ================= PARSER ================= */
bot.on("message", m => {
  if (!isAdmin(m.from.id) || m.chat.type !== "private") return;
  if (!m.text || m.text.startsWith("/")) return;

  const lines = m.text.split("\n");
  let date, session, time, buf=[];

  const flush = () => {
    if (!date || !session || !time || !buf.length) return;
    const key = `${date}_${session}`;
    sessions[key]=[];

    buf.join("\n").split(/\n\s*\n/).forEach(b=>{
      let q="", o=[], a="";
      b.split("\n").forEach(l=>{
        l=l.trim();
        if(/^Q/.test(l)) q=l.replace(/^Q\d*\.\s*/,"");
        if(/^[A-D]\)/.test(l)) o.push(l.slice(2));
        if(l.startsWith("ANS:")) a=l.replace("ANS:","").trim();
      });
      if(q&&o.length===4&&a)
        sessions[key].push({question:q,options:o,correct:a.charCodeAt(0)-65});
    });

    schedules.push({
      session:key, date, time,
      discussion:false, notice:false, started:false
    });
    buf=[];
  };

  lines.forEach(l=>{
    l=l.trim();
    if(l.startsWith("DATE:")){ flush(); date=l.replace("DATE:","").trim(); }
    else if(l.startsWith("SESSION:")){ flush(); session=l.replace("SESSION:","").trim(); }
    else if(l.startsWith("TIME:")) time=l.replace("TIME:","").trim();
    else buf.push(l);
  });

  flush();
  write("sessions.json",sessions);
  write("schedule.json",schedules);
  bot.sendMessage(m.chat.id,"✅ Quiz saved");
});

/* ================= SCHEDULER ================= */
setInterval(()=>{
  const now = IST();

  schedules.forEach(s=>{
    if(s.started) return;

    const [h,m]=s.time.split(":").map(Number);
    const t=new Date(s.date);
    t.setHours(h,m,0,0);

    const diff = t-now;

    if(!s.discussion && diff<=30*60*1000 && diff>0){
      s.discussion=true;
      setGroup(true);
      bot.sendMessage(GROUP_ID,"💬 Discussion opened");
    }

    if(!s.notice && diff<=5*60*1000 && diff>0){
      s.notice=true;
      bot.sendMessage(CHANNEL_ID,
`🚨 Quiz Alert
📘 ${s.session}
⏳ Starts in 5 min`,
{ reply_markup:{ inline_keyboard:[[{
  text:"🚀 Join Quiz Group", url:GROUP_INVITE_LINK
}]]}}
);
    }

    if(diff<=0 && diff>-60000){
      s.started=true;
      startQuiz(s.session);
    }
  });

  write("schedule.json",schedules);
},15000);

/* ================= QUIZ ================= */
function startQuiz(session){
  quiz={active:true,session,index:0,pollMap:{},scores:{},users:{},answered:{}};
  setGroup(false);
  bot.sendMessage(GROUP_ID,`🟢 Quiz Started`);
  sendNext();
}

function sendNext(){
  if(!quiz.active) return;
  const q=sessions[quiz.session]?.[quiz.index];
  if(!q) return setTimeout(endQuiz,3000);

  const idx=quiz.index;
  bot.sendPoll(GROUP_ID,`Q${idx+1}. ${q.question}`,q.options,{
    type:"quiz",correct_option_id:q.correct,is_anonymous:false,open_period:20
  }).then(p=>{
    quiz.pollMap[p.poll.id]={correct:q.correct,index:idx};
    quiz.index++; setTimeout(sendNext,25000);
  });
}

bot.on("poll_answer",a=>{
  if(!quiz.active) return;
  const m=quiz.pollMap[a.poll_id]; if(!m) return;
  const u=a.user.id;
  quiz.users[u]=a.user.first_name;
  quiz.answered[u]??={};
  if(quiz.answered[u][m.index]) return;
  quiz.answered[u][m.index]=true;
  if(a.option_ids[0]===m.correct)
    quiz.scores[u]=(quiz.scores[u]||0)+1;
});

function endQuiz(){
  setGroup(true);
  let t="🏆 Leaderboard\n\n";
  Object.keys(quiz.users)
    .map(i=>({n:quiz.users[i],s:quiz.scores[i]||0}))
    .sort((a,b)=>b.s-a.s)
    .forEach((u,i)=>t+=`${i+1}. ${u.n} — ${u.s}\n`);
  bot.sendMessage(GROUP_ID,t);

  setTimeout(()=>setGroup(false),15*60*1000);
  delete sessions[quiz.session];
  schedules=schedules.filter(s=>s.session!==quiz.session);
  write("sessions.json",sessions);
  write("schedule.json",schedules);
}

/* ================= SAFETY ================= */
process.on("unhandledRejection",console.error);
process.on("uncaughtException",console.error);
