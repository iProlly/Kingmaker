import { collection, doc, getFirestore, onSnapshot, query, where } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getDownloadURL, getStorage, ref } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
import { auth } from "./firebase.js";
import { requireUser, setupAccountMenu } from "./protected.js";
const db = getFirestore(auth.app), storage = getStorage(auth.app), $ = id => document.getElementById(id);
const dialog = $("history-dialog");
let user, today = bangkokDate(), week = monday(today), questions = [], answers = new Map(), exams = [], questReady = false, answerReady = false, questError = false, answerError = false, examReady = false, examError = false;
let questStops = [], examStops = [], generation = 0, examGeneration = 0, selection, mathPromise;
const examData = new Map();
const number = v => new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(v);
const round = v => Math.round((v + Number.EPSILON) * 100) / 100;
function node(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }
function button(text, fn, cls = "button button-outline") { const b = node("button", text, cls); b.type = "button"; b.addEventListener("click", fn); return b; }
function bangkokDate() { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()); return ["year", "month", "day"].map(k => parts.find(p => p.type === k).value).join("-"); }
function addDays(day, n) { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function monday(day) { return addDays(day, -(new Date(day + "T12:00:00Z").getUTCDay() + 6) % 7); }
function dateLabel(day, full = false) { return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...(full ? { weekday: "long" } : {}), day: "numeric", month: "short", year: "numeric" }).format(new Date(day + "T12:00:00Z")); }
// Answers are keyed by question ID. Question edits do not reset completion or scores.
function matches(q, a) { return a && a.date === q.date; }
function sameQuestionVersion(q, a) { return matches(q, a) && a.questionRevision === q.revision && a.type === q.type; }
function marked(a) { return a && ["right", "wrong"].includes(a.mark) && a.markedAnswerRevision === a.revision; }
function dailySummary(items) {
  const submitted = items.filter(q => matches(q, answers.get(q.id)));
  const graded = submitted.filter(q => marked(answers.get(q.id)));
  return { submitted: submitted.length, marked: graded.length, right: graded.filter(q => answers.get(q.id).mark === "right").length };
}
function listenWeek() {
  questStops.forEach(stop => stop()); questStops = []; const token = ++generation;
  questions = []; answers.clear(); questReady = answerReady = questError = answerError = false; renderDays();
  const end = addDays(week, 6) < today ? addDays(week, 6) : today;
  const range = [where("date", ">=", week), where("date", "<=", end)];
  questStops.push(onSnapshot(query(collection(db, "dailyQuestQuestions"), ...range), snap => {
    if (token !== generation) return; questions = snap.docs.map(d => ({ ...d.data(), id: d.id })).sort((a,b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0) || a.id.localeCompare(b.id)); questReady = true; renderDays();
  }, () => { if (token === generation) { questError = true; renderDays(); } }));
  questStops.push(onSnapshot(query(collection(db, "users", user.uid, "dailyQuestAnswers"), ...range), snap => {
    if (token !== generation) return; answers = new Map(snap.docs.map(d => [d.id, d.data()])); answerReady = true; renderDays();
  }, () => { if (token === generation) { answerError = true; renderDays(); } }));
}
function renderDays() {
  $("history-title").textContent = `${dateLabel(week)} – ${dateLabel(addDays(week, 6))}`;
  $("history-current").disabled = week === monday(today); $("history-next").disabled = addDays(week, 7) > today;
  $("history-status").textContent = questError || answerError ? "History could not load. Check your connection and try again." : !questReady || !answerReady ? "Loading history…" : "";
  $("history-retry").hidden = !questError && !answerError;
  $("history-days").replaceChildren(...Array.from({length:7}, (_, i) => {
    const day = addDays(week, i), items = questions.filter(q => q.date === day), s = dailySummary(items);
    const row = button("", () => openDay(day), "history-day"); row.disabled = day > today || !questReady || !answerReady || questError || answerError || !items.length;
    const label = node("div"); label.append(node("strong", dateLabel(day, true)), node("span", `${items.length} ${items.length === 1 ? "question" : "questions"}`, "field-hint"));
    const state = day > today ? "Upcoming" : questError || answerError ? "Unavailable" : !questReady || !answerReady ? "Loading…" : !items.length ? "No quest" : s.marked === items.length ? `✓✓ ${s.right}/${items.length}` : s.marked ? `${s.right}/${items.length} · ${s.marked} marked` : s.submitted === items.length ? "✓ Awaiting marking" : `${s.submitted}/${items.length} submitted`;
    row.append(label, node("span", state, "history-day-state")); return row;
  }));
  if (dialog.open && selection?.type === "day") renderDay();
}
function openDay(day) { selection = {type:"day", day}; $("history-dialog-label").textContent = "DAILY QUEST"; $("history-dialog-title").textContent = dateLabel(day, true); $("history-dialog-status").textContent = ""; renderDay(); dialog.showModal(); dialog.scrollTop = 0; loadMath(); }
function renderDay() {
  const content = $("history-dialog-content");
  if (questError || answerError || !questReady || !answerReady) { content.replaceChildren(node("p", "Answers are unavailable. Close and retry loading history.")); return; }
  const items = questions.filter(q => q.date === selection.day), s = dailySummary(items);
  content.replaceChildren(node("div", s.marked ? `Score ${s.right}/${items.length}` : "Not marked yet", "quest-day-score"), node("p", `${s.submitted}/${items.length} submitted · ${s.marked}/${items.length} marked`, "field-hint"));
  items.forEach((q, index) => {
    const a = answers.get(q.id), sameVersion = sameQuestionVersion(q, a), graded = marked(a);
    const article = node("article", undefined, "record-answer"); article.append(node("h3", `Question ${index + 1} · ${q.type === "mcq" ? "Multiple choice" : "Short answer"}`));
    const prompt = node("div", undefined, "quest-rich record-answer-prompt"); richText(prompt, q.prompt); article.append(prompt);
    if (q.type === "mcq") { const options = node("ol", undefined, "record-answer-options"); options.type = "A"; q.options.forEach((value, i) => { const li = node("li", undefined, "quest-rich"); richText(li, value); if (sameVersion && a.choiceIndex === i) { li.classList.add("record-selected-option"); li.append(node("p", "Your choice", "field-hint")); } options.append(li); }); article.append(options); }
    if (a) {
      const box = node("div", undefined, "record-answer-value"); box.append(node("p", "Your submitted answer")); const value = node("div", undefined, "quest-rich");
      const answerText = a.type === "short" ? a.text : sameVersion ? `${String.fromCharCode(65 + a.choiceIndex)}. ${q.options[a.choiceIndex] || ""}` : `Option ${String.fromCharCode(65 + a.choiceIndex)} from the earlier question version`;
      richText(value, answerText || ""); box.append(value); article.append(box);
      if (!sameVersion) article.append(node("p", "This question was updated after your submission. Your submitted answer and any marks still count.", "exam-edit-notice"));
      article.append(node("p", graded ? a.mark === "right" ? "✓ Right · 1 point" : "× Wrong · 0 points" : "Awaiting marking", graded ? `mark-result ${a.mark === "right" ? "mark-right" : "mark-wrong"}` : "field-hint"));
    } else article.append(node("p", "No answer submitted.", "field-hint"));
    content.append(article);
  });
  if (selection.day === today) { const link = node("a", "Go to Today", "button button-outline"); link.href = "main.html"; content.append(link); }
}
function examSummary(exam, result) {
  const parts = exam.questions.filter(q => q.kind === "question"), marks = result?.marks || {};
  const valid = parts.filter(q => typeof marks[q.id] === "number" && Number.isFinite(marks[q.id]) && marks[q.id] >= 0 && marks[q.id] <= q.max);
  return { full:round(parts.reduce((n,q)=>n+q.max,0)), total:round(valid.reduce((n,q)=>n+marks[q.id],0)), count:valid.length, parts:parts.length, review:Boolean(result && result.rubricRevision !== exam.rubricRevision), complete:Boolean(result && result.rubricRevision === exam.rubricRevision && parts.length && valid.length === parts.length) };
}
function listenExams() {
  examStops.forEach(stop => stop()); examStops = []; examData.forEach(s => s.stops.forEach(stop => stop())); examData.clear(); const token = ++examGeneration;
  exams = []; examReady = examError = false; renderExams();
  examStops.push(onSnapshot(query(collection(db, "exams"), where("date", "<=", today)), snap => {
    if (token !== examGeneration) return;
    exams = snap.docs.map(d => ({...d.data(),id:d.id})).sort((a,b) => b.date.localeCompare(a.date) || (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)); examReady = true;
    const ids = new Set(exams.map(e=>e.id)); for (const [id,s] of examData) if (!ids.has(id)) { s.stops.forEach(stop=>stop()); examData.delete(id); }
    exams.forEach(exam => {
      if (examData.has(exam.id)) return;
      const state = {stops:[], ready:false, error:false, statsReady:false, statsError:false}; examData.set(exam.id,state);
      state.stops.push(onSnapshot(doc(db,"exams",exam.id,"results",user.uid), result => { if(token!==examGeneration)return;state.result=result.exists()?result.data():null;state.ready=true;renderExams(); },()=>{if(token!==examGeneration)return;state.error=true;renderExams();}));
      state.stops.push(onSnapshot(doc(db,"examStatistics",exam.id), stat => { if(token!==examGeneration)return;state.stats=stat.exists()?stat.data():null;state.statsReady=true;renderExams(); },()=>{if(token!==examGeneration)return;state.statsError=true;renderExams();}));
    }); renderExams();
  },()=>{if(token!==examGeneration)return;examError=true;renderExams();}));
}
function renderExams() {
  const failed = examError || [...examData.values()].some(s=>s.error||s.statsError);
  $("history-exam-status").textContent = failed ? "Some exam records could not load. Try again." : !examReady ? "Loading exams…" : !exams.length ? "No exams are available yet." : "";
  $("history-exam-retry").hidden = !failed;
  $("history-exams").replaceChildren(...exams.map(exam => {
    const state=examData.get(exam.id), s=examSummary(exam,state?.result), card=button("",()=>openExam(exam.id),"history-exam");
    const title=node("div");title.append(node("h3",exam.name),node("p",[exam.topic,exam.date?dateLabel(exam.date):"Date not set"].filter(Boolean).join(" · "),"field-hint"));
    const label=state?.error?"Score unavailable":!state?.ready?"Loading…":s.review?"Marks under review":s.complete?`${number(s.total)}/${number(s.full)}`:s.count?`${s.count}/${s.parts} parts marked`:"Unmarked";
    card.append(title,node("strong",label,"history-exam-score"));return card;
  }));
  if(dialog.open&&selection?.type==="exam")renderExam();
}
function openExam(id){selection={type:"exam",id};$("history-dialog-label").textContent="EXAM RECORD";$("history-dialog-status").textContent="";$("history-math-status").textContent="";renderExam();dialog.showModal();dialog.scrollTop=0;}
function renderExam(){
  const exam=exams.find(e=>e.id===selection.id), content=$("history-dialog-content");if(!exam){content.replaceChildren(node("p","This exam is no longer available."));return;}
  $("history-dialog-title").textContent=exam.name;const state=examData.get(exam.id),s=examSummary(exam,state?.result);
  content.replaceChildren(node("div",state?.error?"Score unavailable":!state?.ready?"Loading score…":s.review?"Marks under review":s.complete?`Score ${number(s.total)}/${number(s.full)}`:s.count?`Score so far ${number(s.total)}/${number(s.full)}`:"Unmarked","quest-day-score"));
  const dl=node("dl",undefined,"exam-details-grid");for(const [k,v] of [["Topic",exam.topic||"—"],["Date",exam.date?dateLabel(exam.date):"Not set"],["Duration",exam.durationMinutes?`${exam.durationMinutes} minutes`:"Not set"],["Full mark",number(s.full)]]){const group=node("div");group.append(node("dt",k),node("dd",v));dl.append(group);}content.append(dl);
  const stats=state?.stats,validStats=stats&&stats.rubricRevision===exam.rubricRevision;const grid=node("div",undefined,"exam-stat-grid");
  for(const [k,label] of [["max","Maximum"],["min","Minimum"],["mean","Mean"]]){const box=node("div");box.append(node("span",label),node("strong",validStats&&stats.count?number(stats[k]):"—"));grid.append(box);}content.append(grid);
  content.append(node("p",state?.statsError?"Class statistics could not load.":validStats?`Based on ${stats.count} fully marked ${stats.count===1?"record":"records"}. Unmarked records are excluded.`:"Class statistics have not been published for this question structure yet.","field-hint"));
  if(exam.file)content.append(button(`Open exam file · ${exam.file.name}`,event=>openFile(exam.file,event.currentTarget),"button button-outline history-file"));
  if(exam.notes)content.append(node("p",exam.notes,"exam-notes"));
  content.append(node("h3","Your marks by question","exam-small-heading"));
  if(s.review)content.append(node("p","The question structure changed. Your teacher needs to review your marks. Earlier marks are shown for reference; the total is not final.","exam-edit-notice"));
  for(const q of exam.questions){if(q.kind==="heading"){content.append(node("h3",q.label,"exam-rubric-heading"));continue;}const row=node("div",undefined,"exam-rubric-item"),value=state?.result?.marks?.[q.id];row.append(node("span",q.label),node("span",state?.error?"Unavailable":!state?.ready?"Loading…":typeof value==="number"?`${number(value)} / ${number(q.max)}${s.review?" · review":""}`:`Unmarked / ${number(q.max)}`));content.append(row);}
}
async function openFile(file,b){const tab=window.open("about:blank","_blank");if(!tab){$("history-dialog-status").textContent="Allow pop-ups to open the exam file.";return;}tab.opener=null;b.disabled=true;try{tab.location.replace(await getDownloadURL(ref(storage,file.path)));$("history-dialog-status").textContent="";}catch{tab.close();$("history-dialog-status").textContent="The exam file could not open. Check your connection and try again.";}finally{b.disabled=false;}}
function changeWeek(n){const next=addDays(week,n);if(next>today)return;week=next;listenWeek();}
$("history-prev").addEventListener("click",()=>changeWeek(-7));$("history-next").addEventListener("click",()=>changeWeek(7));$("history-current").addEventListener("click",()=>{week=monday(today);listenWeek();});
$("history-retry").addEventListener("click",listenWeek);$("history-exam-retry").addEventListener("click",listenExams);
for(const [id,other,show,hide] of [["tab-quests","tab-exams","quest-history","exam-history"],["tab-exams","tab-quests","exam-history","quest-history"]])$(id).addEventListener("click",()=>{$(show).hidden=false;$(hide).hidden=true;$(id).classList.add("is-active");$(other).classList.remove("is-active");$(id).setAttribute("aria-pressed","true");$(other).setAttribute("aria-pressed","false");});
$("history-close").addEventListener("click",()=>dialog.close());dialog.addEventListener("close",()=>{selection=null;});
function stop(){generation++;examGeneration++;questStops.forEach(s=>s());examStops.forEach(s=>s());examData.forEach(s=>s.stops.forEach(fn=>fn()));questStops=[];examStops=[];examData.clear();}
function refreshDate(){if(!user)return;const next=bangkokDate();if(next!==today){const current=week===monday(today);today=next;if(current)week=monday(today);listenWeek();listenExams();}}
setupAccountMenu();requireUser((account,role)=>{stop();if(!["Chick","King"].includes(role)){user=null;location.replace("main.html");return;}user=account;$("records-access").hidden=true;$("records-page").hidden=false;listenWeek();listenExams();});
window.addEventListener("pagehide",stop);window.addEventListener("pageshow",event=>{if(event.persisted&&user){refreshDate();listenWeek();listenExams();}});document.addEventListener("visibilitychange",()=>{if(!document.hidden)refreshDate();});setInterval(refreshDate,30000);

