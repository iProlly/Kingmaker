import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { doc, getDoc, getFirestore, serverTimestamp, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { auth } from "./firebase.js";
import { emailToUsername } from "./username.js";

const db = getFirestore(auth.app);
const validRoles = new Set(["Guest", "Chick", "King", "Master"]);
const materialRoles = new Set(["Chick", "King", "Master"]);

async function getUserRole(user) {
  const userDocument = doc(db, "users", user.uid);
  const username = emailToUsername(user.email);
  const displayName = user.displayName || "Learner";
  const snapshot = await getDoc(userDocument);

  if (!snapshot.exists()) {
    await setDoc(userDocument, {
      displayName,
      username,
      role: "Guest",
      createdAt: serverTimestamp()
    });
    return "Guest";
  }

  const account = snapshot.data();
  const missingProfile = {};
  if (typeof account.displayName !== "string") missingProfile.displayName = displayName;
  if (typeof account.username !== "string") missingProfile.username = username;
  if (Object.keys(missingProfile).length) await updateDoc(userDocument, missingProfile);

  return validRoles.has(account.role) ? account.role : "Guest";
}

function updateRoleNavigation(role) {
  const isMaster = role === "Master";
  const canViewRecords = ["Chick", "King"].includes(role);
  document.querySelectorAll(".desktop-nav, .mobile-nav").forEach(nav => {
    let link = nav.querySelector('[data-records-access]');
    if (!link) {
      link = document.createElement("a"); link.href = "records.html"; link.dataset.recordsAccess = "";
      if (nav.classList.contains("mobile-nav")) {
        const icon = document.createElement("span"); icon.setAttribute("aria-hidden", "true");
        icon.textContent = location.pathname.endsWith("/records.html") ? "●" : "○"; link.append(icon);
      }
      link.append(document.createTextNode("Records"));
      const profile = nav.querySelector('a[href="profile.html"]');
      if (profile) profile.after(link); else nav.append(link);
    }
    link.hidden = !canViewRecords;
    link.classList.toggle("is-active", location.pathname.endsWith("/records.html"));
    if (nav.classList.contains("mobile-nav")) nav.style.gridTemplateColumns = canViewRecords ? "repeat(4, 1fr)" : "";
  });
  const canAccessMaterial = materialRoles.has(role);
  document.querySelectorAll("[data-master-only]").forEach(element => { element.hidden = !isMaster; });
  document.querySelectorAll("[data-material-access]").forEach(element => { element.hidden = !canAccessMaterial; });

  const mobileNavigation = document.querySelector(".mobile-nav");
  mobileNavigation?.classList.toggle("has-material", canAccessMaterial && !isMaster);
  mobileNavigation?.classList.toggle("has-manage", isMaster);
}

export function requireUser(onReady) {
  return onAuthStateChanged(auth, async user => {
    if (!user) { window.location.replace("index.html"); return; }
    const name = user.displayName || "Learner";
    document.querySelectorAll("#header-initial, #profile-initial").forEach(el => { el.textContent = name.charAt(0).toUpperCase(); });
    const menuUsername = document.querySelector("#menu-username");
    if (menuUsername) menuUsername.textContent = `@${emailToUsername(user.email)}`;

    let role = "Guest";
    try {
      role = await getUserRole(user);
    } catch (error) {
      console.error("Could not load the account role.", error);
    }

    updateRoleNavigation(role);
    await onReady?.(user, role);
  });
}

export function setupAccountMenu() {
  const button = document.querySelector("#profile-menu-button");
  const menu = document.querySelector("#account-menu");
  if (button && menu) {
    button.addEventListener("click", () => {
      const opening = menu.hidden;
      menu.hidden = !opening;
      button.setAttribute("aria-expanded", String(opening));
    });
    document.addEventListener("click", event => {
      if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) {
        menu.hidden = true;
        button.setAttribute("aria-expanded", "false");
      }
    });
  }
  document.querySelectorAll("#logout-button, #page-logout-button").forEach(logout => {
    logout.addEventListener("click", async () => { await signOut(auth); window.location.replace("index.html"); });
  });
}
