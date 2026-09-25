import { collection, doc, getFirestore, onSnapshot, query, runTransaction, serverTimestamp, where } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { auth } from "./firebase.js";
import { requireUser } from "./protected.js";

const db = getFirestore(auth.app);
const $ = id => document.getElementById(id);
const panel = $("student-quest");
const drafts = new Map();
let user, today = bangkokDate(), questions = [], answers = new Map(), currentId = null;
let questionsReady = false, answersReady = false, saving = false, failed = false, generation = 0;
let stopQuestions, stopAnswers, mathPromise;
const scoreElement = node("div", undefined, "quest-day-score");
scoreElement.id = "student-day-score"; scoreElement.hidden = true; scoreElement.setAttribute("aria-live", "polite");
$("student-quest-count").after(scoreElement);
const answerReview = $("student-answer-saved").querySelector(".field-hint");
function hasMark(answer) {
  return answer && ["right", "wrong"].includes(answer.mark) && answer.markedAnswerRevision === answer.revision;
}

function bangkokDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map(key => parts.find(part => part.type === key).value).join("-");
}
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function currentQuestion() { return questions.find(question => question.id === currentId); }
function submitted(question) {
  const answer = answers.get(question.id);
  return answer && answer.date === question.date && answer.type === question.type && answer.questionRevision === question.revision;
}
function draftKey(id) { return `formQuestDraft-v1-${user.uid}-${today}-${id}`; }
function persistDraft(id, draft) {
  drafts.set(id, draft);
  try { sessionStorage.setItem(draftKey(id), JSON.stringify(draft)); } catch { /* In-memory drafts still work. */ }
}
function discardDraft(id) {
  drafts.delete(id);
  try { sessionStorage.removeItem(draftKey(id)); } catch { /* Storage may be disabled. */ }
}
function existingDraft(id) {
  if (drafts.has(id)) return drafts.get(id);
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftKey(id)) || "null");
    if (saved && typeof saved.text === "string" && Number.isInteger(saved.choiceIndex) && Number.isInteger(saved.questionRevision) && Number.isInteger(saved.baseRevision)) {
      drafts.set(id, saved); return saved;
    }
  } catch { /* Ignore a damaged or unavailable draft. */ }
  return null;
}
function makeDraft(question) {
  const answer = answers.get(question.id);
  return { type: question.type, text: answer?.type === "short" ? answer.text : "", choiceIndex: submitted(question) ? answer.choiceIndex : -1,
    questionRevision: question.revision, baseRevision: answer?.revision || 0, dirty: false };
}
function getDraft(question) {
  let draft = existingDraft(question.id);
  if (!draft) { draft = makeDraft(question); drafts.set(question.id, draft); }
  if (draft.questionRevision !== question.revision || draft.type !== question.type) {
    draft = { ...draft, type: question.type, questionRevision: question.revision, choiceIndex: -1,
      text: question.type === "short" && draft.type === "short" ? draft.text : "", dirty: true, questionChanged: true };
    persistDraft(question.id, draft);
  }
  return draft;
}
function message(text, success = false) {
  $("student-answer-status").textContent = text;
  $("student-answer-status").classList.toggle("success", success);
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
  $("student-quest-math").textContent = "Loading math…";
  mathPromise = new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet"; link.href = "https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css";
    document.head.append(link);
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.js";
    script.onload = resolve; script.onerror = reject; document.head.append(script);
  }).then(() => { $("student-quest-math").textContent = ""; render(); }).catch(() => {
    $("student-quest-math").textContent = "Math display could not load. Equations are shown as LaTeX. Reload to try again.";
  });
}
function renderAnswerInput(question, draft) {
  const host = $("student-answer-input"); host.replaceChildren();
  if (question.type === "mcq") {
    question.options.forEach((option, index) => {
      const label = node("label", undefined, "student-choice");
      const input = node("input"); input.type = "radio"; input.name = "questChoice"; input.value = String(index); input.required = true;
      input.checked = draft.choiceIndex === index;
      input.addEventListener("change", () => {
        draft.choiceIndex = index; draft.dirty = true; persistDraft(question.id, draft); message("");
      });
      const content = node("span", undefined, "quest-rich"); richText(content, option);
      label.append(input, node("span", `${String.fromCharCode(65 + index)}.`, "student-choice-letter"), content);
      host.append(label);
    });
  } else {
    const field = node("div", undefined, "field");
    const label = node("label", "Your answer"); label.htmlFor = "student-short-answer";
    const input = node("textarea"); input.id = "student-short-answer"; input.rows = 5; input.maxLength = 10000; input.required = true; input.value = draft.text;
    input.placeholder = "Write your answer…"; input.setAttribute("aria-describedby", "student-answer-hint");
    const hint = node("p", "You can use \\( x^2 \\) for inline math or $$ x^2 $$ for an equation.", "field-hint"); hint.id = "student-answer-hint";
    const preview = node("div", undefined, "student-answer-preview");
    const previewBody = node("div", undefined, "quest-rich");
    preview.append(node("p", "ANSWER PREVIEW"), previewBody); preview.hidden = !draft.text.trim();
    richText(previewBody, draft.text);
    input.addEventListener("input", () => {
      draft.text = input.value; draft.dirty = true; persistDraft(question.id, draft); message("");
      preview.hidden = !input.value.trim(); richText(previewBody, input.value);
    });
    field.append(label, input, hint); host.append(field, preview);
  }
}
function render() {
  if (!user || panel.hidden) return;
  const ready = questionsReady && answersReady && !failed;
  $("student-quest-content").hidden = !ready || questions.length === 0;
  $("student-quest-complete").hidden = true;
  $("student-quest-count").textContent = ""; scoreElement.hidden = true;
  $("student-quest-retry").hidden = !failed;
  if (failed) return;
  $("student-quest-status").textContent = ready ? (questions.length ? "" : "No daily quest has been set for today. Check back later.") : "Loading today’s questions…";
  if (!ready || !questions.length) return;
  const done = questions.filter(submitted).length;
  $("student-quest-count").textContent = `${done} of ${questions.length} submitted`;
  $("student-quest-complete").hidden = done !== questions.length;
  const graded = questions.filter(question => submitted(question) && hasMark(answers.get(question.id)));
  const right = graded.filter(question => answers.get(question.id).mark === "right").length;
  scoreElement.hidden = graded.length === 0;
  scoreElement.textContent = `Score ${right}/${questions.length}${graded.length < questions.length ? ` · ${graded.length}/${questions.length} marked` : ""}`;
  $("student-quest-complete").textContent = graded.length === questions.length ? "✓✓ Daily quest marked" : "✓ Daily quest completed";
  if (!currentQuestion()) currentId = (questions.find(question => !submitted(question)) || questions[0]).id;
  const question = currentQuestion(), index = questions.indexOf(question), answer = answers.get(question.id);
  const saved = submitted(question);
  const locked = hasMark(answer);
  const editing = !locked && (!saved || Boolean(existingDraft(question.id)));
  const draft = editing ? getDraft(question) : null;
  $("student-question-number").textContent = `Question ${index + 1}`;
  $("student-question-state").textContent = locked ? (answer.mark === "right" ? "✓ Right · 1 point" : "× Wrong · 0 points") : saved ? "✓ Submitted" : question.type === "mcq" ? "Multiple choice" : "Short answer";
  richText($("student-question-prompt"), question.prompt);
  $("student-question-notice").textContent = answer && !saved ? (locked ? "Your teacher changed this question after marking. Your marked answer remains locked." : "This question has changed since your submission. Review it and submit your answer again.") : draft?.questionChanged ? "Your teacher updated this question. Check your draft before submitting." : "";
  $("student-answer-form").hidden = !editing;
  $("student-answer-saved").hidden = editing;
  $("student-answer-fields").disabled = saving;
  $("student-answer-edit").disabled = saving || locked;
  $("student-answer-edit").hidden = locked;
  answerReview.textContent = locked ? (answer.mark === "right" ? "✓ Right · 1 point · Answer locked" : "× Wrong · 0 points · Answer locked") : "Submitted · Awaiting review";
  answerReview.className = locked ? `field-hint mark-result mark-${answer.mark}` : "field-hint";
  if (editing) {
    renderAnswerInput(question, draft);
    $("student-answer-submit").textContent = saving ? "Submitting…" : saved ? "Save changes" : "Submit answer";
    $("student-answer-cancel").hidden = !saved;
  } else {
    const value = answer.type === "mcq"
      ? (saved ? `${String.fromCharCode(65 + answer.choiceIndex)}. ${question.options[answer.choiceIndex]}` : `Option ${String.fromCharCode(65 + answer.choiceIndex)} (earlier question version)`)
      : answer.text;
    richText($("student-answer-value"), value);
  }
  $("student-quest-navigation").hidden = questions.length <= 1;
  $("student-quest-position").textContent = `${index + 1} / ${questions.length}`;
  $("student-quest-prev").disabled = saving || index === 0;
  $("student-quest-next").disabled = saving || index === questions.length - 1;
}
function listenForToday() {
  stopQuestions?.(); stopAnswers?.();
  const token = ++generation;
  today = bangkokDate(); questions = []; answers = new Map(); currentId = null;
  questionsReady = false; answersReady = false; failed = false; drafts.clear();
  $("student-quest-status").classList.remove("is-error"); message("");
  const label = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
  $("student-quest-date").textContent = `${label} · Thailand time`;
  $("date-label").textContent = label.toUpperCase();
  render();
  const onError = error => {
    if (token !== generation) return;
    console.error("Could not load student quests.", error);
    failed = true;
    $("student-quest-status").textContent = "Daily Quest could not load. Check your connection and try again. If this continues, ask your teacher to check access permissions.";
    $("student-quest-status").classList.add("is-error"); render();
  };
  stopQuestions = onSnapshot(query(collection(db, "dailyQuestQuestions"), where("date", "==", today)), snapshot => {
    if (token !== generation) return;
    questions = snapshot.docs.map(item => ({ ...item.data(), id: item.id }))
      .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0) || a.id.localeCompare(b.id));
    questionsReady = true; render();
  }, onError);
  stopAnswers = onSnapshot(query(collection(db, "users", user.uid, "dailyQuestAnswers"), where("date", "==", today)), { includeMetadataChanges: true }, snapshot => {
    if (token !== generation || snapshot.metadata.hasPendingWrites) return;
    answers = new Map(snapshot.docs.map(item => [item.id, item.data()]));
    for (const [id, answer] of answers) {
      if (hasMark(answer)) {
        discardDraft(id);
        if (id === currentId) message("Your teacher marked this answer. The submitted answer is now locked.", true);
      }
    }
    for (const [id, draft] of drafts) {
      if (!draft.dirty && answers.has(id) && answers.get(id).revision !== draft.baseRevision) discardDraft(id);
    }
    answersReady = true; render();
  }, onError);
}
function moveQuestion(direction) {
  if (saving) return;
  const next = questions.indexOf(currentQuestion()) + direction;
  if (next < 0 || next >= questions.length) return;
  currentId = questions[next].id; message(""); render(); $("student-question-number").focus();
}
$("student-quest-prev").addEventListener("click", () => moveQuestion(-1));
$("student-quest-next").addEventListener("click", () => moveQuestion(1));
$("student-quest-retry").addEventListener("click", () => { if (user && !saving) listenForToday(); });
$("student-answer-edit").addEventListener("click", () => {
  const question = currentQuestion(); if (!question || saving || hasMark(answers.get(question.id))) return;
  persistDraft(question.id, makeDraft(question)); message(""); render();
  $("student-answer-input").querySelector("textarea, input")?.focus();
});
$("student-answer-cancel").addEventListener("click", () => {
  const question = currentQuestion(); if (!question || saving || hasMark(answers.get(question.id))) return;
  discardDraft(question.id); message(""); render();
});
$("student-answer-form").addEventListener("submit", async event => {
  event.preventDefault();
  const question = currentQuestion();
  if (!question || saving || !user || failed || !answersReady || !questionsReady) return;
  if (hasMark(answers.get(question.id))) { render(); return; }
  if (bangkokDate() !== today) { listenForToday(); return; }
  const draft = getDraft(question);
  const text = draft.text.trim();
  if (question.type === "mcq" && (!Number.isInteger(draft.choiceIndex) || draft.choiceIndex < 0 || draft.choiceIndex >= question.options.length)) {
    message("Choose an answer before submitting."); return;
  }
  if (question.type === "short" && (!text || text.length > 10000)) { message("Enter an answer of up to 10,000 characters."); return; }
  const token = generation, account = user, day = today;
  const reference = doc(db, "users", account.uid, "dailyQuestAnswers", question.id);
  const expectedRevision = draft.baseRevision;
  const data = { date: day, type: question.type, questionRevision: question.revision,
    choiceIndex: question.type === "mcq" ? draft.choiceIndex : -1, text: question.type === "short" ? text : "" };
  saving = true; message("Submitting…"); render();
  try {
    const saved = await runTransaction(db, async transaction => {
      const latestQuestion = await transaction.get(doc(db, "dailyQuestQuestions", question.id));
      const latestAnswer = await transaction.get(reference);
      const latest = latestQuestion.data();
      if (!latestQuestion.exists() || latest.date !== day || latest.type !== question.type || latest.revision !== question.revision) throw new Error("quest/changed");
      const previous = latestAnswer.exists() ? latestAnswer.data() : null;
      if (hasMark(previous)) {
        const error = new Error("quest/marked"); error.markedAnswer = previous; throw error;
      }
      if ((previous?.revision || 0) !== expectedRevision) throw new Error("quest/answer-conflict");
      const payload = { ...data, revision: expectedRevision + 1, createdAt: previous?.createdAt || serverTimestamp(), updatedAt: serverTimestamp() };
      transaction.set(reference, payload);
      return payload;
    });
    if (token !== generation) return;
    const current = answers.get(question.id);
    if (!(hasMark(current) && current.revision === saved.revision)) answers.set(question.id, saved);
    discardDraft(question.id);
    message(hasMark(answers.get(question.id)) ? "Your teacher marked this answer. The submitted answer is now locked." : "Answer submitted. You can edit it today until your teacher marks it.", true);
  } catch (error) {
    if (token !== generation) return;
    if (error.markedAnswer) { answers.set(question.id, error.markedAnswer); discardDraft(question.id); }
    console.error("Could not submit quest answer.", error);
    message(error.message === "quest/marked" ? "Your teacher has marked this answer. It is now locked and cannot be edited."
      : error.message === "quest/changed" ? "Your teacher changed this question. Review the updated question before submitting again."
      : error.message === "quest/answer-conflict" ? "Your answer was changed on another device. Copy any changes you want to keep, then cancel editing and reopen the saved answer."
      : "Your answer was not submitted. Your draft is still here. Check your connection and try again.");
  } finally {
    saving = false;
    if (token === generation) { render(); refreshDay(); }
  }
});
function refreshDay() {
  if (user && !saving && bangkokDate() !== today) listenForToday();
}
window.addEventListener("beforeunload", event => {
  if (saving || [...drafts.values()].some(draft => draft.dirty)) { event.preventDefault(); event.returnValue = ""; }
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshDay(); });
setInterval(refreshDay, 30000);
requireUser((account, role) => {
  stopQuestions?.(); stopAnswers?.(); ++generation;
  if (role !== "Chick") { user = null; panel.hidden = true; $("today-focus").hidden = false; return; }
  user = account; panel.hidden = false; $("today-focus").hidden = true;
  listenForToday(); loadMath();
});