function richText(target, source) {
  target.replaceChildren();
  const tokens = /(\$\$[\s\S]*?\$\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\\begin\{equation\*?\}[\s\S]*?\\end\{equation\*?\}|\*\*[\s\S]+?\*\*|\*[^*\n]+?\*)/g;
  let start = 0;
  for (const match of source.matchAll(tokens)) {
    target.append(document.createTextNode(source.slice(start, match.index)));
    const token = match[0];
    if (token.startsWith("**")) {
      const strong = node("strong"); richText(strong, token.slice(2, -2)); target.append(strong);
    } else if (token.startsWith("*")) {
      const em = node("em"); richText(em, token.slice(1, -1)); target.append(em);
    } else {
      const span = node("span");
      const displayMode = !token.startsWith("\\(");
      const tex = token.startsWith("\\begin") ? token.replace(/^\\begin\{equation\*?\}/, "").replace(/\\end\{equation\*?\}$/, "") : token.slice(2, -2);
      if (window.katex) {
        try { window.katex.render(tex, span, { displayMode, throwOnError: true, trust: false, maxExpand: 1000, maxSize: 20 }); }
        catch { span.textContent = token; span.className = "quest-math-error"; span.title = "Check this LaTeX expression."; }
      } else { span.textContent = token; }
      target.append(span);
    }
    start = match.index + token.length;
  }
  target.append(document.createTextNode(source.slice(start)));
}
function loadMath() {
  if (mathPromise || window.katex) return;
  $("history-math-status").textContent = "Loading math…";
  mathPromise = new Promise((resolve, reject) => {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css"; document.head.append(link);
    const script = document.createElement("script"); script.src = "https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.js";
    script.onload = resolve; script.onerror = reject; document.head.append(script);
  }).then(() => { $("history-math-status").textContent = ""; if (dialog.open && selection?.type === "day") renderDay(); }).catch(() => {
    $("history-math-status").textContent = "Math display could not load. LaTeX is shown as typed; reload to retry.";
  });
}
