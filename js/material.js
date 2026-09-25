import { collection, doc, getDocs, getFirestore, onSnapshot, query, serverTimestamp, setDoc, where, writeBatch } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { deleteObject, getDownloadURL, getStorage, ref, uploadBytesResumable } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
import { auth } from "./firebase.js";
import { requireUser, setupAccountMenu } from "./protected.js";

const db = getFirestore(auth.app);
const storage = getStorage(auth.app);
const maximumFileSize = 100 * 1024 * 1024;
const materialCollection = "permanentMaterialItems";
const materialRoles = new Set(["Chick", "King", "Master"]);
const allowedFileTypes = new Map([
  ["pdf", "application/pdf"],
  ["doc", "application/msword"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["ppt", "application/vnd.ms-powerpoint"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ["xls", "application/vnd.ms-excel"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["txt", "text/plain"],
  ["csv", "text/csv"],
  ["md", "text/markdown"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["m4a", "audio/mp4"],
  ["mp4", "video/mp4"],
  ["mov", "video/quicktime"],
  ["webm", "video/webm"],
  ["zip", "application/zip"]
]);

const accessStatus = document.querySelector("#material-access-status");
const materialPage = document.querySelector("#material-page");
const breadcrumbs = document.querySelector("#material-breadcrumbs");
const materialItems = document.querySelector("#material-items");
const materialEmpty = document.querySelector("#material-empty");
const materialStatus = document.querySelector("#material-status");
const addFolderButton = document.querySelector("#add-folder-button");
const addFilesButton = document.querySelector("#add-files-button");
const fileInput = document.querySelector("#material-file-input");
const folderDialog = document.querySelector("#folder-dialog");
const folderForm = document.querySelector("#folder-form");
const folderNameInput = document.querySelector("#folder-name");
const folderMessage = document.querySelector("#folder-message");
const cancelFolderButton = document.querySelector("#cancel-folder-button");
const uploadPanel = document.querySelector("#material-upload");
const uploadLabel = document.querySelector("#material-upload-label");
const uploadPercent = document.querySelector("#material-upload-percent");
const uploadProgress = document.querySelector("#material-upload-progress");
const deleteDialog = document.querySelector("#delete-dialog");
const deleteForm = document.querySelector("#delete-form");
const deleteDialogTitle = document.querySelector("#delete-dialog-title");
const deleteDialogCopy = document.querySelector("#delete-dialog-copy");
const deleteMessage = document.querySelector("#delete-message");
const cancelDeleteButton = document.querySelector("#cancel-delete-button");
const confirmDeleteButton = document.querySelector("#confirm-delete-button");

let currentUser;
let currentFolderId = "root";
let folderTrail = [];
let currentItems = [];
let stopListening;
let uploadInProgress = false;
let pendingDeleteItem;
let deleteInProgress = false;
let canEditMaterials = false;

setupAccountMenu();

function setStatus(message, isError = false) {
  materialStatus.textContent = message;
  materialStatus.classList.toggle("is-error", isError);
}

function getExtension(fileName) {
  const lastDot = fileName.lastIndexOf(".");
  return lastDot > 0 ? fileName.slice(lastDot + 1).toLowerCase() : "";
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateFile(file) {
  const extension = getExtension(file.name);
  if (!allowedFileTypes.has(extension)) return `${file.name} is not an allowed file type.`;
  if (file.size > maximumFileSize) return `${file.name} is larger than 100 MB.`;
  return "";
}

function renderBreadcrumbs() {
  const path = [{ id: "root", name: "Permanent Material" }, ...folderTrail];
  breadcrumbs.replaceChildren();

  path.forEach((folder, index) => {
    if (index > 0) {
      const separator = document.createElement("span");
      separator.className = "material-breadcrumb-separator";
      separator.textContent = "/";
      separator.setAttribute("aria-hidden", "true");
      breadcrumbs.append(separator);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "material-breadcrumb";
    button.textContent = folder.name;

    if (index === path.length - 1) {
      button.disabled = true;
      button.setAttribute("aria-current", "page");
    } else {
      button.addEventListener("click", () => {
        folderTrail = folder.id === "root" ? [] : folderTrail.slice(0, index);
        currentFolderId = folder.id;
        renderBreadcrumbs();
        listenToCurrentFolder();
      });
    }

    breadcrumbs.append(button);
  });
}

function openFolder(folder) {
  folderTrail.push({ id: folder.id, name: folder.name });
  currentFolderId = folder.id;
  renderBreadcrumbs();
  listenToCurrentFolder();
}

async function openFile(file, button) {
  const newTab = window.open("about:blank", "_blank");
  if (!newTab) {
    setStatus("Your browser blocked the new tab. Allow pop-ups for this site and try again.", true);
    return;
  }

  newTab.opener = null;
  button.disabled = true;
  setStatus(`Opening ${file.name}…`);

  try {
    const downloadUrl = await getDownloadURL(ref(storage, file.storagePath));
    newTab.location.replace(downloadUrl);
    setStatus("");
  } catch (error) {
    newTab.close();
    console.error("Could not open material file.", error);
    setStatus("The file could not be opened. Check your Storage rules and try again.", true);
  } finally {
    button.disabled = false;
  }
}

function createMaterialRow(item) {
  const row = document.createElement("div");
  row.className = "material-item";
  row.setAttribute("role", "listitem");

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className = "material-item-open";

  const kind = document.createElement("span");
  kind.className = "material-item-kind";
  kind.textContent = item.kind === "folder" ? "Folder" : getExtension(item.name).toUpperCase() || "File";

  const name = document.createElement("span");
  name.className = "material-item-name";
  name.textContent = item.name;

  const meta = document.createElement("span");
  meta.className = "material-item-meta";
  meta.textContent = item.kind === "folder" ? "Open →" : `${formatFileSize(item.size || 0)} · Open ↗`;

  openButton.append(kind, name, meta);
  if (item.kind === "folder") openButton.addEventListener("click", () => openFolder(item));
  else openButton.addEventListener("click", () => openFile(item, openButton));

  row.append(openButton);

  if (canEditMaterials) {
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "material-item-delete";
    deleteButton.textContent = "Delete";
    deleteButton.setAttribute("aria-label", `Delete ${item.kind} ${item.name}`);
    deleteButton.addEventListener("click", () => requestDelete(item));
    row.append(deleteButton);
  }

  return row;
}

function requestDelete(item) {
  if (!canEditMaterials) return;

  if (uploadInProgress) {
    setStatus("Wait for the upload to finish before deleting anything.", true);
    return;
  }

  if (deleteInProgress) return;

  pendingDeleteItem = item;
  const isFolder = item.kind === "folder";
  deleteDialogTitle.textContent = isFolder ? "Delete folder?" : "Delete file?";
  deleteDialogCopy.textContent = isFolder
    ? `This deletes “${item.name}”, every folder inside it, and all of their files. You cannot undo this in the site.`
    : `This deletes “${item.name}”. You cannot undo this in the site.`;
  deleteMessage.textContent = "";
  confirmDeleteButton.textContent = "Delete";
  deleteDialog.showModal();
}

async function collectFolderTree(folder) {
  const folders = [{ ...folder, depth: 0 }];
  const files = [];
  const queue = [{ id: folder.id, depth: 0 }];
  const visitedFolderIds = new Set();

  while (queue.length) {
    const nextFolder = queue.shift();
    if (visitedFolderIds.has(nextFolder.id)) continue;
    visitedFolderIds.add(nextFolder.id);

    const childrenSnapshot = await getDocs(query(
      collection(db, materialCollection),
      where("parentId", "==", nextFolder.id)
    ));

    childrenSnapshot.docs.forEach(childDocument => {
      const child = { id: childDocument.id, ...childDocument.data() };
      if (child.kind === "folder") {
        const nestedFolder = { ...child, depth: nextFolder.depth + 1 };
        folders.push(nestedFolder);
        queue.push({ id: nestedFolder.id, depth: nestedFolder.depth });
      } else if (child.kind === "file") {
        files.push(child);
      }
    });
  }

  return { folders, files };
}

async function deleteStoredFiles(files) {
  for (const file of files) {
    if (!file.storagePath) continue;

    try {
      await deleteObject(ref(storage, file.storagePath));
    } catch (error) {
      if (error?.code !== "storage/object-not-found") throw error;
    }
  }
}

async function deleteMetadata(items) {
  const batchSize = 20;

  for (let index = 0; index < items.length; index += batchSize) {
    const batch = writeBatch(db);
    items.slice(index, index + batchSize).forEach(item => {
      batch.delete(doc(db, materialCollection, item.id));
    });
    await batch.commit();
  }
}

async function deleteMaterialItem(item) {
  if (item.kind === "file") {
    await deleteStoredFiles([item]);
    await deleteMetadata([item]);
    return;
  }

  const { folders, files } = await collectFolderTree(item);
  const nestedFolders = folders
    .filter(folder => folder.id !== item.id)
    .sort((first, second) => second.depth - first.depth);

  await deleteStoredFiles(files);
  await deleteMetadata(files);
  await deleteMetadata(nestedFolders);
  await deleteMetadata([item]);
}

function renderItems() {
  materialItems.replaceChildren(...currentItems.map(createMaterialRow));
  materialEmpty.hidden = currentItems.length !== 0;
}

function listenToCurrentFolder() {
  stopListening?.();
  currentItems = [];
  materialItems.replaceChildren();
  materialEmpty.hidden = true;
  setStatus("Loading…");

  const folderQuery = query(
    collection(db, materialCollection),
    where("parentId", "==", currentFolderId)
  );

  stopListening = onSnapshot(folderQuery, snapshot => {
    currentItems = snapshot.docs
      .map(itemDocument => ({ id: itemDocument.id, ...itemDocument.data() }))
      .sort((first, second) => {
        if (first.kind !== second.kind) return first.kind === "folder" ? -1 : 1;
        return first.name.localeCompare(second.name, undefined, { sensitivity: "base" });
      });
    renderItems();
    setStatus("");
  }, error => {
    console.error("Could not load Permanent Material.", error);
    setStatus("Permanent Material could not be loaded. Check your Firestore rules.", true);
  });
}

function openFolderDialog() {
  if (!canEditMaterials) return;

  folderForm.reset();
  folderMessage.textContent = "";
  folderDialog.showModal();
  folderNameInput.focus();
}

addFolderButton.addEventListener("click", openFolderDialog);
cancelFolderButton.addEventListener("click", () => folderDialog.close());

cancelDeleteButton.addEventListener("click", () => {
  if (!deleteInProgress) deleteDialog.close();
});

deleteDialog.addEventListener("cancel", event => {
  if (deleteInProgress) event.preventDefault();
});

deleteDialog.addEventListener("close", () => {
  if (!deleteInProgress) pendingDeleteItem = undefined;
});

deleteForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!canEditMaterials || !pendingDeleteItem || deleteInProgress || !currentUser) return;

  const item = pendingDeleteItem;
  deleteInProgress = true;
  deleteMessage.textContent = "";
  cancelDeleteButton.disabled = true;
  confirmDeleteButton.disabled = true;
  confirmDeleteButton.textContent = "Deleting…";
  addFolderButton.disabled = true;
  addFilesButton.disabled = true;

  try {
    await deleteMaterialItem(item);
    deleteInProgress = false;
    deleteDialog.close();
    setStatus(`${item.name} was deleted.`);
  } catch (error) {
    console.error("Could not delete material item.", error);
    deleteMessage.textContent = "This item could not be deleted. Check your Firebase rules and try again.";
  } finally {
    deleteInProgress = false;
    cancelDeleteButton.disabled = false;
    confirmDeleteButton.disabled = false;
    confirmDeleteButton.textContent = "Delete";
    addFolderButton.disabled = false;
    addFilesButton.disabled = false;
  }
});

folderForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!canEditMaterials || !folderForm.reportValidity() || !currentUser) return;

  const folderName = folderNameInput.value.trim().replace(/\s+/g, " ");
  const submitButton = folderForm.querySelector("button[type='submit']");
  folderMessage.textContent = "";

  if (!folderName || folderName.includes("/")) {
    folderMessage.textContent = "Enter a folder name without a slash.";
    return;
  }

  const duplicateExists = currentItems.some(item =>
    item.kind === "folder" && item.name.toLowerCase() === folderName.toLowerCase()
  );
  if (duplicateExists) {
    folderMessage.textContent = "A folder with this name already exists here.";
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Adding…";

  try {
    const folderDocument = doc(collection(db, materialCollection));
    await setDoc(folderDocument, {
      kind: "folder",
      name: folderName,
      parentId: currentFolderId,
      createdAt: serverTimestamp(),
      createdBy: currentUser.uid
    });
    folderDialog.close();
    setStatus(`${folderName} was added.`);
  } catch (error) {
    console.error("Could not create material folder.", error);
    folderMessage.textContent = "The folder could not be added. Please try again.";
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Add folder";
  }
});

addFilesButton.addEventListener("click", () => {
  if (canEditMaterials && !uploadInProgress) fileInput.click();
});

function uploadFile(file, itemNumber, totalFiles, destinationFolderId) {
  const extension = getExtension(file.name);
  const fileDocument = doc(collection(db, materialCollection));
  const storagePath = `permanent-material/${fileDocument.id}.${extension}`;
  const storageReference = ref(storage, storagePath);
  const contentType = allowedFileTypes.get(extension);
  let uploadCompleted = false;

  uploadLabel.textContent = `Uploading ${itemNumber} of ${totalFiles}: ${file.name}`;
  uploadPercent.textContent = "0%";
  uploadProgress.value = 0;

  const uploadTask = uploadBytesResumable(storageReference, file, { contentType });

  return new Promise((resolve, reject) => {
    uploadTask.on("state_changed", snapshot => {
      const progress = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
      uploadProgress.value = progress;
      uploadProgress.textContent = `${progress}%`;
      uploadPercent.textContent = `${progress}%`;
    }, reject, async () => {
      uploadCompleted = true;
      try {
        await setDoc(fileDocument, {
          kind: "file",
          name: file.name,
          parentId: destinationFolderId,
          storagePath,
          size: file.size,
          contentType,
          createdAt: serverTimestamp(),
          createdBy: currentUser.uid
        });
        resolve();
      } catch (error) {
        if (uploadCompleted) await deleteObject(storageReference).catch(() => {});
        reject(error);
      }
    });
  });
}

fileInput.addEventListener("change", async () => {
  const files = [...fileInput.files];
  fileInput.value = "";
  if (!canEditMaterials || !files.length || uploadInProgress || !currentUser) return;

  const validationError = files.map(validateFile).find(Boolean);
  if (validationError) {
    setStatus(validationError, true);
    return;
  }

  uploadInProgress = true;
  addFolderButton.disabled = true;
  addFilesButton.disabled = true;
  uploadPanel.hidden = false;
  const destinationFolderId = currentFolderId;
  let uploadedCount = 0;

  try {
    for (const [index, file] of files.entries()) {
      await uploadFile(file, index + 1, files.length, destinationFolderId);
      uploadedCount += 1;
    }
    setStatus(`${uploadedCount} ${uploadedCount === 1 ? "file" : "files"} uploaded.`);
  } catch (error) {
    console.error("Could not upload material file.", error);
    const partialMessage = uploadedCount ? ` ${uploadedCount} uploaded before the error.` : "";
    setStatus(`The upload could not be completed.${partialMessage} Check your Storage rules and try again.`, true);
  } finally {
    uploadInProgress = false;
    addFolderButton.disabled = false;
    addFilesButton.disabled = false;
    uploadPanel.hidden = true;
  }
});

requireUser((user, role) => {
  if (!materialRoles.has(role)) {
    window.location.replace("main.html");
    return;
  }

  currentUser = user;
  canEditMaterials = role === "Master";
  accessStatus.hidden = true;
  materialPage.hidden = false;
  renderBreadcrumbs();
  listenToCurrentFolder();
});

window.addEventListener("pagehide", () => stopListening?.());
