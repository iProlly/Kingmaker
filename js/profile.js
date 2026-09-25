import { updateProfile } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { doc, getFirestore, updateDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { auth } from "./firebase.js";
import { requireUser, setupAccountMenu } from "./protected.js";
import { emailToUsername } from "./username.js";

const db = getFirestore(auth.app);

setupAccountMenu();
let currentUser;

requireUser((user, role) => {
  currentUser = user;
  const name = user.displayName || "Learner";
  const username = emailToUsername(user.email);
  document.querySelector("#profile-title").textContent = name;
  document.querySelector("#display-name").value = name;
  document.querySelector("#profile-username").textContent = `@${username}`;
  const accountUsername = document.querySelector("#account-username");
  if (accountUsername) accountUsername.textContent = username;
  document.querySelector("#learning-goal").value = localStorage.getItem(`formGoal-${user.uid}`) || "";
  const roleElement = document.querySelector("#profile-role");
  roleElement.textContent = role;
  roleElement.setAttribute("aria-label", `Role: ${role}`);
});

document.querySelector("#profile-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity() || !currentUser) return;
  const button = event.currentTarget.querySelector("button[type='submit']");
  const message = document.querySelector("#profile-message");
  const displayName = document.querySelector("#display-name").value.trim();
  button.disabled = true;
  message.textContent = "";
  try {
    await updateProfile(currentUser, { displayName });
    await updateDoc(doc(db, "users", currentUser.uid), { displayName });
    localStorage.setItem(`formGoal-${currentUser.uid}`, document.querySelector("#learning-goal").value.trim());
    document.querySelector("#profile-title").textContent = displayName;
    document.querySelectorAll("#header-initial, #profile-initial").forEach(el => { el.textContent = displayName.charAt(0).toUpperCase(); });
    message.textContent = "Profile saved.";
    message.classList.add("success");
  } catch { message.textContent = "Could not save your profile. Please try again."; }
  finally { button.disabled = false; }
});
