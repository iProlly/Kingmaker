import { createUserWithEmailAndPassword, deleteUser, onAuthStateChanged, signInWithEmailAndPassword, updateProfile } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { doc, getFirestore, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { auth } from "./firebase.js";
import { normalizeUsername, usernameToEmail } from "./username.js";

const db = getFirestore(auth.app);
const loginForm = document.querySelector("#login-form");
const signupForm = document.querySelector("#signup-form");
let authActionInProgress = false;

onAuthStateChanged(auth, user => {
  if (user && !authActionInProgress) window.location.replace("main.html");
});

function friendlyError(error) {
  const messages = {
    "auth/email-already-in-use": "That username is already taken.",
    "auth/invalid-credential": "Username or password is incorrect.",
    "auth/invalid-email": "Please enter a valid username.",
    "auth/weak-password": "Use a password with at least 6 characters.",
    "auth/too-many-requests": "Too many attempts. Please wait and try again."
  };
  return messages[error.code] || "Something went wrong. Please try again.";
}

async function submitWithState(form, messageElement, task) {
  const button = form.querySelector("button[type='submit']");
  messageElement.textContent = "";
  button.disabled = true;
  button.textContent = "Please wait…";
  authActionInProgress = true;
  try { await task(); }
  catch (error) { messageElement.textContent = friendlyError(error); }
  finally {
    authActionInProgress = false;
    button.disabled = false;
    button.textContent = form.id === "login-form" ? "Log in" : "Create account";
  }
}

if (loginForm) {
  loginForm.addEventListener("submit", event => {
    event.preventDefault();
    if (!loginForm.reportValidity()) return;
    const email = usernameToEmail(loginForm.elements.username.value);
    const password = loginForm.elements.password.value;
    submitWithState(loginForm, document.querySelector("#login-message"), async () => {
      await signInWithEmailAndPassword(auth, email, password);
      window.location.replace("main.html");
    });
  });
}

if (signupForm) {
  signupForm.addEventListener("submit", event => {
    event.preventDefault();
    if (!signupForm.reportValidity()) return;
    const name = signupForm.elements.name.value.trim();
    const username = normalizeUsername(signupForm.elements.username.value);
    const email = usernameToEmail(username);
    const password = signupForm.elements.password.value;
    submitWithState(signupForm, document.querySelector("#signup-message"), async () => {
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      try {
        await updateProfile(credential.user, { displayName: name });
        await setDoc(doc(db, "users", credential.user.uid), {
          displayName: name,
          username,
          role: "Guest",
          createdAt: serverTimestamp()
        });
      } catch (error) {
        await deleteUser(credential.user).catch(() => {});
        throw error;
      }
      window.location.replace("main.html");
    });
  });
}
