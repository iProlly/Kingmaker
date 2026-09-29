import { firebaseConfig } from "./firebase-config.js";

// Matches firebase-backend/functions/index.js. Use the deployed HTTPS function
// URL here if you later change the project, region, or function name.
export const PASSWORD_RESET_URL =
  `https://asia-southeast1-${firebaseConfig.projectId}.cloudfunctions.net/resetStudentPassword`;
