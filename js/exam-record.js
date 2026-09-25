import { collection, doc, getFirestore, getDoc, getDocsFromServer, onSnapshot, query, runTransaction, serverTimestamp, where } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { deleteObject, getDownloadURL, getStorage, ref, uploadBytesResumable } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
import { auth } from "./firebase.js";
import { requireUser } from "./protected.js";

const db = getFirestore(auth.app), storage = getStorage(auth.app);
const $ = id => document.getElementById(id);
const section = $("student-record-body").closest("details"), dialog = $("exam-dialog");
const fileTypes = { pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };
let master, active = false, generation = 0, students = [], exams = [], rosterReady = false, examsReady = false, loadError = "";
let statsTimer, statsRunning = false, statsAgain = false;
let unsubscribe = [], selection = null, busy = false, dirty = false;
const results = new Map();
const clone = value => JSON.parse(JSON.stringify(value));
const number = value => new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(value);
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
const scored = exam => exam.questions.filter(q => q.kind === "question");
const fullMark = exam => round(scored(exam).reduce((sum, q) => sum + q.max, 0));
const studentName = student => student.displayName || student.username || "Student";
function el(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
function button(text, callback, className = "button button-outline") { const b = el("button", text, className); b.type = "button"; b.addEventListener("click", callback); return b; }
function status(text = "", success = false) { $("exam-dialog-status").textContent = text; $("exam-dialog-status").classList.toggle("success", success); }
function validScore(value, maximum) { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum && Math.abs(round(value) - value) < 1e-8; }
function summary(exam, result) {
  const questions = scored(exam), marks = result?.marks || {};
  const marked = questions.filter(q => validScore(marks[q.id], q.max));
  return { count: marked.length, total: round(marked.reduce((sum, q) => sum + marks[q.id], 0)), maximum: fullMark(exam), complete: Boolean(result && result.rubricRevision === exam.rubricRevision && questions.length && marked.length === questions.length), review: Boolean(result && result.rubricRevision !== exam.rubricRevision) };
}
function statistics(exam) {
  const state = results.get(exam.id);
  if (!state?.ready || state.error || !rosterReady) return null;
  const totals = [...state.items.values()].map(r => summary(exam, r)).filter(s => s.complete).map(s => s.total);
  return { count: totals.length, max: totals.length ? Math.max(...totals) : null, min: totals.length ? Math.min(...totals) : null, mean: totals.length ? round(totals.reduce((a, b) => a + b, 0) / totals.length) : null };
}
function render() {
  scheduleStatistics();
  $("exam-add").disabled = !master || !examsReady || busy;
  $("exam-retry").hidden = !loadError && ![...results.values()].some(s => s.error);
  const failed = loadError || ([...results.values()].some(s => s.error) ? "Some marks could not load. Retry loading exams." : "");
  $("exam-status").textContent = failed || (!rosterReady || !examsReady ? "Loading exam records…" : !exams.length ? "No exams yet. Use + to add your first exam." : !students.length ? "No Chick students yet. You can still prepare exams." : "");
  $("exam-status").classList.toggle("is-error", Boolean(failed));
  const head = el("tr"), name = el("th", "Student"); name.scope = "col"; head.append(name);
  for (const exam of exams) {
    const th = el("th"); th.scope = "col";
    const open = button(exam.name, () => openDetails(exam.id), "exam-column-title");
    open.append(el("span", `(${number(fullMark(exam))} marks)`, "record-day-date"));
    open.setAttribute("aria-label", `${exam.name}, ${number(fullMark(exam))} marks. View exam details`);
    th.append(open); head.append(th);
  }
  const addHead = el("th"), add = button("+", () => openEditor(), "button button-outline"); addHead.scope = "col"; addHead.className = "exam-add-column"; add.setAttribute("aria-label", "Add exam column"); add.disabled = !master || !examsReady || busy; addHead.append(add); head.append(addHead);
  $("exam-head").replaceChildren(head);
  const rows = students.map(student => {
    const tr = el("tr"), name = el("th", studentName(student)); name.scope = "row";
    if (student.username) name.append(el("span", `@${student.username}`, "record-student-handle")); tr.append(name);
    for (const exam of exams) {
      const td = el("td"), state = results.get(exam.id);
      if (!state?.ready || state.error) td.append(el("span", state?.error ? "Unavailable" : "Loading…", "field-hint"));
      else {
        const result = state.items.get(student.id), score = summary(exam, result);
        const text = score.review ? "Review marks" : score.complete ? `${number(score.total)}/${number(score.maximum)}` : "Unmarked";
        const b = button(text, () => openMarking(exam.id, student.id), `exam-score${score.complete ? " is-marked" : ""}`);
        b.setAttribute("aria-label", `${studentName(student)}, ${exam.name}: ${text}`);
        if (!score.complete && !score.review && score.count) b.append(el("span", `${score.count}/${scored(exam).length} marked`, "field-hint"));
        td.append(b);
      }
      tr.append(td);
    }
    tr.append(el("td")); return tr;
  });
  $("exam-rows").replaceChildren(...rows);
  $("exam-table").style.minWidth = `${Math.max(450, 190 + exams.length * 175 + 70)}px`;
  if (dialog.open && selection?.mode === "details") renderDetails();
}
function stop() {
  active = false; generation++;
  unsubscribe.forEach(fn => fn()); unsubscribe = [];
  results.forEach(state => state.stop?.()); results.clear();
}
function start() {
  if (!master || active || !section.open) return;
  active = true; const token = ++generation;
  students = []; exams = []; rosterReady = false; examsReady = false; loadError = ""; render();
  const fail = () => { if (token !== generation) return; loadError = "Exam records could not load. Check your connection and Firestore rules, then retry."; render(); };
  unsubscribe.push(onSnapshot(query(collection(db, "users"), where("role", "==", "Chick")), snap => {
    if (token !== generation) return;
    students = snap.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => studentName(a).localeCompare(studentName(b), "th")); rosterReady = true; render();
  }, fail));
  unsubscribe.push(onSnapshot(collection(db, "exams"), { includeMetadataChanges: true }, snap => {
    if (token !== generation || snap.metadata.hasPendingWrites) return;
    exams = snap.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0) || a.id.localeCompare(b.id));
    examsReady = true;
    const ids = new Set(exams.map(e => e.id));
    for (const [id, state] of results) if (!ids.has(id)) { state.stop?.(); results.delete(id); }
    for (const exam of exams) if (!results.has(exam.id)) {
      const state = { ready: false, error: false, items: new Map() }; results.set(exam.id, state);
      state.stop = onSnapshot(collection(db, "exams", exam.id, "results"), { includeMetadataChanges: true }, scores => {
        if (token !== generation || scores.metadata.hasPendingWrites) return;
        state.items = new Map(scores.docs.map(d => [d.id, d.data()])); state.ready = true; state.error = false; render();
      }, () => { if (token !== generation) return; state.error = true; render(); });
    }
    render();
  }, fail));
}
function show(mode, title, eyebrow) {
  selection = { mode }; dirty = false; status(); $("exam-dialog-title").textContent = title; $("exam-dialog-eyebrow").textContent = eyebrow;
  $("exam-dialog-content").replaceChildren(); if (!dialog.open) dialog.showModal(); dialog.scrollTop = 0;
}
function openDetails(id) { show("details", "Exam", "EXAM DETAILS"); selection.id = id; renderDetails(); }
function renderDetails() {
  const exam = exams.find(e => e.id === selection?.id), content = $("exam-dialog-content");
  if (!exam) { content.replaceChildren(el("p", "This exam is no longer available. Close and retry loading.")); return; }
  $("exam-dialog-title").textContent = exam.name;
  const details = el("dl", undefined, "exam-details-grid");
  const pair = (key, value) => { const group = el("div"); group.append(el("dt", key), el("dd", value)); details.append(group); };
  pair("Topic", exam.topic || "—"); pair("Exam date", exam.date ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(exam.date + "T12:00:00Z")) : "Not set");
  pair("Duration", exam.durationMinutes ? `${exam.durationMinutes} minutes` : "Not set"); pair("Full mark", number(fullMark(exam)));
  const stats = statistics(exam), statGrid = el("div", undefined, "exam-stat-grid");
  for (const [label, key] of [["Maximum", "max"], ["Minimum", "min"], ["Mean", "mean"]]) { const box = el("div"); box.append(el("span", label), el("strong", stats ? stats[key] === null ? "—" : number(stats[key]) : "…")); statGrid.append(box); }
  const note = el("p", stats ? `Based on ${stats.count} fully marked ${stats.count === 1 ? "student" : "students"}. Unmarked and review-needed records are excluded.` : "Statistics are waiting for student marks to load.", "field-hint");
  content.replaceChildren(details, statGrid, note);
  if (exam.notes) content.append(el("p", exam.notes, "exam-notes"));
  const fileLine = el("div", undefined, "exam-file-line");
  if (exam.file) fileLine.append(button(`Open exam file · ${exam.file.name}`, event => openFile(exam.file, event.currentTarget)));
  else fileLine.append(el("p", "No exam file attached.", "field-hint"));
  content.append(fileLine, el("h3", "Question structure", "exam-small-heading"));
  const rubric = el("div", undefined, "exam-rubric-preview");
  for (const q of exam.questions) { const row = el("div", undefined, q.kind === "heading" ? "exam-rubric-heading" : "exam-rubric-item"); row.append(el("span", q.label)); if (q.kind === "question") row.append(el("span", `${number(q.max)} marks`)); rubric.append(row); }
  content.append(rubric, button("Edit exam", () => openEditor(exam), "button button-dark"));
}
async function openFile(file, control) {
  const tab = window.open("about:blank", "_blank");
  if (!tab) { status("Allow pop-ups for this site to open the exam file."); return; }
  tab.opener = null; control.disabled = true; status("Opening exam file…", true);
  try { const url = await getDownloadURL(ref(storage, file.path)); tab.location.replace(url); status(); }
  catch { tab.close(); status("Could not open the file. Check your connection and exam Storage rules."); }
  finally { control.disabled = false; }
}
function field(label, id, options = {}) {
  const wrap = el("div", undefined, "field"), input = el(options.multiline ? "textarea" : "input"); input.id = id;
  if (!options.multiline) input.type = options.type || "text";
  for (const key of ["maxLength", "min", "max", "step", "required", "value"]) if (options[key] !== undefined) input[key] = options[key];
  const title = el("label", label); title.htmlFor = id; wrap.append(title, input); return { wrap, input };
}
function openEditor(existing) {
  show("edit", existing ? "Edit exam" : "Add exam", "EXAM SETUP");
  const base = existing ? clone(existing) : null; selection.base = base;
  const form = el("form"); form.id = "exam-editor-form";
  const fields = el("fieldset"); fields.id = "exam-editor-fields"; fields.className = "exam-fieldset";
  const grid = el("div", undefined, "exam-form-grid");
  const name = field("Exam name", "exam-name", { required: true, maxLength: 160, value: base?.name || "" });
  const topic = field("Topic", "exam-topic", { maxLength: 500, value: base?.topic || "" });
  const date = field("Exam date (optional)", "exam-date", { type: "date", value: base?.date || "" });
  const duration = field("Duration in minutes (optional)", "exam-duration", { type: "number", min: 1, max: 10080, step: 1, value: base?.durationMinutes || "" });
  grid.append(name.wrap, topic.wrap, date.wrap, duration.wrap);
  const notes = field("Other details (optional)", "exam-notes", { multiline: true, maxLength: 5000, value: base?.notes || "" }); notes.input.rows = 3;
  const file = field(base?.file ? `Replace exam file (current: ${base.file.name})` : "Exam file (optional)", "exam-file", { type: "file" }); file.input.accept = ".pdf,.doc,.docx,.png,.jpg,.jpeg";
  file.wrap.append(el("p", "PDF, Word, PNG or JPEG · up to 20 MB. Only Masters can access exam records.", "field-hint"));
  fields.append(grid, notes.wrap, file.wrap);
  let removeFile;
  if (base?.file) { const label = el("label", undefined, "exam-checkbox"); removeFile = el("input"); removeFile.type = "checkbox"; removeFile.id = "exam-remove-file"; label.append(removeFile, document.createTextNode(" Remove current attachment")); fields.append(label); }
  fields.append(el("h3", "Question structure", "exam-small-heading"), el("p", "Add one row for each scored question or part: 1, 1a, 1b, 2a… Use Heading only for a group title that should not count toward the total. Scores can have up to two decimal places.", "field-hint"));
  if (base) fields.append(el("p", "Changing this structure keeps existing marks but requires reviewing each student’s record before their total appears again.", "exam-edit-notice"));
  const rows = el("div"); rows.id = "exam-question-rows";
  const total = el("p", undefined, "quest-day-score"); total.id = "exam-full-mark"; total.setAttribute("aria-live", "polite");
  let items = clone(base?.questions || [{ id: crypto.randomUUID(), label: "1", kind: "question", max: 1 }]);
  function updateTotal() { const value = items.filter(q => q.kind === "question").reduce((sum, q) => sum + (Number(q.max) || 0), 0); total.textContent = `Full mark: ${number(round(value))}`; }
  function renderRows() {
    rows.replaceChildren();
    items.forEach((q, index) => {
      const row = el("div", undefined, "exam-question-row");
      const label = field("Question / part", `exam-q-${q.id}`, { required: true, maxLength: 80, value: q.label });
      label.input.addEventListener("input", () => q.label = label.input.value);
      const kindWrap = el("div", undefined, "field"), kindLabel = el("label", "Row type"), kind = el("select"); kind.id = `exam-kind-${q.id}`; kindLabel.htmlFor = kind.id;
      for (const [value, text] of [["question", "Scored question"], ["heading", "Heading only"]]) { const option = el("option", text); option.value = value; kind.append(option); } kind.value = q.kind; kindWrap.append(kindLabel, kind);
      const maximum = field("Maximum score", `exam-max-${q.id}`, { type: "number", min: .01, max: 10000, step: .01, required: q.kind === "question", value: q.kind === "question" ? q.max : "" }); maximum.input.disabled = q.kind === "heading";
      maximum.input.addEventListener("input", () => { q.max = maximum.input.value; updateTotal(); });
      kind.addEventListener("change", () => { q.kind = kind.value; q.max = q.kind === "heading" ? 0 : 1; renderRows(); });
      const controls = el("div", undefined, "exam-row-controls");
      const up = button("↑", () => { [items[index - 1], items[index]] = [items[index], items[index - 1]]; dirty = true; renderRows(); }); up.disabled = index === 0; up.setAttribute("aria-label", `Move row ${index + 1} up`);
      const down = button("↓", () => { [items[index + 1], items[index]] = [items[index], items[index + 1]]; dirty = true; renderRows(); }); down.disabled = index === items.length - 1; down.setAttribute("aria-label", `Move row ${index + 1} down`);
      const remove = button("×", () => { items = items.filter(item => item.id !== q.id); dirty = true; renderRows(); }); remove.setAttribute("aria-label", `Remove row ${index + 1}`);
      controls.append(up, down, remove); row.append(label.wrap, kindWrap, maximum.wrap, controls); rows.append(row);
    });
    updateTotal();
  }
  renderRows();
  const add = button("+ Add question / part", () => { if (items.length >= 100) { status("An exam can contain up to 100 rows."); return; } items.push({ id: crypto.randomUUID(), label: "", kind: "question", max: 1 }); dirty = true; renderRows(); rows.lastElementChild.querySelector("input").focus(); }); add.id = "exam-add-question";
  fields.append(rows, add, total);
  const save = el("button", "Save exam", "button button-dark"); save.type = "submit"; save.id = "exam-save"; fields.append(save); form.append(fields);
  form.addEventListener("input", () => dirty = true); form.addEventListener("change", () => dirty = true);
  form.addEventListener("submit", async event => {
    event.preventDefault(); if (busy || !master || !form.reportValidity()) return;
    const questions = items.map(q => ({ id: q.id, label: q.label.trim(), kind: q.kind, max: q.kind === "heading" ? 0 : Number(q.max) }));
    const labels = questions.map(q => q.label.toLocaleLowerCase());
    if (!name.input.value.trim() || !questions.length || questions.length > 100 || questions.some(q => !q.label) || new Set(labels).size !== labels.length) { status("Enter an exam name and unique labels for each question or heading."); return; }
    if (!questions.some(q => q.kind === "question") || questions.some(q => q.kind === "question" && (!validScore(q.max, 10000) || q.max <= 0))) { status("Add at least one scored question. Each maximum must be greater than 0, up to 10,000, with at most two decimal places."); return; }
    const chosen = file.input.files[0], extension = chosen?.name.split(".").pop().toLowerCase();
    if (chosen && (!fileTypes[extension] || chosen.size > 20 * 1024 * 1024 || chosen.size === 0)) { status("Choose a non-empty PDF, Word, PNG or JPEG file up to 20 MB."); return; }
    const examRef = base ? doc(db, "exams", base.id) : doc(collection(db, "exams"));
    const rubricChanged = !base || questions.length !== base.questions.length || questions.some((q, i) => ["id", "label", "kind", "max"].some(key => q[key] !== base.questions[i][key]));
    const payload = { name: name.input.value.trim(), topic: topic.input.value.trim(), date: date.input.value, durationMinutes: Number(duration.input.value) || 0, notes: notes.input.value.trim(), questions,
      rubricRevision: base ? base.rubricRevision + (rubricChanged ? 1 : 0) : 1, revision: (base?.revision || 0) + 1, file: removeFile?.checked ? null : base?.file || null,
      updatedAt: serverTimestamp(), updatedBy: master.uid };
    let uploadedPath, committed = false;
    setBusy(true); fields.disabled = true; status("Saving exam…", true);
    try {
      if (chosen) {
        uploadedPath = `exam-files/${examRef.id}/${crypto.randomUUID()}.${extension}`;
        await uploadFile(chosen, uploadedPath, fileTypes[extension]);
        payload.file = { name: chosen.name, path: uploadedPath, size: chosen.size, contentType: fileTypes[extension] };
      }
      await runTransaction(db, async tx => {
        const current = await tx.get(examRef);
        if (base ? !current.exists() || current.data().revision !== base.revision : current.exists()) throw new Error("exam/conflict");
        tx.set(examRef, { ...payload, createdAt: current.exists() ? current.data().createdAt : serverTimestamp(), createdBy: current.exists() ? current.data().createdBy : master.uid });
      });
      committed = true; dirty = false;
      const saved = { ...base, ...payload, id: examRef.id, createdAt: base?.createdAt || { seconds: Date.now() / 1000 } };
      const index = exams.findIndex(e => e.id === examRef.id); if (index === -1) exams.push(saved); else if (exams[index].revision <= saved.revision) exams[index] = saved;
      if (base?.file && base.file.path !== payload.file?.path) await deleteObject(ref(storage, base.file.path)).catch(() => {});
      setBusy(false); openDetails(examRef.id); render(); status("Exam saved.", true);
      if (!base) $("exam-table-scroll").scrollLeft = $("exam-table-scroll").scrollWidth;
    } catch (error) {
      if (uploadedPath && !committed) await deleteObject(ref(storage, uploadedPath)).catch(() => {});
      status(error.message === "exam/conflict" ? "This exam was edited elsewhere. Your changes have not been saved. Copy them, then close and reopen the exam to use its latest version." : "The exam was not saved. Your entries are still here. Check your connection and Firestore/Storage rules, then retry.");
    } finally { setBusy(false); fields.disabled = false; }
  });
  $("exam-dialog-content").append(form); name.input.focus();
}
function uploadFile(file, path, contentType) {
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(ref(storage, path), file, { contentType });
    task.on("state_changed", snap => status(`Uploading exam file… ${Math.round(snap.bytesTransferred / snap.totalBytes * 100)}%`, true), reject, resolve);
  });
}
function openMarking(examId, studentId) {
  const exam = exams.find(e => e.id === examId), student = students.find(s => s.id === studentId), state = results.get(examId);
  if (!exam || !student || !state?.ready || state.error) return;
  const base = clone(exam), prior = state.items.has(studentId) ? clone(state.items.get(studentId)) : null;
  show("mark", studentName(student), "EXAM MARKING"); selection.examId = examId; selection.studentId = studentId;
  const content = $("exam-dialog-content"), subtitle = el("p", base.name, "exam-mark-subtitle");
  const form = el("form"); form.id = "exam-mark-form";
  const fields = el("fieldset", undefined, "exam-fieldset"); fields.id = "exam-mark-fields";
  const inputs = new Map(), total = el("p", undefined, "quest-day-score"); total.id = "exam-mark-total"; total.setAttribute("aria-live", "polite");
  const progress = el("p", undefined, "field-hint"); progress.id = "exam-mark-progress";
  content.append(subtitle, total, progress);
  if (prior && prior.rubricRevision !== base.rubricRevision) content.append(el("p", "The question structure changed. Review the retained marks below, fill in new parts, then save. Removed parts no longer count.", "exam-edit-notice"));
  const rows = el("div", undefined, "exam-mark-rows");
  for (const q of base.questions) {
    if (q.kind === "heading") { rows.append(el("h3", q.label, "exam-rubric-heading")); continue; }
    const row = el("div", undefined, "exam-mark-row"), title = el("label", q.label); title.htmlFor = `exam-score-${q.id}`;
    const wrap = el("div", undefined, "exam-mark-input"), input = el("input");
    input.id = title.htmlFor; input.type = "number"; input.min = "0"; input.max = String(q.max); input.step = "0.01"; input.inputMode = "decimal"; input.placeholder = "Unmarked"; input.setAttribute("aria-label", `Score for ${q.label}, out of ${number(q.max)}`);
    const old = prior?.marks?.[q.id]; if (typeof old === "number") input.value = String(old);
    wrap.append(input, el("span", `/ ${number(q.max)}`)); row.append(title, wrap);
    if (old !== undefined && old !== null && !validScore(old, q.max)) row.append(el("p", `Previous score: ${number(old)}. Enter a score within the new maximum.`, "exam-score-warning"));
    rows.append(row); inputs.set(q.id, input);
  }
  function readMarks() { return Object.fromEntries([...inputs].filter(([, input]) => input.value.trim() !== "").map(([id, input]) => [id, Number(input.value)])); }
  function updateTotal() {
    const marks = readMarks(), s = summary(base, { marks, rubricRevision: base.rubricRevision });
    total.textContent = `${s.complete ? "Score" : "Score so far"}: ${number(s.total)}/${number(s.maximum)}`;
    progress.textContent = `${s.count}/${scored(base).length} marked. Leave a score blank to keep it unmarked; enter 0 for zero marks.`;
  }
  updateTotal(); fields.append(rows);
  const save = el("button", "Save marks", "button button-dark"); save.id = "exam-save-marks"; save.type = "submit"; fields.append(save); form.append(fields);
  form.addEventListener("input", () => { dirty = true; updateTotal(); });
  form.addEventListener("submit", async event => {
    event.preventDefault(); if (busy || !master || !form.reportValidity()) return;
    const marks = readMarks(); if (scored(base).some(q => marks[q.id] !== undefined && !validScore(marks[q.id], q.max))) { status("Enter scores between 0 and each question’s maximum, with at most two decimal places."); return; }
    const reference = doc(db, "exams", examId, "results", studentId);
    const data = { marks, rubricRevision: base.rubricRevision, revision: (prior?.revision || 0) + 1, updatedAt: serverTimestamp(), updatedBy: master.uid };
    setBusy(true); fields.disabled = true; status("Saving marks…", true);
    try {
      await runTransaction(db, async tx => {
        const latestExam = await tx.get(doc(db, "exams", examId)), latest = await tx.get(reference);
        const statsRef = doc(db, "examStatisticsState", examId), statsState = await tx.get(statsRef);
        if (!latestExam.exists() || latestExam.data().rubricRevision !== base.rubricRevision) throw new Error("exam/rubric-changed");
        if ((latest.exists() ? latest.data().revision : 0) !== (prior?.revision || 0)) throw new Error("exam/marks-changed");
        tx.set(reference, data);
        tx.set(statsRef, { version: (statsState.exists() ? statsState.data().version : 0) + 1 });
      });
      const cached = results.get(examId)?.items;
      if (cached && (cached.get(studentId)?.revision || 0) <= data.revision) cached.set(studentId, data);
      const statisticsSaved = await publishStatistics(examId).then(() => true, () => false);
      dirty = false; setBusy(false); render(); openMarking(examId, studentId);
      status(!statisticsSaved ? "Marks saved. Student statistics could not refresh; use Retry loading exams." : summary(base, data).complete ? "Marks saved. This total now counts toward exam statistics." : "Progress saved. This student stays unmarked until every scored part has a score.", true);
    } catch (error) {
      status(error.message === "exam/rubric-changed" ? "The question structure changed while you were marking. Your entries were not saved. Copy them, then close and reopen to review the latest exam."
        : error.message === "exam/marks-changed" ? "Another Master updated these marks. Your entries were not saved. Copy them, then close and reopen to see the latest marks."
        : "Marks were not saved. Your entries are still here. Check your connection and Firestore rules, then retry.");
    } finally { setBusy(false); fields.disabled = false; }
  });
  content.append(form); inputs.values().next().value?.focus();
}
function setBusy(value) { busy = value; $("exam-dialog-close").disabled = value; $("exam-add").disabled = value || !master || !examsReady; }
function canClose() { return !busy && (!dirty || window.confirm("Discard your unsaved changes?")); }
$("exam-dialog-close").addEventListener("click", () => { if (canClose()) dialog.close(); });
dialog.addEventListener("cancel", event => { if (!canClose()) event.preventDefault(); });
dialog.addEventListener("close", () => { selection = null; dirty = false; });
$("exam-add").addEventListener("click", () => { if (master && examsReady && !busy) openEditor(); });
$("exam-retry").addEventListener("click", () => { stop(); start(); });
section.addEventListener("toggle", () => { if (section.open) start(); else stop(); });
window.addEventListener("beforeunload", event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("pagehide", stop);
window.addEventListener("pageshow", () => { if (!active) start(); });

// Publish aggregate values only. Individual result documents remain private.
const statisticsNotice = el("p", "", "field-hint"); statisticsNotice.id = "exam-statistics-sync";
$("exam-status").after(statisticsNotice);
function scheduleStatistics() {
  if (!active || !master || !examsReady) return;
  clearTimeout(statsTimer);
  statsTimer = setTimeout(syncStatistics, 400);
}
async function publishStatistics(examId) {
      // Read the version before fetching results. Any mark written during the
      // fetch or transaction changes it, preventing publication of stale totals.
      let published = false;
      for (let attempt = 0; attempt < 3 && !published; attempt++) {
        const stateRef = doc(db, "examStatisticsState", examId);
        const before = await getDoc(stateRef), version = before.exists() ? before.data().version : 0;
        const all = await getDocsFromServer(collection(db, "exams", examId, "results"));
        try {
          await runTransaction(db, async tx => {
            const currentState = await tx.get(stateRef), currentExam = await tx.get(doc(db, "exams", examId));
            if (!currentExam.exists()) return;
            if ((currentState.exists() ? currentState.data().version : 0) !== version) throw new Error("statistics/changed");
            const data = currentExam.data();
            const totals = all.docs.map(d => summary(data, d.data())).filter(s => s.complete).map(s => s.total);
            tx.set(doc(db, "examStatistics", examId), { rubricRevision: data.rubricRevision, count: totals.length,
              max: totals.length ? Math.max(...totals) : null, min: totals.length ? Math.min(...totals) : null,
              mean: totals.length ? round(totals.reduce((a,b)=>a+b,0)/totals.length) : null,
              updatedAt: serverTimestamp(), updatedBy: master.uid });
          });
          published = true;
        } catch (error) { if (error.message !== "statistics/changed") throw error; }
      }
      if (!published) throw new Error("statistics/busy");
}
async function syncStatistics() {
  if (!active || !master) return;
  if (statsRunning) { statsAgain = true; return; }
  statsRunning = true; const token = generation;
  try {
    for (const exam of [...exams]) {
      if (token !== generation) break;
      const state = results.get(exam.id); if (!state?.ready || state.error) continue;
      await publishStatistics(exam.id);
    }
    if (token === generation) statisticsNotice.textContent = "";
  } catch {
    if (token === generation) { statisticsNotice.textContent = "Student statistics could not refresh. Use Retry loading exams to try again."; $("exam-retry").hidden = false; }
  } finally { statsRunning = false; if (statsAgain) { statsAgain = false; scheduleStatistics(); } }
}

requireUser((user, role) => { stop(); master = role === "Master" ? user : null; if (master) start(); else if (dialog.open) dialog.close(); });
