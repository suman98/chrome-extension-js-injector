const STORAGE_KEY = "scripts";
const CONFIRM_TIMEOUT_MS = 3000;

const listEl = document.getElementById("list");
const emptyStateEl = document.getElementById("emptyState");
const statusEl = document.getElementById("status");
const formEl = document.getElementById("form");
const nameInput = document.getElementById("nameInput");
const codeInput = document.getElementById("codeInput");
const codeGutter = document.getElementById("codeGutter");
const codeHighlight = document.getElementById("codeHighlight").querySelector("code");
const newBtn = document.getElementById("newBtn");
const saveBtn = document.getElementById("saveBtn");
const cancelBtn = document.getElementById("cancelBtn");

let editingIndex = null;
let pendingDeleteIndex = null;
let pendingDeleteTimer = null;

const JS_KEYWORDS =
  "const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|async|await|yield|import|export|default|from|as|delete|void|null|undefined|true|false|static|get|set";

const TOKEN_RE = new RegExp(
  "(//.*)" + // 1: line comment
    "|(/\\*[\\s\\S]*?\\*/)" + // 2: block comment
    "|(`(?:\\\\.|[^`\\\\])*`|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*')" + // 3: string
    "|\\b(" + JS_KEYWORDS + ")\\b" + // 4: keyword
    "|\\b(\\d+(?:\\.\\d+)?)\\b", // 5: number
  "g"
);

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlightCode(code) {
  return escapeHtml(code).replace(TOKEN_RE, (match, comment1, comment2, string, keyword, number) => {
    if (comment1 || comment2) return `<span class="tok-comment">${match}</span>`;
    if (string) return `<span class="tok-string">${match}</span>`;
    if (keyword) return `<span class="tok-keyword">${match}</span>`;
    if (number) return `<span class="tok-number">${match}</span>`;
    return match;
  });
}

function updateEditor() {
  const value = codeInput.value;
  codeHighlight.innerHTML = highlightCode(value) + "\n";

  const lineCount = value.split("\n").length;
  let gutterHtml = "";
  for (let i = 1; i <= lineCount; i++) {
    gutterHtml += `<div>${i}</div>`;
  }
  codeGutter.innerHTML = gutterHtml;
}

function syncEditorScroll() {
  codeHighlight.parentElement.scrollTop = codeInput.scrollTop;
  codeHighlight.parentElement.scrollLeft = codeInput.scrollLeft;
  codeGutter.scrollTop = codeInput.scrollTop;
}

codeInput.addEventListener("input", updateEditor);
codeInput.addEventListener("scroll", syncEditorScroll);
codeInput.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  e.preventDefault();
  const { selectionStart, selectionEnd } = codeInput;
  codeInput.setRangeText("  ", selectionStart, selectionEnd, "end");
  updateEditor();
});

async function getScripts() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function setScripts(scripts) {
  await chrome.storage.local.set({ [STORAGE_KEY]: scripts });
}

function showStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = `status ${isError ? "error" : "success"}`;
  statusEl.hidden = false;
  clearTimeout(showStatus._timer);
  showStatus._timer = setTimeout(() => {
    statusEl.hidden = true;
  }, 3000);
}

function showForm(index = null) {
  editingIndex = index;
  formEl.hidden = false;
  if (index !== null) {
    getScripts().then((scripts) => {
      const s = scripts[index];
      nameInput.value = s.name;
      codeInput.value = s.script;
      updateEditor();
      nameInput.focus();
    });
  } else {
    nameInput.value = "";
    codeInput.value = "";
    updateEditor();
    nameInput.focus();
  }
}

function hideForm() {
  formEl.hidden = true;
  editingIndex = null;
  nameInput.value = "";
  codeInput.value = "";
  updateEditor();
}

async function onSave() {
  const name = nameInput.value.trim();
  const script = codeInput.value;
  if (!name) {
    showStatus("Script name is required.", true);
    return;
  }
  if (!script.trim()) {
    showStatus("Script code is required.", true);
    return;
  }

  const scripts = await getScripts();
  if (editingIndex !== null) {
    scripts[editingIndex] = { name, script };
  } else {
    scripts.push({ name, script });
  }
  await setScripts(scripts);
  hideForm();
  render();
  showStatus(editingIndex !== null ? "Script updated." : "Script added.");
}

async function onDelete(index) {
  if (pendingDeleteIndex !== index) {
    pendingDeleteIndex = index;
    clearTimeout(pendingDeleteTimer);
    pendingDeleteTimer = setTimeout(() => {
      pendingDeleteIndex = null;
      render();
    }, CONFIRM_TIMEOUT_MS);
    render();
    return;
  }

  clearPendingDelete();
  const scripts = await getScripts();
  scripts.splice(index, 1);
  await setScripts(scripts);
  render();
  showStatus("Script deleted.");
}

