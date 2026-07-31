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
const searchRow = document.getElementById("searchRow");
const searchInput = document.getElementById("searchInput");
const clearSearchBtn = document.getElementById("clearSearchBtn");

let query = "";
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

function showStatus(message, isError = false, action = null) {
  statusEl.textContent = "";
  const text = document.createElement("span");
  text.textContent = message;
  statusEl.appendChild(text);

  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn status-action";
    btn.textContent = action.label;
    btn.addEventListener("click", action.onClick);
    statusEl.appendChild(btn);
  }

  statusEl.className = `status ${isError ? "error" : "success"}`;
  statusEl.hidden = false;
  clearTimeout(showStatus._timer);
  if (!action) {
    showStatus._timer = setTimeout(() => {
      statusEl.hidden = true;
    }, 3000);
  }
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

/* --- Injection ---
 * Pages with a strict Content-Security-Policy (no 'unsafe-eval') kill eval() in
 * the main world, so the code is handed to the page as a real script instead.
 * Strategies are tried in order of how widely they are allowed:
 *   1. userScripts API  - exempt from the page CSP, needs the browser toggle.
 *   2. <script> element - reusing the page's nonce, then plain inline, then a
 *                         blob: URL, then eval() as a last resort.
 */

function injectIntoPage(code) {
  const probeKey = "__jsInjectorProbe_" + Math.random().toString(36).slice(2);
  const parent = document.head || document.documentElement;
  const donor = document.querySelector("script[nonce]");
  const nonce = donor ? donor.nonce || donor.getAttribute("nonce") : "";

  // Pages enforcing Trusted Types reject plain strings on script sinks.
  let policy = null;
  if (window.trustedTypes && window.trustedTypes.createPolicy) {
    try {
      policy = window.trustedTypes.createPolicy("jsInjector-" + probeKey, {
        createScript: (s) => s,
        createScriptURL: (u) => u,
      });
    } catch (e) {
      policy = null;
    }
  }

  function runInline(source, useNonce) {
    const el = document.createElement("script");
    if (useNonce && nonce) el.setAttribute("nonce", nonce);
    try {
      el.textContent = policy ? policy.createScript(source) : source;
    } catch (e) {
      return false; // Trusted Types refused the assignment.
    }
    parent.appendChild(el);
    el.remove();
    return true;
  }

  // Inline scripts run synchronously on insertion, so a probe tells us whether
  // this strategy is allowed without running the user's code twice.
  function inlineAllowed(useNonce) {
    delete window[probeKey];
    if (!runInline(`window[${JSON.stringify(probeKey)}]=1`, useNonce)) return false;
    const ok = window[probeKey] === 1;
    delete window[probeKey];
    return ok;
  }

  function evalFallback() {
    try {
      (0, eval)(code);
      return { ok: true, method: "eval" };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  if (nonce && inlineAllowed(true)) {
    runInline(code, true);
    return { ok: true, method: "nonce" };
  }
  if (inlineAllowed(false)) {
    runInline(code, false);
    return { ok: true, method: "inline" };
  }

  return new Promise((resolve) => {
    let url;
    try {
      url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    } catch (e) {
      resolve(evalFallback());
      return;
    }

    const el = document.createElement("script");
    if (nonce) el.setAttribute("nonce", nonce);
    const done = (result) => {
      URL.revokeObjectURL(url);
      el.remove();
      resolve(result);
    };
    el.onload = () => done({ ok: true, method: "blob" });
    el.onerror = () => done(evalFallback());
    try {
      el.src = policy ? policy.createScriptURL(url) : url;
    } catch (e) {
      done(evalFallback());
      return;
    }
    parent.appendChild(el);
  });
}

async function tryUserScripts(tabId, code, world) {
  if (!chrome.userScripts?.execute) return null;
  try {
    await chrome.userScripts.execute({
      target: { tabId },
      js: [{ code }],
      world,
      injectImmediately: true,
    });
    return world === "MAIN" ? "userScripts" : "userScripts (isolated world)";
  } catch (err) {
    return { error: `userScripts/${world}: ${err.message}` };
  }
}

async function runInPage(tabId, code) {
  const failures = [];

  const main = await tryUserScripts(tabId, code, "MAIN");
  if (typeof main === "string") return main;
  if (main) failures.push(main.error);

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: injectIntoPage,
    args: [code],
  });
  const result = injection?.result;
  if (result?.ok) return result.method;
  failures.push(result?.error || "the page blocked every injection method");

  // Last resort for CSPs that allow neither a nonce, inline code nor blob:.
  // This world shares the DOM but not the page's JavaScript globals.
  const isolated = await tryUserScripts(tabId, code, "USER_SCRIPT");
  if (typeof isolated === "string") return isolated;
  if (isolated) failures.push(isolated.error);

  const blocked = new Error(failures.join(" | "));
  blocked.csp = true;
  throw blocked;
}

