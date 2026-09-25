import { collection, doc, getDocs, getFirestore, updateDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { auth } from "./firebase.js";
import { requireUser, setupAccountMenu } from "./protected.js";

const db = getFirestore(auth.app);
const roles = ["Master", "King", "Chick", "Guest"];
const accessStatus = document.querySelector("#manage-access-status");
const managePage = document.querySelector("#manage-page");
const userList = document.querySelector("#user-list");
const userCount = document.querySelector("#user-count");
const managementStatus = document.querySelector("#management-status");

setupAccountMenu();

function setStatus(message, isError = false) {
  managementStatus.textContent = message;
  managementStatus.classList.toggle("is-error", isError);
}

function createUserRow(userDocument, currentUserId) {
  const account = userDocument.data();
  const displayName = account.displayName || "Learner";
  const username = account.username || "student";
  const currentRole = roles.includes(account.role) ? account.role : "Guest";

  const row = document.createElement("article");
  row.className = "user-row";

  const identity = document.createElement("div");
  identity.className = "managed-user";

  const avatar = document.createElement("span");
  avatar.className = "managed-user-avatar";
  avatar.textContent = displayName.charAt(0).toUpperCase();
  avatar.setAttribute("aria-hidden", "true");

  const text = document.createElement("div");
  const name = document.createElement("p");
  name.className = "managed-user-name";
  name.textContent = displayName;
  const handle = document.createElement("p");
  handle.className = "managed-user-username";
  handle.textContent = `@${username}`;
  text.append(name, handle);
  identity.append(avatar, text);

  const select = document.createElement("select");
  select.className = "role-select";
  select.setAttribute("aria-label", `Role for ${displayName}`);
  roles.forEach(role => {
    const option = document.createElement("option");
    option.value = role;
    option.textContent = role;
    option.selected = role === currentRole;
    select.append(option);
  });

  select.addEventListener("change", async () => {
    const previousRole = account.role;
    const nextRole = select.value;
    select.disabled = true;
    setStatus(`Saving ${displayName}’s role…`);

    try {
      await updateDoc(doc(db, "users", userDocument.id), { role: nextRole });
      account.role = nextRole;
      setStatus(`${displayName} is now ${nextRole}.`);
      if (userDocument.id === currentUserId && nextRole !== "Master") {
        window.location.replace("main.html");
      }
    } catch (error) {
      console.error("Could not update role.", error);
      select.value = roles.includes(previousRole) ? previousRole : "Guest";
      setStatus("The role could not be changed. Please try again.", true);
    } finally {
      select.disabled = false;
    }
  });

  row.append(identity, select);
  return row;
}

async function loadUsers(currentUserId) {
  setStatus("Loading users…");

  try {
    const snapshot = await getDocs(collection(db, "users"));
    const documents = [...snapshot.docs].sort((a, b) => {
      const first = (a.data().displayName || "").toLowerCase();
      const second = (b.data().displayName || "").toLowerCase();
      return first.localeCompare(second);
    });

    userList.replaceChildren(...documents.map(user => createUserRow(user, currentUserId)));
    userCount.textContent = `${documents.length} ${documents.length === 1 ? "user" : "users"}`;
    setStatus(documents.length ? "" : "No users have joined yet.");
  } catch (error) {
    console.error("Could not load users.", error);
    userCount.textContent = "Unavailable";
    setStatus("Users could not be loaded. Check your Firestore rules.", true);
  }
}

requireUser(async (user, role) => {
  if (role !== "Master") {
    window.location.replace("main.html");
    return;
  }

  accessStatus.hidden = true;
  managePage.hidden = false;
  await loadUsers(user.uid);
});
