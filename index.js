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

if (!BOT_TOKEN || !ADMIN_IDS || !QUIZ_GROUP_ID || !QUIZ_CHANNEL_ID || !GROUP_INVITE_LINK) {
  console.error("❌ Missing ENV values");
  process.exit(1);
}

const ADMINS = ADMIN_IDS.split(",").map(Number);
const GROUP_ID = Number(QUIZ_GROUP_ID);
const CHANNEL_ID = Number(QUIZ_CHANNEL_ID);

/* ===================== BOT ===================== */
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("🤖 Quiz Bot Running (Polling Mode)");

/* ===================== FILE HELPERS ===================== */
const read = (f, d) => {
  try { return JSON.parse(fs.readFileSync(f)); }
  catch { return d; }
};
const write = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

let sessions = read("sessions.json", {});
let schedules = read("schedule.json", []);

/* ===================== QUIZ STATE ===================== */
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

const getTimestamp = (date, time) => {
  const [y,m,d] = date.split("-").map(Number);
  const [hh,mm] = time.split(":").map(Number);
  return new Date(y, m-1, d, hh, mm, 0, 0).getTime();
};

/* ===================== BASIC ===================== */
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, "👋 Welcome to Quiz Bot");
});

bot.onText(/\/admin/, msg => {
  if (!isAdmin(msg.from.id)) return;
  bot.sendMessage(msg.chat.id,
`🛠 Admin Commands
/status
/stop
/deleteschedule SESSION_NAME`);
});

/* ===================== QUIZ PARSER ===================== */
bot.on("message", msg => {
  if (!isAdmin(msg.from.id) || msg.chat.type !== "private") return;
  if (!msg.text || msg.text.startsWith("/")) return;

  const lines = msg.text.split("\n");
  let date=null, session=null, time=null, buf=[];

  const flush = () => {
    if (!date || !session || !time || !buf.length) return;

    const key = `${date}_${session}`;
    sessions[key] = [];

    buf.join("\n").split(/\n\s*\n/).forEach(b=>{
      let q="", o=[], a="";
      b.split("\n").forEach(l=>{
        l=l.trim();
        if(/^Q/.test(l)) q=l.replace(/^Q\d*\.\s*/,"");
        if(/^[A-D]\)/.test(l)) o.push(l.slice(2).trim());
        if(l.startsWith("ANS:")) a=l.replace("ANS:","").trim();
      });
      if(q && o.length===4 && a){
        sessions[key].push({
          question:q,
          options:o,
          correct:a.charCodeAt(0)-65
        });
      }
    });

    schedules.push({
      session:key,
      date,
      time,
      discussion:false,
      notice:false,
      started:false,
      ended:false
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
  bot.sendMessage(msg.chat.id,"✅ Quiz saved");
});

/* ===================== STATUS ===================== */
bot.onText(/\/status/, msg=>{
  if(!isAdmin(msg.from.id)) return;
  let t="📊 Status\n\n";
  schedules.forEach(s=>{
    t+=`${s.session} | ${s.date} ${s.time}\n`;
  });
  bot.sendMessage(msg.chat.id,t);
});

/* ===================== DELETE ===================== */
bot.onText(/\/deleteschedule (.+)/, msg=>{
  if(!isAdmin(msg.from.id)) return;
  const name=msg.match[1];

  schedules = schedules.filter(s=>s.session!==name);
  delete sessions[name];

  write("schedule.json",schedules);
  write("sessions.json",sessions);

  bot.sendMessage(msg.chat.id,`🗑 Deleted: ${name}`);
});

/* ===================== STOP ===================== */
bot.onText(/\/stop/, msg=>{
  if(!isAdmin(msg.from.id)) return;
  quiz.active=false;
  setGroupPermission(true);
  bot.sendMessage(GROUP_ID,"⛔ Quiz stopped by admin");
});

/* ===================== SCHEDULER ===================== */
setInterval(()=>{
  const now=Date.now();

  schedules.forEach(s=>{
    if(s.ended) return;

    const startTS=getTimestamp(s.date,s.time);

    if(!s.discussion && now >= startTS-30*60*1000){
      s.discussion=true;
      setGroupPermission(true);
      bot.sendMessage(GROUP_ID,"💬 Discussion opened");
    }

    if(!s.notice && now >= startTS-5*60*1000){
      s.notice=true;
      bot.sendMessage(CHANNEL_ID,
`🚨 Quiz Alert
📘 ${s.session}
⏳ Starts in 5 minutes`,
{ reply_markup:{ inline_keyboard:[
  [{text:"🚀 Join Quiz Group",url:GROUP_INVITE_LINK}]
]}});
    }

    if(!s.started && now >= startTS){
      s.started=true;
      startQuiz(s.session);
    }
  });

  write("schedule.json",schedules);
},10000);

/* ===================== QUIZ ===================== */
function startQuiz(session){
  quiz={ active:true, session, index:0, pollMap:{}, scores:{}, users:{}, answered:{} };
  setGroupPermission(false);
  bot.sendMessage(GROUP_ID,`🟢 Quiz Started: ${session}`);
  sendNext();
}

function sendNext(){
  if(!quiz.active) return;
  const q=sessions[quiz.session]?.[quiz.index];
  if(!q) return endQuiz();

  const idx=quiz.index;
  bot.sendPoll(GROUP_ID,`Q${idx+1}. ${q.question}`,q.options,{
    type:"quiz",correct_option_id:q.correct,is_anonymous:false,open_period:20
  }).then(p=>{
    quiz.pollMap[p.poll.id]={correct:q.correct,index:idx};
    quiz.index++;
    setTimeout(sendNext,25000);
  });
}

bot.on("poll_answer",a=>{
  if(!quiz.active) return;
  const m=quiz.pollMap[a.poll_id];
  if(!m) return;
  const u=a.user.id;
  quiz.users[u]=a.user.first_name;
  quiz.answered[u]??={};
  if(quiz.answered[u][m.index]) return;
  quiz.answered[u][m.index]=true;
  if(a.option_ids[0]===m.correct)
    quiz.scores[u]=(quiz.scores[u]||0)+1;
});

function endQuiz(){
  setGroupPermission(true);
  let t="🏆 Leaderboard\n\n";
  Object.keys(quiz.users)
    .map(id=>({n:quiz.users[id],s:quiz.scores[id]||0}))
    .sort((a,b)=>b.s-a.s)
    .forEach((u,i)=>t+=`${i+1}. ${u.n} — ${u.s}\n`);
  bot.sendMessage(GROUP_ID,t);
  quiz.active=false;
}
