import { richText, isChoiceQuestion } from "./quest-rich.js";
import { collection, doc, getFirestore, onSnapshot, runTransaction, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { auth } from "./firebase.js";
import { requireUser } from "./protected.js";

import { getStorage, ref, uploadBytesResumable, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
const storage = getStorage(auth.app);
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
let uploadingImage = false, imageInsertion = null;
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
function mayLeave() { return !saving && !uploadingImage && (!dirty() || window.confirm("Discard your unsaved question changes?")); }

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
  $("quest-options-section").hidden = !isChoiceQuestion(type.value);
  const container = $("quest-preview");
  container.replaceChildren();
  const body = node("div");
  richText(body, prompt.value || "Your question preview appears here.");
  container.append(body);
  if (isChoiceQuestion(type.value)) fields().options.forEach((value, index) => {
    const row = node("div", undefined, "quest-preview-choice");
    const content = node("div"); richText(content, value || "Choice text");
    row.append(node("strong", `${String.fromCharCode(65 + index)}.`), content);
    container.append(row);
  });
  else container.append(node("p", "Short answer · Manually reviewed", "field-hint"));
  if (type.value === "multi") container.prepend(node("p", "Select all that apply · Manually reviewed", "field-hint"));
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
  const imageButton = button("Image", () => openImageDialog(input));
  imageButton.classList.add("quest-option-image");
  imageButton.setAttribute("aria-label", "Insert image into this choice");
  row.append(label, input, remove, imageButton); $("quest-options").append(row); relabelOptions();
}
function openEditor(day, item = null) {
  if (!user || !loaded || !mayLeave()) return;
  editingId = item?.id || null; editingRevision = item?.revision || 0;
  date.value = item?.date || day; type.value = item?.type || "mcq"; prompt.value = item?.prompt || "";
  $("quest-options").replaceChildren();
  (isChoiceQuestion(item?.type) ? item.options : ["", "", "", ""]).forEach(value => addOption(value));
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
      list.append(button(`${index + 1}. ${item.prompt.slice(0, 130)}${item.prompt.length > 130 ? "…" : ""} · ${item.type === "mcq" ? "One answer" : item.type === "multi" ? "Multiple answers" : "Short answer"}`, () => openEditor(day, item), "quest-question-link"));
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
  if (saving || uploadingImage || !user || !form.reportValidity()) return;
  const value = fields(); value.prompt = value.prompt.trim();
  value.options = isChoiceQuestion(value.type) ? value.options.map(option => option.trim()) : [];
  const message = $("quest-editor-status");
  if (!validDate(value.date) || !value.prompt || value.prompt.length > 20000 || !["mcq", "multi", "short"].includes(value.type)) {
    message.textContent = "Enter a valid date and a question."; return;
  }
  if (isChoiceQuestion(value.type) && (value.options.length < 2 || value.options.length > 8 || value.options.some(option => !option || option.length > 4000))) {
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
      : error.code === "permission-denied" ? "Saving was denied. Your draft is still here. Ask the site owner to check permissions for this question type."
      : "Could not save. Your draft is still here. Check your connection and Daily Quest Firestore rules, then try again.";
  } finally { saving = false; $("quest-fields").disabled = false; $("quest-save").textContent = "Save question"; relabelOptions(); }
});
window.addEventListener("beforeunload", event => { if (dirty() || saving || uploadingImage) { event.preventDefault(); event.returnValue = ""; } });
document.addEventListener("click", event => {
  if (!editor.hidden && event.target.closest("a[href]") && !mayLeave()) event.preventDefault();
});