async function onRun(index) {
  const scripts = await getScripts();
  const target = scripts[index];
  if (!target) return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      showStatus("No active tab found.", true);
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: (code) => {
        try {
          (0, eval)(code);
        } catch (err) {
          console.error("JS Injector script error:", err);
        }
      },
      args: [target.script],
    });

    showStatus(`Ran "${target.name}".`);
  } catch (err) {
    showStatus(`Injection failed: ${err.message}`, true);
  }
}

async function moveScript(from, to) {
  const scripts = await getScripts();
  if (from === to || from < 0 || to < 0 || from >= scripts.length || to >= scripts.length) return;

  const [moved] = scripts.splice(from, 1);
  scripts.splice(to, 0, moved);
  await setScripts(scripts);
  clearPendingDelete();
  await render();
  return to;
}

function clearPendingDelete() {
  clearTimeout(pendingDeleteTimer);
  pendingDeleteIndex = null;
}

function icon(id) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${id}`);
  svg.appendChild(use);
  return svg;
}

function iconButton(iconId, label, className = "btn") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `${className} btn-icon`;
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.appendChild(icon(iconId));
  return btn;
}

function createItem(script, index) {
  const li = document.createElement("li");
  li.className = "item";
  li.dataset.index = String(index);

  const handle = iconButton("i-grip", `Reorder "${script.name}"`, "drag-handle");
  // Only drags started from the handle should move the row.
  handle.addEventListener("mousedown", () => {
    li.draggable = true;
  });
  handle.addEventListener("mouseup", () => {
    li.draggable = false;
  });
  handle.addEventListener("keydown", (e) => onHandleKeydown(e, index));

  const nameSpan = document.createElement("span");
  nameSpan.className = "item-name";
  nameSpan.textContent = script.name;
  nameSpan.title = script.name;

  const actions = document.createElement("div");
  actions.className = "item-actions";

  const runBtn = iconButton("i-play", `Run "${script.name}"`, "btn btn-primary");
  runBtn.addEventListener("click", () => onRun(index));

  const editBtn = iconButton("i-pencil", `Edit "${script.name}"`);
  editBtn.addEventListener("click", () => showForm(index));

  const isConfirming = pendingDeleteIndex === index;
  const deleteBtn = iconButton(
    isConfirming ? "i-check" : "i-trash",
    isConfirming ? `Confirm delete "${script.name}"` : `Delete "${script.name}"`,
    isConfirming ? "btn btn-danger" : "btn"
  );
  deleteBtn.addEventListener("click", () => onDelete(index));

  actions.append(runBtn, editBtn, deleteBtn);
  li.append(handle, nameSpan, actions);

  li.addEventListener("dragstart", onDragStart);
  li.addEventListener("dragover", onDragOver);
  li.addEventListener("dragend", onDragEnd);
  return li;
}

/* --- Drag to reorder --- */

let dragIndex = null;

function onDragStart(e) {
  dragIndex = Number(e.currentTarget.dataset.index);
  e.currentTarget.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  // Required for the drag to start in some browsers.
  e.dataTransfer.setData("text/plain", String(dragIndex));
}

function onDragOver(e) {
  if (dragIndex === null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  const dragging = listEl.querySelector(".dragging");
  const target = e.currentTarget;
  if (!dragging || dragging === target) return;

  const rect = target.getBoundingClientRect();
  const after = e.clientY > rect.top + rect.height / 2;
  listEl.insertBefore(dragging, after ? target.nextSibling : target);
}

async function onDragEnd(e) {
  const li = e.currentTarget;
  li.draggable = false;
  li.classList.remove("dragging");
  const from = dragIndex;
  dragIndex = null;
  if (from === null) return;

  const to = [...listEl.children].indexOf(li);
  if (to === -1 || to === from) {
    await render(); // Snap back if the drop was cancelled.
    return;
  }
  await moveScript(from, to);
}

listEl.addEventListener("dragover", (e) => {
  if (dragIndex !== null) e.preventDefault();
});

async function onHandleKeydown(e, index) {
  const delta = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
  if (delta === 0) return;
  e.preventDefault();

  const moved = await moveScript(index, index + delta);
  if (moved === undefined) return;
  listEl.children[moved]?.querySelector(".drag-handle")?.focus();
}

async function render() {
  const scripts = await getScripts();
  listEl.innerHTML = "";

  if (scripts.length === 0) {
    emptyStateEl.hidden = false;
    return;
  }
  emptyStateEl.hidden = true;

  scripts.forEach((script, index) => {
    listEl.appendChild(createItem(script, index));
  });
}

newBtn.addEventListener("click", () => showForm(null));
saveBtn.addEventListener("click", onSave);
cancelBtn.addEventListener("click", hideForm);

render();