function siteOrigin(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? `${parsed.origin}/*` : null;
  } catch (e) {
    return null;
  }
}

// The userScripts API needs host access; activeTab alone is not enough on some
// pages, so offer the optional permission instead of dead-ending on a CSP.
async function offerSiteAccess(tab, index) {
  const origin = siteOrigin(tab.url);
  if (!origin || (await chrome.permissions.contains({ origins: [origin] }))) return false;

  showStatus("Blocked by this page's CSP. Full access to this site lets it run anyway.", true, {
    label: "Grant access",
    onClick: async () => {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (granted) onRun(index);
      else showStatus("Permission denied.", true);
    },
  });
  return true;
}

async function onRun(index) {
  const scripts = await getScripts();
  const target = scripts[index];
  if (!target) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    showStatus("No active tab found.", true);
    return;
  }

  try {
    const method = await runInPage(tab.id, target.script);
    showStatus(`Ran "${target.name}".`);
    console.debug(`JS Injector: injected via ${method}.`);
  } catch (err) {
    if (!err.csp) {
      showStatus(`Injection failed: ${err.message}`, true);
      return;
    }
    if (await offerSiteAccess(tab, index)) return;
    showStatus(
      chrome.userScripts
        ? "Blocked by this page's Content Security Policy."
        : 'Blocked by this page\'s CSP. Turn on "Allow user scripts" for this extension on the browser\'s extensions page, then retry.',
      true
    );
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

/* --- Search --- */

function fillName(el, name) {
  const at = query ? name.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at === -1) {
    el.textContent = name;
    return;
  }
  const hit = document.createElement("mark");
  hit.textContent = name.slice(at, at + query.length);
  el.append(name.slice(0, at), hit, name.slice(at + query.length));
}

function clearSearch() {
  if (!query && !searchInput.value) return;
  searchInput.value = "";
  query = "";
  render();
}

searchInput.addEventListener("input", () => {
  query = searchInput.value.trim();
  clearPendingDelete();
  render();
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  clearSearch();
});

clearSearchBtn.addEventListener("click", () => {
  clearSearch();
  searchInput.focus();
});

function createItem(script, index) {
  const li = document.createElement("li");
  li.className = "item";
  li.dataset.index = String(index);

  // Rows are addressed by their position in storage, which a filtered list no
  // longer matches, so reordering waits until the search is cleared.
  const handle = iconButton("i-grip", `Reorder "${script.name}"`, "drag-handle");
  if (query) {
    handle.disabled = true;
    handle.title = "Clear the search to reorder";
  }
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
  nameSpan.title = script.name;
  fillName(nameSpan, script.name);

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

  searchRow.hidden = scripts.length < 2 && !query;
  clearSearchBtn.hidden = !query;

  const needle = query.toLowerCase();
  const matches = scripts
    .map((script, index) => ({ script, index }))
    .filter(({ script }) => script.name.toLowerCase().includes(needle));

  if (matches.length === 0) {
    emptyStateEl.textContent = query
      ? `No scripts match "${query}".`
      : 'No scripts yet. Click "New Script" to add one.';
    emptyStateEl.hidden = false;
    return;
  }
  emptyStateEl.hidden = true;

  matches.forEach(({ script, index }) => {
    listEl.appendChild(createItem(script, index));
  });
}

newBtn.addEventListener("click", () => showForm(null));
saveBtn.addEventListener("click", onSave);
cancelBtn.addEventListener("click", hideForm);

render();
