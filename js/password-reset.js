import { normalizeUsername } from "./username.js";
import { PASSWORD_RESET_URL } from "./password-reset-config.js";

const usernameForm = document.querySelector("#reset-username-form");
const passwordForm = document.querySelector("#reset-password-form");
const usernameInput = document.querySelector("#reset-username");
const passwordInput = document.querySelector("#reset-new-password");
const confirmInput = document.querySelector("#reset-confirm-password");
const fields = document.querySelector("#reset-password-fields");
const submitButton = document.querySelector("#reset-submit");
const message = document.querySelector("#reset-message");
let selectedUsername = "";
let busy = false;

function showMessage(text = "", state = "error") {
  message.textContent = text;
  message.dataset.state = state;
}

function clearPasswords() {
  passwordForm.reset();
  confirmInput.setCustomValidity("");
  for (const input of [passwordInput, confirmInput]) input.type = "password";
  for (const button of document.querySelectorAll("[data-reset-toggle]")) {
    button.textContent = "Show";
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", button.dataset.resetToggle === "reset-new-password"
      ? "Show new password" : "Show confirmed password");
  }
}

usernameForm.addEventListener("submit", event => {
  event.preventDefault();
  usernameInput.value = normalizeUsername(usernameInput.value);
  if (!usernameForm.reportValidity()) return;
  selectedUsername = usernameInput.value;
  document.querySelector("#reset-account").textContent = `@${selectedUsername}`;
  showMessage();
  usernameForm.hidden = true;
  passwordForm.hidden = false;
  passwordInput.focus();
});

document.querySelector("#reset-change-username").addEventListener("click", () => {
  if (busy) return;
  clearPasswords();
  showMessage();
  passwordForm.hidden = true;
  usernameForm.hidden = false;
  selectedUsername = "";
  usernameInput.focus();
});

for (const input of [passwordInput, confirmInput]) {
  input.addEventListener("input", () => {
    confirmInput.setCustomValidity("");
    showMessage();
  });
}

for (const button of document.querySelectorAll("[data-reset-toggle]")) {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.resetToggle);
    const show = input.type === "password";
    const label = input === passwordInput ? "new password" : "confirmed password";
    input.type = show ? "text" : "password";
    button.textContent = show ? "Hide" : "Show";
    button.setAttribute("aria-label", `${show ? "Hide" : "Show"} ${label}`);
    button.setAttribute("aria-pressed", String(show));
  });
}

passwordForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || !selectedUsername) return;
  confirmInput.setCustomValidity("");
  if (!passwordForm.reportValidity()) return;
  if (passwordInput.value !== confirmInput.value) {
    confirmInput.setCustomValidity("The passwords do not match.");
    showMessage("The passwords do not match. Please enter the same password twice.");
    confirmInput.reportValidity();
    return;
  }

  // Capture the values before disabling fields. Passwords are sent in the
  // HTTPS request body only, never in the URL, storage, or console logs.
  const payload = {
    username: selectedUsername,
    password: passwordInput.value,
    confirmPassword: confirmInput.value
  };
  busy = true;
  fields.disabled = true;
  passwordForm.setAttribute("aria-busy", "true");
  submitButton.textContent = "Saving…";
  showMessage("Saving your new password…", "pending");
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 45000);

  try {
    const response = await fetch(PASSWORD_RESET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      cache: "no-store",
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok !== true) {
      const errorMessages = {
        "invalid-username": "Please go back and enter a valid username.",
        "user-not-found": "That username was not found. Select Change username and check the spelling.",
        "invalid-password": "Use a password with 6–128 characters.",
        "password-mismatch": "The passwords do not match. Please enter the same password twice.",
        "password-policy": "Please choose a stronger password and try again.",
        "too-many-requests": "Too many attempts. Please wait a moment and try again."
      };
      throw new Error(errorMessages[result?.code]
        || "Password reset is unavailable right now. Please try again later or contact your teacher.");
    }
    clearPasswords();
    showMessage();
    passwordForm.hidden = true;
    document.querySelector("#reset-back-link").hidden = true;
    document.querySelector("#reset-success").hidden = false;
    document.querySelector("#reset-success-title").focus();
    selectedUsername = "";
  } catch (error) {
    if (error.name === "AbortError") {
      showMessage("The request took too long. Try logging in with your new password first; if it does not work, try resetting again.");
    } else if (error instanceof TypeError) {
      showMessage("Could not reach password reset. Check your connection and try again, or contact your teacher.");
    } else {
      showMessage(error.message);
    }
  } finally {
    window.clearTimeout(timer);
    busy = false;
    fields.disabled = false;
    passwordForm.removeAttribute("aria-busy");
    submitButton.textContent = "Save new password";
  }
});

document.querySelector("#reset-continue").disabled = false;
