import { requireUser, setupAccountMenu } from "./protected.js";

setupAccountMenu();
requireUser(user => { document.querySelector("#student-name").textContent = (user.displayName || "learner").split(" ")[0]; });

const now = new Date();
document.querySelector("#date-label").textContent = new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric" }).format(now).toUpperCase();
document.querySelector("#time-greeting").textContent = now.getHours() < 12 ? "morning" : now.getHours() < 18 ? "afternoon" : "evening";

const startKey = "formPracticeStarted";
let started = localStorage.getItem(startKey);
if (!started) { started = now.toISOString(); localStorage.setItem(startKey, started); }
const day = Math.max(1, Math.floor((now - new Date(started)) / 86400000) + 1);
document.querySelector("#day-number").textContent = String(day).padStart(2, "0");

const completeButton = document.querySelector("#complete-focus");
const completeKey = `formFocus-${now.toISOString().slice(0, 10)}`;
function showCompletion(done) {
  completeButton.classList.toggle("is-complete", done);
  completeButton.setAttribute("aria-pressed", String(done));
  completeButton.querySelector(".complete-text").textContent = done ? "Completed" : "Mark complete";
}
showCompletion(localStorage.getItem(completeKey) === "true");
completeButton.addEventListener("click", () => {
  const done = completeButton.getAttribute("aria-pressed") !== "true";
  localStorage.setItem(completeKey, String(done));
  showCompletion(done);
});

const reflection = document.querySelector("#reflection-input");
const reflectionKey = `formReflection-${now.toISOString().slice(0, 10)}`;
reflection.value = localStorage.getItem(reflectionKey) || "";
document.querySelector("#save-reflection").addEventListener("click", () => {
  localStorage.setItem(reflectionKey, reflection.value.trim());
  const status = document.querySelector("#reflection-status");
  status.textContent = "Saved just now";
  setTimeout(() => { status.textContent = "Saved on this device"; }, 1800);
});
