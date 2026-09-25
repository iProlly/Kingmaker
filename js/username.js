const USERNAME_DOMAIN = "kingmaker-2e770.firebaseapp.com";

export function normalizeUsername(username) {
  return username.trim().toLowerCase();
}

export function usernameToEmail(username) {
  return `${normalizeUsername(username)}@${USERNAME_DOMAIN}`;
}

export function emailToUsername(email = "") {
  return email.split("@")[0] || "student";
}