// Capture the exact textarea and insertion point before opening the file dialog.
function openImageDialog(input = activeText) {
  if (!user || saving || uploadingImage) return;
  const target = input?.isConnected ? input : prompt;
  imageInsertion = { target, start: target.selectionStart, end: target.selectionEnd };
  $("quest-image-form").reset();
  $("quest-image-status").textContent = "";
  const choice = [...$("quest-options").querySelectorAll("textarea")].indexOf(target);
  $("quest-image-target").textContent = choice < 0 ? "Insert at the cursor in the question." : `Insert at the cursor in choice ${String.fromCharCode(65 + choice)}.`;
  $("quest-image-dialog").showModal();
}
$("quest-insert-image").addEventListener("click", () => openImageDialog());
$("quest-image-cancel").addEventListener("click", () => { if (!uploadingImage) $("quest-image-dialog").close(); });
$("quest-image-dialog").addEventListener("cancel", event => { if (uploadingImage) event.preventDefault(); });
$("quest-image-dialog").addEventListener("close", () => {
  if (imageInsertion?.target.isConnected) imageInsertion.target.focus();
  imageInsertion = null;
});
$("quest-image-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!user || uploadingImage || saving || !imageInsertion) return;
  const file = $("quest-image-file").files[0];
  const allowed = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
  const message = $("quest-image-status");
  if (!file || !allowed[file.type] || file.size === 0 || file.size > 8 * 1024 * 1024) {
    message.textContent = "Choose a PNG, JPG, GIF or WebP image up to 8 MB."; return;
  }
  const { target, start, end } = imageInsertion;
  const owner = user.uid;
  if (!target.isConnected) { message.textContent = "This choice was removed. Close this dialog and choose another insertion point."; return; }
  const description = ($("quest-image-alt").value.trim() || file.name).replace(/[\[\]\\*\r\n]/g, " ").slice(0, 180);
  const documentRef = doc(collection(db, "permanentMaterialItems"));
  const storagePath = `permanent-material/${documentRef.id}.${allowed[file.type]}`;
  const imageRef = ref(storage, storagePath);
  let uploaded = false, recorded = false;
  uploadingImage = true;
  $("quest-fields").disabled = true;
  for (const control of $("quest-image-form").elements) control.disabled = true;
  try {
    // Decode first so renamed non-images do not become broken question images.
    const objectURL = URL.createObjectURL(file);
    try {
      await new Promise((resolve, reject) => {
        const image = new Image(); image.onload = resolve; image.onerror = () => reject(new Error("image/invalid")); image.src = objectURL;
      });
    } finally { URL.revokeObjectURL(objectURL); }
    message.textContent = "Uploading image… 0%";
    await new Promise((resolve, reject) => {
      const task = uploadBytesResumable(imageRef, file, { contentType: file.type });
      task.on("state_changed", snapshot => {
        message.textContent = `Uploading image… ${Math.round(snapshot.bytesTransferred / snapshot.totalBytes * 100)}%`;
      }, reject, resolve);
    });
    uploaded = true;
    const url = (await getDownloadURL(imageRef)).replace(/\(/g, "%28").replace(/\)/g, "%29");
    const insertion = `\n![${description}](${url})\n`;
    if (target.value.length - (end - start) + insertion.length > target.maxLength) throw new Error("image/length");
    if (!user || user.uid !== owner || !target.isConnected) throw new Error("image/access");
    await setDoc(documentRef, { kind: "file", name: file.name, parentId: "root", storagePath,
      size: file.size, contentType: file.type, createdAt: serverTimestamp(), createdBy: owner });
    recorded = true;
    target.setRangeText(insertion, start, end, "end");
    activeText = target;
    preview();
    $("quest-image-dialog").close();
    $("quest-editor-status").textContent = "Image inserted. Save the question to publish your changes.";
  } catch (error) {
    if (uploaded && !recorded) await deleteObject(imageRef).catch(() => {});
    console.error("Could not insert question image.", error);
    message.textContent = error.message === "image/invalid" ? "This file could not be read as an image. Try another file."
      : error.message === "image/length" ? "There is not enough space in this text field for the image. Shorten the text and try again."
      : error.message === "image/access" ? "Your editing access changed. Close the dialog and reload."
      : "Image upload failed. Your question is unchanged. Check your connection and Permanent Material permissions, then try again.";
  } finally {
    uploadingImage = false;
    $("quest-fields").disabled = false;
    for (const control of $("quest-image-form").elements) control.disabled = false;
    relabelOptions();
    if (!$("quest-image-dialog").open && target.isConnected) target.focus();
  }
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
