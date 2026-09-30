import { collection, doc, getFirestore, onSnapshot, query, runTransaction, serverTimestamp, where } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { auth } from "./firebase.js";
import { requireUser } from "./protected.js";

const db = getFirestore(auth.app);
const $ = id => document.getElementById(id);
const section = $("student-record-body").closest("details");
const dialog = $("record-dialog");
let master = false, active = false, today = bangkokDate(), week = monday(today), epoch = 0;
let students = [], questions = [], rosterReady = false, questionsReady = false, rosterError = false, questionsError = false;
let stopRoster, stopQuestions, selection = null, mathPromise, rosterEpoch = 0;
const records = new Map();
let currentMaster, marking = false, markMessage = "";
const scoreElement = node("div", undefined, "quest-day-score");
scoreElement.id = "record-day-score"; scoreElement.hidden = true; scoreElement.setAttribute("aria-live", "polite");
$("record-dialog-status").before(scoreElement);
const markStatus = node("p", "", "form-message"); markStatus.id = "record-mark-status"; markStatus.setAttribute("role", "status");
$("record-math-status").after(markStatus);
document.querySelector(".record-legend").textContent = "✓ Submitted · ✓✓ Fully marked · × Incomplete · — No quest or future date. Click a tick to view answers. Dates use Thailand time.";
function hasMark(answer) {
  return answer && ["right", "wrong"].includes(answer.mark) && answer.markedAnswerRevision === answer.revision;
}
function dayScore(items, answers) {
  const marked = items.filter(question => matches(question, answers.get(question.id)) && hasMark(answers.get(question.id)));
  return { marked: marked.length, right: marked.filter(question => answers.get(question.id).mark === "right").length, total: items.length };
}

function bangkokDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map(key => parts.find(part => part.type === key).value).join("-");
}
function addDays(day, amount) {
  const value = new Date(day + "T12:00:00Z"); value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
function monday(day) {
  const weekday = new Date(day + "T12:00:00Z").getUTCDay();
  return addDays(day, -(weekday + 6) % 7);
}
function dateLabel(day, options = { day: "numeric", month: "short", year: "numeric" }) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options }).format(new Date(day + "T12:00:00Z"));
}
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function dayQuestions(day) { return questions.filter(question => question.date === day); }
function matches(question, answer) {
  // Answers are keyed by question ID. Keep submissions and marks after question edits.
  return answer && answer.date === question.date;
}
function sameQuestionVersion(question, answer) {
  return answer && answer.date === question.date && answer.type === question.type && answer.questionRevision === question.revision;
}
function completion(studentId, day) {
  const record = records.get(studentId), items = dayQuestions(day);
  if (!questionsReady || questionsError) return { state: "unknown", label: "Questions unavailable" };
  if (day > today) return { state: "na", label: "Future date" };
  if (!items.length) return { state: "na", label: "No quest set" };
  if (!record?.ready || record.error) return { state: "unknown", label: record?.error ? "Answers unavailable" : "Loading answers" };
  const count = items.filter(question => matches(question, record.answers.get(question.id))).length;
  const score = dayScore(items, record.answers);
  const fullyMarked = count === items.length && score.marked === items.length;
  return { state: count === items.length ? "complete" : "incomplete", fullyMarked,
    label: fullyMarked ? `Fully marked. Score ${score.right}/${score.total}` : `${count} of ${items.length} questions submitted; ${score.marked} marked` };
}
function render() {
  const end = addDays(week, 6);
  $("record-week-label").textContent = `${dateLabel(week)} – ${dateLabel(end)}`;
  $("record-caption").textContent = `Student Daily Quest submissions, ${dateLabel(week)} to ${dateLabel(end)}. Thailand time.`;
  $("record-current").disabled = week === monday(today);
  const header = node("tr"); const name = node("th", "Student"); name.scope = "col"; header.append(name);
  for (let offset = 0; offset < 7; offset++) {
    const day = addDays(week, offset);
    const th = node("th", dateLabel(day, { weekday: "short" }), day === today ? "record-today" : "");
    th.scope = "col"; if (day === today) th.setAttribute("aria-current", "date");
    th.append(node("span", dateLabel(day, { day: "numeric", month: "short" }), "record-day-date")); header.append(th);
  }
  $("record-head").replaceChildren(header);
  const rows = [];
  for (const student of students) {
    const row = node("tr"), identity = node("th", student.displayName || "Learner"); identity.scope = "row";
    identity.append(node("span", `@${student.username || "student"}`, "record-student-handle")); row.append(identity);
    for (let offset = 0; offset < 7; offset++) {
      const day = addDays(week, offset), result = completion(student.id, day), cell = node("td");
      const label = `${student.displayName || student.username || "Learner"}, ${dateLabel(day)}: ${result.label}`;
      if (result.state === "complete") {
        const button = node("button", result.fullyMarked ? "✓✓" : "✓", result.fullyMarked ? "record-complete record-marked" : "record-complete"); button.type = "button";
        button.setAttribute("aria-label", label + ". View answers"); button.title = label;
        button.addEventListener("click", () => openAnswers(student.id, day)); cell.append(button);
      } else {
        const mark = node("span", result.state === "incomplete" ? "×" : result.state === "na" ? "—" : "…", `record-${result.state}`);
        mark.setAttribute("role", "img"); mark.setAttribute("aria-label", label); mark.title = label; cell.append(mark);
      }
      row.append(cell);
    }
    rows.push(row);
  }
  $("record-rows").replaceChildren(...rows);
  const failed = rosterError || questionsError || [...records.values()].some(record => record.error);
  const loading = !rosterReady || !questionsReady || [...records.values()].some(record => !record.ready && !record.error);
  $("record-status").textContent = failed ? "Some records could not load. Unavailable records are shown as …, not incomplete. Please retry."
    : loading ? "Loading student records…" : !students.length ? "No Chick students yet." : "";
  $("record-status").classList.toggle("is-error", failed);
  $("record-retry").hidden = !failed;
  if (dialog.open) renderAnswers();
}
function stopWeek() {
  stopQuestions?.(); stopQuestions = null;
  for (const record of records.values()) record.stop?.();
  records.clear(); ++epoch;
}
function listenStudents() {
  if (!active) return;
  const validIds = new Set(students.map(student => student.id));
  for (const [id, record] of records) if (!validIds.has(id)) { record.stop?.(); records.delete(id); }
  const token = epoch;
  for (const student of students) {
    if (records.has(student.id)) continue;
    const record = { ready: false, error: false, answers: new Map() }; records.set(student.id, record);
    record.stop = onSnapshot(query(collection(db, "users", student.id, "dailyQuestAnswers"), where("date", ">=", week), where("date", "<=", addDays(week, 6))), { includeMetadataChanges: true }, snapshot => {
      if (snapshot.metadata.hasPendingWrites) return;
      if (!active || token !== epoch || records.get(student.id) !== record) return;
      record.answers = new Map(snapshot.docs.map(item => [item.id, item.data()])); record.ready = true; record.error = false; render();
    }, error => {
      if (!active || token !== epoch || records.get(student.id) !== record) return;
      console.error("Student record could not load.", error); record.error = true; render();
    });
  }
}
function listenWeek() {
  stopWeek(); questions = []; questionsReady = false; questionsError = false;
  if (dialog.open) dialog.close(); selection = null;
  const token = epoch;
  stopQuestions = onSnapshot(query(collection(db, "dailyQuestQuestions"), where("date", ">=", week), where("date", "<=", addDays(week, 6))), snapshot => {
    if (!active || token !== epoch) return;
    questions = snapshot.docs.map(item => ({ ...item.data(), id: item.id }))
      .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0) || a.id.localeCompare(b.id));
    questionsReady = true; questionsError = false; render();
  }, error => {
    if (!active || token !== epoch) return;
    console.error("Weekly questions could not load.", error); questionsError = true; render();
  });
  listenStudents(); render();
}
function start() {
  if (!master || !section.open || active) return;
  active = true; students = []; rosterReady = false; rosterError = false;
  listenWeek();
  const rosterToken = rosterEpoch;
  stopRoster = onSnapshot(query(collection(db, "users"), where("role", "==", "Chick")), snapshot => {
    if (!active || rosterToken !== rosterEpoch) return;
    students = snapshot.docs.map(item => ({ ...item.data(), id: item.id })).sort((a, b) => (a.displayName || a.username || "").localeCompare(b.displayName || b.username || "", "th") || a.id.localeCompare(b.id));
    rosterReady = true; rosterError = false; listenStudents(); render();
  }, error => { if (active && rosterToken === rosterEpoch) { console.error("Student list could not load.", error); rosterError = true; students = []; listenStudents(); render(); } });
}
function stop() {
  active = false; ++rosterEpoch; stopRoster?.(); stopRoster = null; stopWeek();
  if (dialog.open) dialog.close(); selection = null;
}
function openAnswers(studentId, day) {
  if (!master || completion(studentId, day).state !== "complete") return;
  selection = { studentId, day }; markMessage = ""; renderAnswers(); dialog.showModal(); loadMath();
}
function renderAnswers() {
  if (!selection) return;
  scoreElement.hidden = true; markStatus.textContent = markMessage;
  markStatus.classList.toggle("success", markMessage.startsWith("Mark saved."));
  const student = students.find(item => item.id === selection.studentId), record = records.get(selection.studentId);
  $("record-answers").replaceChildren();
  $("record-dialog-title").textContent = student?.displayName || student?.username || "Student";
  $("record-dialog-date").textContent = dateLabel(selection.day, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  if (!student || !record?.ready || record.error || questionsError || !questionsReady) {
    $("record-dialog-status").textContent = "These records are currently unavailable. Close this window and retry loading."; return;
  }
  const items = dayQuestions(selection.day), state = completion(student.id, selection.day);
  const score = dayScore(items, record.answers);
  scoreElement.hidden = score.marked === 0;
  scoreElement.textContent = `Score ${score.right}/${score.total}`;
  $("record-dialog-status").textContent = state.state === "complete"
    ? `${score.marked} of ${score.total} marked${score.marked < score.total ? " · Score so far" : " · Marking complete"}. Each question is worth 1 point.`
    : "This day's questions or submissions have changed. The record is no longer complete.";
  items.forEach((question, index) => {
    const answer = record.answers.get(question.id), current = matches(question, answer), sameVersion = sameQuestionVersion(question, answer);
    const article = node("article", undefined, "record-answer");
    article.append(node("h3", `Question ${index + 1} · ${question.type === "mcq" ? "Multiple choice" : "Short answer"}`));
    const prompt = node("div", undefined, "quest-rich record-answer-prompt"); richText(prompt, question.prompt); article.append(prompt);
    if (question.type === "mcq") {
      const choices = node("ol", undefined, "record-answer-options"); choices.type = "A";
      question.options.forEach((option, optionIndex) => {
        const li = node("li", undefined, sameVersion && answer.choiceIndex === optionIndex ? "record-selected-option" : "");
        const content = node("div", undefined, "quest-rich"); richText(content, option); li.append(content);
        if (sameVersion && answer.choiceIndex === optionIndex) li.append(node("span", "Student’s choice", "field-hint")); choices.append(li);
      }); article.append(choices);
    }
    const box = node("div", undefined, "record-answer-value"); box.append(node("p", "Submitted answer"));
    const value = node("div", undefined, "quest-rich");
    if (!answer) value.textContent = "No answer submitted.";
    else richText(value, answer.type === "mcq"
      ? (sameVersion ? `${String.fromCharCode(65 + answer.choiceIndex)}. ${question.options[answer.choiceIndex]}` : `Option ${String.fromCharCode(65 + answer.choiceIndex)} (earlier question version)`)
      : answer.text);
    box.append(value); article.append(box);
    if (current && !sameVersion) article.append(node("p", "This question was updated after submission. The submitted answer and any marks still count.", "field-hint"));
    const timestamp = answer?.updatedAt?.toDate?.();
    if (timestamp) article.append(node("p", "Last submitted: " + new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" }).format(timestamp) + " (Thailand)", "field-hint"));
    if (current) {
      const controls = node("div", undefined, "record-mark-controls");
      const legend = node("p", hasMark(answer) ? (answer.mark === "right" ? "✓ Right · 1 point" : "× Wrong · 0 points") : "Not marked", hasMark(answer) ? `mark-result mark-${answer.mark}` : "field-hint");
      controls.append(legend);
      const actions = node("div", undefined, "record-mark-buttons");
      for (const value of ["right", "wrong"]) {
        const button = node("button", value === "right" ? "✓ Right" : "× Wrong", `button button-outline mark-button mark-button-${value}`);
        button.type = "button"; button.disabled = marking;
        button.setAttribute("aria-label", `Mark question ${index + 1} ${value}`);
        button.setAttribute("aria-pressed", String(hasMark(answer) && answer.mark === value));
        button.addEventListener("click", () => markAnswer(student.id, question, answer, value));
        actions.append(button);
      }
      controls.append(actions); article.append(controls);
    }
    $("record-answers").append(article);
  });
}


async function markAnswer(studentId, question, displayedAnswer, value) {
  if (!master || !currentMaster || marking || !["right", "wrong"].includes(value)) return;
  if (hasMark(displayedAnswer) && displayedAnswer.mark === value) return;
  const selected = selection, token = epoch;
  const teacherId = currentMaster.uid;
  const reference = doc(db, "users", studentId, "dailyQuestAnswers", question.id);
  marking = true; markMessage = "Saving mark…"; renderAnswers();
  try {
    const grade = await runTransaction(db, async transaction => {
      const questionSnapshot = await transaction.get(doc(db, "dailyQuestQuestions", question.id));
      const answerSnapshot = await transaction.get(reference);
      const latestQuestion = questionSnapshot.data(), latestAnswer = answerSnapshot.data();
      if (!questionSnapshot.exists() || !answerSnapshot.exists() || latestQuestion.revision !== question.revision
          || !matches(latestQuestion, latestAnswer) || latestAnswer.revision !== displayedAnswer.revision
          || (latestAnswer.mark || null) !== (displayedAnswer.mark || null)) throw new Error("mark/changed");
      const data = { mark: value, markedBy: teacherId, markedAt: serverTimestamp(), markedAnswerRevision: latestAnswer.revision };
      transaction.update(reference, data);
      return data;
    });
    if (token === epoch && records.has(studentId)) {
      const cached = records.get(studentId).answers.get(question.id);
      if (cached?.revision === displayedAnswer.revision && (cached.mark || null) === (displayedAnswer.mark || null)) Object.assign(cached, grade);
    }
    if (selection === selected) markMessage = "Mark saved. This answer is now locked for the student.";
  } catch (error) {
    console.error("Could not save mark.", error);
    if (selection === selected) markMessage = error.message === "mark/changed"
      ? "The question, answer, or mark changed. Review the latest answer before marking again."
      : "The mark was not saved. Check your connection and marking permissions, then try again.";
  } finally { marking = false; render(); }
}

// Parse only the supported formatting. User text is never inserted as HTML.
// Math is tokenized first, preserving underscores, stars, and line breaks in TeX.
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
  $("record-math-status").textContent = "Loading math…";
  mathPromise = new Promise((resolve, reject) => {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css"; document.head.append(link);
    const script = document.createElement("script"); script.src = "https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.js";
    script.onload = resolve; script.onerror = reject; document.head.append(script);
  }).then(() => { $("record-math-status").textContent = ""; if (dialog.open) renderAnswers(); }).catch(() => {
    $("record-math-status").textContent = "Math display could not load. LaTeX is shown as typed; reload to retry.";
  });
}
$("record-dialog-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => { selection = null; });
function changeWeek(amount) { if (!master || marking) return; week = addDays(week, amount); if (active) listenWeek(); else render(); }
$("record-prev").addEventListener("click", () => changeWeek(-7));
$("record-next").addEventListener("click", () => changeWeek(7));
$("record-current").addEventListener("click", () => { week = monday(today); if (active) listenWeek(); else render(); });
$("record-retry").addEventListener("click", () => { stop(); start(); });
section.addEventListener("toggle", () => { if (section.open) start(); else stop(); });
function refreshToday() {
  const next = bangkokDate();
  if (next !== today) { const followingCurrentWeek = week === monday(today); today = next; if (followingCurrentWeek) week = monday(today); if (active) listenWeek(); else render(); }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshToday(); });
setInterval(refreshToday, 30000);
requireUser((user, role) => { stop(); master = role === "Master"; currentMaster = master ? user : null; if (master) { render(); start(); } });
