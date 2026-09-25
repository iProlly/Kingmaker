import { collection, doc, getFirestore, onSnapshot, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { auth } from "./firebase.js";
import { requireUser } from "./protected.js";

const db = getFirestore(auth.app);
const questions = collection(db, "dailyQuestQuestions");
const $ = id => document.getElementById(id);
const browser = $("quest-browser");
const editor = $("quest-editor");
const form = $("quest-question-form");
const prompt = $("quest-prompt");
const type = $("quest-type");
const date = $("quest-question-date");
let user, unsubscribe, items = [], loaded = false, saving = false, editingId = null, editingRevision = 0;
let baseline = "", activeText = prompt, selectedDate = "", today = bangkokDate(), mathPromise;
const expandedDates = new Set();

function bangkokDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map(key => parts.find(p => p.type === key).value).join("-");
}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00Z");
  return !Number.isNaN(+parsed) && parsed.toISOString().slice(0, 10) === value;
}
function dateLabel(value) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "long", year: "numeric" }).format(new Date(value + "T00:00:00Z"));
}
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function button(text, action, className = "button button-outline") {
  const el = node("button", text, className);
  el.type = "button";
  el.addEventListener("click", action);
  return el;
}
function status(message, error = false) {
  $("quest-status").textContent = message;
  $("quest-status").classList.toggle("is-error", error);
}
function fields() {
  return { date: date.value, type: type.value, prompt: prompt.value, options: [...$("quest-options").querySelectorAll("textarea")].map(el => el.value) };
}
function dirty() { return !editor.hidden && JSON.stringify(fields()) !== baseline; }
function mayLeave() { return !saving && (!dirty() || window.confirm("Discard your unsaved question changes?")); }

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
  if (mathPromise) return mathPromise;
  $("quest-math-status").textContent = "Loading math preview…";
  mathPromise = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css";
    document.head.append(css);
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.js";
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  }).then(() => { $("quest-math-status").textContent = ""; preview(); }).catch(() => {
    $("quest-math-status").textContent = "Math preview could not load. Your LaTeX is still saved as typed. Reload to retry.";
  });
  return mathPromise;
}
function preview() {
  $("quest-options-section").hidden = type.value !== "mcq";
  const container = $("quest-preview");
  container.replaceChildren();
  const body = node("div");
  richText(body, prompt.value || "Your question preview appears here.");
  container.append(body);
  if (type.value === "mcq") fields().options.forEach((value, index) => {
    const row = node("div", undefined, "quest-preview-choice");
    const content = node("div"); richText(content, value || "Choice text");
    row.append(node("strong", `${String.fromCharCode(65 + index)}.`), content);
    container.append(row);
  });
  else container.append(node("p", "Short answer · Manually reviewed", "field-hint"));
}
function relabelOptions() {
  const rows = [...$("quest-options").children];
  rows.forEach((row, index) => {
    row.querySelector("label").textContent = String.fromCharCode(65 + index) + ".";
    row.querySelector("textarea").setAttribute("aria-label", `Choice ${String.fromCharCode(65 + index)}`);
    row.querySelector("button").disabled = rows.length <= 2;
  });
  $("quest-add-option").disabled = rows.length >= 8;
}
let optionSerial = 0;
function addOption(value = "") {
  if ($("quest-options").children.length >= 8) return;
  const row = node("div", undefined, "quest-option");
  const input = node("textarea"); input.rows = 2; input.maxLength = 4000; input.value = value;
  input.id = `quest-option-${++optionSerial}`;
  const label = node("label"); label.htmlFor = input.id;
  input.addEventListener("focus", () => { activeText = input; });
  const remove = button("Remove", () => {
    if ($("quest-options").children.length <= 2) return;
    if (activeText === input) activeText = prompt;
    row.remove(); relabelOptions(); preview();
  });
  row.append(label, input, remove); $("quest-options").append(row); relabelOptions();
}
function openEditor(day, item = null) {
  if (!user || !loaded || !mayLeave()) return;
  editingId = item?.id || null; editingRevision = item?.revision || 0;
  date.value = item?.date || day; type.value = item?.type || "mcq"; prompt.value = item?.prompt || "";
  $("quest-options").replaceChildren();
  (item?.type === "mcq" ? item.options : ["", "", "", ""]).forEach(value => addOption(value));
  activeText = prompt; $("quest-editor-status").textContent = "";
  $("quest-editor-title").textContent = item ? "Edit question" : "Add question";
  $("material-page").hidden = true; editor.hidden = false;
  baseline = JSON.stringify(fields()); preview(); loadMath();
  window.scrollTo(0, 0); prompt.focus();
}
function closeEditor(force = false) {
  if (!force && !mayLeave()) return;
  editor.hidden = true; $("material-page").hidden = false;
  browser.closest("details").open = true;
  renderDates(); browser.scrollIntoView({ block: "start" });
}
function renderDates() {
  const upcoming = $("quest-upcoming"), past = $("quest-past");
  upcoming.replaceChildren(); past.replaceChildren();
  const dates = new Set([today, ...items.map(item => item.date)]);
  if (selectedDate) dates.add(selectedDate);
  const sorted = [...dates].filter(validDate).sort();
  for (const day of [...sorted.filter(day => day >= today), ...sorted.filter(day => day < today).reverse()]) {
    const dayItems = items.filter(item => item.date === day).sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0) || a.id.localeCompare(b.id));
    const section = node("section", undefined, "quest-day");
    const heading = node("div", undefined, "quest-day-heading");
    const label = node("div"); label.append(node("h3", `${day === today ? "Today · " : ""}${dateLabel(day)}`));
    const list = node("div", undefined, "quest-question-list"); list.hidden = !expandedDates.has(day);
    const count = button(`${dayItems.length} ${dayItems.length === 1 ? "question" : "questions"}`, () => {
      list.hidden = !list.hidden;
      if (list.hidden) expandedDates.delete(day); else expandedDates.add(day);
      count.setAttribute("aria-expanded", String(!list.hidden));
    }, "quest-day-count");
    count.setAttribute("aria-expanded", String(!list.hidden)); label.append(count);
    const add = button("+", () => openEditor(day)); add.setAttribute("aria-label", `Add question for ${dateLabel(day)}`); add.disabled = !loaded;
    heading.append(label, add); section.append(heading);
    dayItems.forEach((item, index) => {
      list.append(button(`${index + 1}. ${item.prompt.slice(0, 130)}${item.prompt.length > 130 ? "…" : ""} · ${item.type === "mcq" ? "MCQ" : "Short answer"}`, () => openEditor(day, item), "quest-question-link"));
    });
    if (!dayItems.length) list.append(node("p", "No questions yet. Use + to add the first one.", "field-hint"));
    section.append(list); (day < today ? past : upcoming).append(section);
  }
  if (!past.children.length) past.append(node("p", "No past quests yet.", "field-hint"));
}
$("quest-date-form").addEventListener("submit", event => {
  event.preventDefault(); const value = $("quest-date").value;
  if (!loaded || !validDate(value) || value < today) return;
  selectedDate = value; expandedDates.add(value); renderDates();
});
$("quest-add-option").addEventListener("click", () => { addOption(); preview(); });
$("quest-cancel").addEventListener("click", () => closeEditor());
prompt.addEventListener("focus", () => { activeText = prompt; });
form.addEventListener("input", preview);
type.addEventListener("change", () => { activeText = prompt; preview(); });
document.querySelectorAll("[data-quest-format]").forEach(control => {
  control.addEventListener("click", () => {
    const formats = { bold: ["**", "**", "bold text"], italic: ["*", "*", "italic text"], inline: ["\\(", "\\)", "x^2"], display: ["\n$$\n", "\n$$\n", "x^2"] };
    const [left, right, placeholder] = formats[control.dataset.questFormat];
    const input = activeText?.isConnected ? activeText : prompt;
    const start = input.selectionStart, end = input.selectionEnd;
    const text = input.value.slice(start, end) || placeholder;
    if (input.value.length + left.length + right.length + (end === start ? text.length : 0) > input.maxLength) return;
    input.setRangeText(left + text + right, start, end, "end");
    input.focus(); input.setSelectionRange(start + left.length, start + left.length + text.length); preview();
  });
});
form.addEventListener("submit", async event => {
  event.preventDefault();
  if (saving || !user || !form.reportValidity()) return;
  const value = fields(); value.prompt = value.prompt.trim();
  value.options = value.type === "mcq" ? value.options.map(option => option.trim()) : [];
  const message = $("quest-editor-status");
  if (!validDate(value.date) || !value.prompt || value.prompt.length > 20000 || !["mcq", "short"].includes(value.type)) {
    message.textContent = "Enter a valid date and a question."; return;
  }
  if (value.type === "mcq" && (value.options.length < 2 || value.options.length > 8 || value.options.some(option => !option || option.length > 4000))) {
    message.textContent = "Add text to every choice (2–8 choices), or remove unused choices."; return;
  }
  saving = true; $("quest-fields").disabled = true; $("quest-save").textContent = "Saving…"; message.textContent = "Saving question…";
  const reference = editingId ? doc(questions, editingId) : doc(questions);
  try {
    await runTransaction(db, async transaction => {
      if (editingId) {
        const snapshot = await transaction.get(reference);
        if (!snapshot.exists() || (snapshot.data().revision || 0) !== editingRevision) throw new Error("quest/conflict");
        transaction.update(reference, { ...value, revision: editingRevision + 1, updatedAt: serverTimestamp(), updatedBy: user.uid });
      } else transaction.set(reference, { ...value, revision: 1, createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid });
    });
    expandedDates.add(value.date); selectedDate = value.date;
    if (value.date < today) $("quest-past").parentElement.open = true;
    baseline = JSON.stringify(fields()); closeEditor(true); status("Question saved.");
  } catch (error) {
    console.error("Could not save Daily Quest.", error);
    message.textContent = error.message === "quest/conflict"
      ? "Another Master changed this question. Copy your draft, return to quests, and reopen the latest question."
      : "Could not save. Your draft is still here. Check your connection and Daily Quest Firestore rules, then try again.";
  } finally { saving = false; $("quest-fields").disabled = false; $("quest-save").textContent = "Save question"; relabelOptions(); }
});
window.addEventListener("beforeunload", event => { if (dirty() || saving) { event.preventDefault(); event.returnValue = ""; } });
document.addEventListener("click", event => {
  if (!editor.hidden && event.target.closest("a[href]") && !mayLeave()) event.preventDefault();
});
function refreshDate() {
  const next = bangkokDate();
  if (next !== today) { today = next; $("quest-date").min = today; renderDates(); }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshDate(); });
setInterval(refreshDate, 30000);
requireUser((account, role) => {
  unsubscribe?.();
  if (role !== "Master") { user = null; loaded = false; editor.hidden = true; return; }
  user = account;
  $("quest-date").value = today; $("quest-date").min = today; renderDates();
  unsubscribe = onSnapshot(questions, snapshot => {
    items = snapshot.docs.map(item => ({ ...item.data(), id: item.id })).filter(item => validDate(item.date));
    loaded = true; status(""); renderDates();
  }, error => { console.error("Could not load Daily Quest.", error); loaded = false; status("Daily quests could not load. Check your connection and Daily Quest Firestore rules, then reload.", true); renderDates(); });
});
