// Shared by the question editor, student answers and teacher image enhancement.
// All prose is inserted as text; only explicit HTTPS image URLs become images.
export function isChoiceQuestion(type) { return type === "mcq" || type === "multi"; }
export function validChoiceIndices(indices, count) {
  return Array.isArray(indices) && indices.length > 0 && indices.length <= count
    && new Set(indices).size === indices.length
    && indices.every(index => Number.isInteger(index) && index >= 0 && index < count);
}
const imagePattern = /!\[([^\]\n]*)\]\((https:\/\/[^\s<>()]+)\)/g;
function picture(token, description, source) {
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid image URL");
    const image = document.createElement("img");
    image.className = "quest-inline-image";
    image.alt = description || "Question image";
    image.src = url.href;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => {
      const fallback = document.createElement("span");
      fallback.className = "quest-image-error";
      fallback.textContent = `Image unavailable: ${image.alt}`;
      image.replaceWith(fallback);
    }, { once: true });
    return image;
  } catch { return document.createTextNode(token); }
}
export function richText(target, source) {
  target.replaceChildren();
  source = typeof source === "string" ? source : "";
  // Math tokens are consumed whole so TeX commands and stars remain intact.
  const tokens = /(!\[[^\]\n]*\]\(https:\/\/[^\s<>()]+\)|\$\$[\s\S]*?\$\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\\begin\{equation\*?\}[\s\S]*?\\end\{equation\*?\}|\*\*[\s\S]+?\*\*|\*[^*\n]+?\*)/g;
  let start = 0;
  for (const match of source.matchAll(tokens)) {
    target.append(document.createTextNode(source.slice(start, match.index)));
    const token = match[0];
    if (token.startsWith("![")) {
      const image = [...token.matchAll(imagePattern)][0];
      target.append(image ? picture(token, image[1], image[2]) : document.createTextNode(token));
    } else if (token.startsWith("**") || token.startsWith("*")) {
      const bold = token.startsWith("**");
      const element = document.createElement(bold ? "strong" : "em");
      richText(element, token.slice(bold ? 2 : 1, bold ? -2 : -1));
      target.append(element);
    } else {
      const span = document.createElement("span");
      const displayMode = !token.startsWith("\\(");
      const tex = token.startsWith("\\begin")
        ? token.replace(/^\\begin\{equation\*?\}/, "").replace(/\\end\{equation\*?\}$/, "") : token.slice(2, -2);
      if (window.katex) {
        try { window.katex.render(tex, span, { displayMode, throwOnError: true, trust: false, maxExpand: 1000, maxSize: 20 }); }
        catch { span.textContent = token; span.className = "quest-math-error"; span.title = "Check this LaTeX expression."; }
      } else { span.textContent = token; }
      target.append(span);
    }
    start = match.index + token.length;
  }
  target.append(document.createTextNode(source.slice(start)));
}

// Existing student-record.js is not replaced. Upgrade image placeholders it
// renders as text, including newly opened/re-rendered teacher review dialogs.
export function enhanceRecordImages(root) {
  if (!root) return;
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; upgrade(); });
  });
  function upgrade() {
    observer.disconnect();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const text of nodes) {
      if (text.parentElement?.closest("textarea, input, button, script, style, .katex, .quest-image-error")) continue;
      const matches = [...text.data.matchAll(imagePattern)];
      if (!matches.length) continue;
      const fragment = document.createDocumentFragment();
      let offset = 0;
      for (const match of matches) {
        fragment.append(document.createTextNode(text.data.slice(offset, match.index)), picture(match[0], match[1], match[2]));
        offset = match.index + match[0].length;
      }
      fragment.append(document.createTextNode(text.data.slice(offset)));
      text.replaceWith(fragment);
    }
    observer.observe(root, { childList: true, characterData: true, subtree: true });
  }
  upgrade();
  return () => observer.disconnect();
}
