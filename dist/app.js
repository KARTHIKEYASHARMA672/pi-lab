/* Pi Lab: an independent browser desktop. Desktop controls; real execution is connected by backend-client.js. */
"use strict";
const $ = (s, root = document) => root.querySelector(s);
const apps = {
  welcome: ["◈", "Welcome"],
  files: ["▰", "File Manager"],
  editor: ["⌘", "Python Editor"],
  terminal: ["›_", "Terminal"],
  gpio: ["⌁", "GPIO Lab"],
  settings: ["⚙", "Preferences"],
  help: ["?", "Getting started"],
};
const home = "/home/pi";
let files = { [home]: null };
let settings;
try {
  settings = JSON.parse(localStorage.getItem("pilab-settings")) || {};
} catch {
  settings = {};
}
let z = 10,
  windows = new Map(),
  editPath = home + "/Python/hello.py",
  dirty = false,
  folder = home,
  selected = null,
  cwd = home;
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const basename = (p) => p.split("/").pop() || "/";
function normalize(p, base = cwd) {
  let parts = (p.startsWith("/") ? p : base + "/" + p)
      .replace(/^~(?=\/|$)/, home)
      .split("/"),
    out = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return "/" + out.join("/");
}
function resolve(p, base = cwd) {
  if (p === "~") return home;
  if (p.startsWith("~/")) p = home + p.slice(1);
  return normalize(p, base);
}
function saveFiles() {
  try {
    localStorage.setItem("pilab-files", JSON.stringify(files));
    return true;
  } catch {
    toast("Storage is full or unavailable. Export your files for backup.");
    return false;
  }
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.remove("show"), 3500);
}
function applyTheme(theme) {
  const themes = {
    lavender: ["#ddd9ec", "#b4acd3", "#8a83b3", "#605c91", "#45456c"],
    forest: ["#d8e5da", "#a1bba9", "#759a8a", "#4d7265", "#304b46"],
    sunset: ["#eed9d2", "#d9acb3", "#b67f9c", "#805a83", "#4e405e"],
  };
  (themes[theme] || themes.lavender).forEach((v, i) =>
    document.documentElement.style.setProperty("--wall" + (i + 1), v),
  );
}
applyTheme(settings.theme);
function updateClock() {
  $("#clock").textContent = new Date().toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
updateClock();
setInterval(updateClock, 1000);
async function boot() {
  if (!$("#boot").hidden) return;
  $("#launcher").hidden = true;
  $("#boot").hidden = false;
  await new Promise((r) => setTimeout(r, 1100));
  $("#boot").hidden = true;
  $("#desktop").hidden = false;
  if (!windows.size) openApp("welcome");
}
$("#launch").onclick = boot;
$("#pi-board").ondblclick = boot;
$("#pi-board").onkeydown = (e) => {
  if (e.key === "Enter") boot();
};
$("#launch-help").onclick = () => {
  boot().then(() => openApp("help"));
};
$("#menu-apps").innerHTML = Object.entries(apps)
  .filter(([k]) => k !== "welcome")
  .map(
    ([k, [icon, name]]) =>
      `<button data-open="${k}">${icon} &nbsp; ${name}</button>`,
  )
  .join("");
$("#menu-button").onclick = (e) => {
  e.stopPropagation();
  $("#app-menu").hidden = !$("#app-menu").hidden;
};
document.addEventListener("click", (e) => {
  const target = e.target.closest("[data-open]");
  if (target) {
    openApp(target.dataset.open);
    $("#app-menu").hidden = true;
  } else if (!e.target.closest("#app-menu")) $("#app-menu").hidden = true;
});
function shutdown() {
  if (
    dirty &&
    !confirm("Your editor has unsaved changes. Return to the launchpad?")
  )
    return;
  saveFiles();
  $("#desktop").hidden = true;
  $("#launcher").hidden = false;
  $("#app-menu").hidden = true;
  toast("Your saved files will be here when you return.");
}
$("#shutdown").onclick = shutdown;
$("#power-button").onclick = shutdown;
$("#sound-button").onclick = () =>
  toast("This virtual desktop has no system audio service.");
function focusWindow(id) {
  for (const [key, w] of windows) w.classList.toggle("focused", key === id);
  const w = windows.get(id);
  if (w) {
    w.hidden = false;
    w.style.zIndex = ++z;
  }
}
function renderTasks() {
  $("#tasks").innerHTML = "";
  for (const [id, w] of windows) {
    const b = document.createElement("button");
    b.textContent = apps[id][1];
    b.title = apps[id][1];
    b.onclick = () => focusWindow(id);
    $("#tasks").append(b);
  }
}
function closeWindow(id) {
  if (
    id === "editor" &&
    dirty &&
    !confirm("Close the editor and discard unsaved changes?")
  )
    return;
  if (id === "editor") dirty = false;
  windows.get(id)?.remove();
  windows.delete(id);
  renderTasks();
}
function openApp(id) {
  if (!apps[id]) return;
  if (windows.has(id)) {
    focusWindow(id);
    return;
  }
  const w = document.createElement("section");
  w.className = "window";
  w.dataset.app = id;
  w.setAttribute("aria-label", apps[id][1]);
  w.style.left =
    Math.min(190 + windows.size * 24, window.innerWidth - 380) + "px";
  w.style.top = 90 + windows.size * 24 + "px";
  if (id === "welcome") {
    w.style.width = "650px";
    w.style.height = "470px";
  }
  if (id === "editor") {
    w.style.width = "790px";
    w.style.height = "550px";
  }
  w.innerHTML = `<header class="titlebar"><span class="window-title">${apps[id][0]} &nbsp; <span class="title-text">${apps[id][1]}</span></span><div class="window-controls"><button title="Minimize" aria-label="Minimize">−</button><button title="Maximize" aria-label="Maximize">□</button><button title="Close" aria-label="Close">×</button></div></header><div class="window-body"></div>`;
  $("#windows").append(w);
  windows.set(id, w);
  w.onpointerdown = () => focusWindow(id);
  const controls = $(".window-controls", w).children;
  controls[0].onclick = () => (w.hidden = true);
  controls[1].onclick = () => w.classList.toggle("maximized");
  controls[2].onclick = () => closeWindow(id);
  const bar = $(".titlebar", w);
  bar.ondblclick = (e) => {
    if (!e.target.closest("button")) w.classList.toggle("maximized");
  };
  bar.onpointerdown = (e) => {
    if (e.target.closest("button") || w.classList.contains("maximized")) return;
    const rect = w.getBoundingClientRect(),
      dx = e.clientX - rect.left,
      dy = e.clientY - rect.top;
    bar.setPointerCapture(e.pointerId);
    bar.onpointermove = (ev) => {
      w.style.left =
        Math.max(0, Math.min(window.innerWidth - 100, ev.clientX - dx)) + "px";
      w.style.top =
        Math.max(40, Math.min(window.innerHeight - 60, ev.clientY - dy)) + "px";
    };
    bar.onpointerup = () => (bar.onpointermove = null);
  };
  renderers[id]($(".window-body", w));
  renderTasks();
  focusWindow(id);
}
const renderers = {
  welcome: renderWelcome,
  files: renderFiles,
  editor: renderEditor,
  terminal: renderTerminal,
  settings: renderSettings,
  help: renderHelp,
  gpio: renderGPIO,
};
function renderWelcome(b) {
  b.textContent = 'Connect to the Linux backend to open your workbench.';
}

function listFiles(dir) {
  return Object.keys(files)
    .filter((p) => p !== dir && p.substring(0, p.lastIndexOf("/")) === dir)
    .sort(
      (a, b) =>
        (files[a] === null ? 0 : 1) - (files[b] === null ? 0 : 1) ||
        a.localeCompare(b),
    );
}
function navigate(dir) {
  if (files[dir] !== null) return toast("Folder does not exist.");
  folder = dir;
  selected = null;
  refreshFiles();
}
function refreshFiles() {
  const w = windows.get("files");
  if (w) renderFiles($(".window-body", w));
}
function newFile(dir = folder) {
  const name = prompt("File name", "untitled.py");
  if (!validName(name)) return;
  const path = dir + "/" + name;
  if (Object.hasOwn(files, path)) return toast("That name already exists.");
  files[path] = "";
  saveFiles();
  refreshFiles();
  openFile(path);
}
function validName(name) {
  if (name === null) return false;
  if (!name.trim() || /[\\/\x00]/.test(name) || name === "." || name === "..") {
    toast("Choose a name without slashes.");
    return false;
  }
  return true;
}
function renderFiles(b) {
  const children = listFiles(folder);
  b.innerHTML = `<div class="toolbar"><button id="up-folder" title="Parent folder">↑</button><input aria-label="Folder path" id="folder-path" value="${esc(folder)}"><button id="go-folder">Go</button></div><div class="toolbar"><button id="new-file">+ File</button><button id="new-folder">+ Folder</button><button id="rename-file">Rename</button><button id="delete-file">Delete</button><button id="download-file">Export file</button><button id="upload-file">Import</button><input type="file" id="import-input" hidden></div><div class="file-layout"><aside class="sidebar"><small>PLACES</small>${["Home", "Desktop", "Documents", "Downloads", "Python"].map((n) => `<button class="${folder === (n === "Home" ? home : home + "/" + n) ? "active" : ""}" data-folder="${n === "Home" ? home : home + "/" + n}">▰ &nbsp; ${n}</button>`).join("")}</aside><div class="file-grid">${children.map((p) => `<button class="file-item ${files[p] === null ? "directory" : ""} ${selected === p ? "selected" : ""}" data-path="${esc(p)}"><span>${files[p] === null ? "▰" : p.endsWith(".py") ? "⌘" : "▤"}</span>${esc(basename(p))}</button>`).join("") || '<span class="empty">A little room for something new.</span>'}</div></div><div class="file-status">${children.length} items &nbsp; · &nbsp; Linux filesystem</div>`;
  b.querySelectorAll("[data-folder]").forEach(
    (el) => (el.onclick = () => navigate(el.dataset.folder)),
  );
  b.querySelectorAll("[data-path]").forEach((el) => {
    el.onclick = () => {
      selected = el.dataset.path;
      b.querySelectorAll(".file-item").forEach((x) =>
        x.classList.toggle("selected", x === el),
      );
    };
    el.ondblclick = () =>
      files[el.dataset.path] === null
        ? navigate(el.dataset.path)
        : openFile(el.dataset.path);
    el.onkeydown = (e) => {
      if (e.key === "Enter")
        files[el.dataset.path] === null
          ? navigate(el.dataset.path)
          : openFile(el.dataset.path);
    };
  });
  $("#up-folder", b).onclick = () =>
    navigate(
      folder === home ? home : folder.substring(0, folder.lastIndexOf("/")),
    );
  const go = () => {
    let p = resolve($("#folder-path", b).value, folder);
    if (!p.startsWith(home))
      return toast("The virtual filesystem starts at /home/pi.");
    navigate(p);
  };
  $("#go-folder", b).onclick = go;
  $("#folder-path", b).onkeydown = (e) => {
    if (e.key === "Enter") go();
  };
  $("#new-file", b).onclick = () => newFile();
  $("#new-folder", b).onclick = () => {
    const name = prompt("Folder name", "New Folder");
    if (!validName(name)) return;
    const p = folder + "/" + name;
    if (Object.hasOwn(files, p)) return toast("That name already exists.");
    files[p] = null;
    saveFiles();
    refreshFiles();
  };
  $("#delete-file", b).onclick = () => {
    if (!selected) return toast("Select a file or folder first.");
    if (selected === editPath && dirty)
      return toast("Save or close the edited file before deleting.");
    if (!confirm("Delete " + basename(selected) + " and its contents?")) return;
    const doomed = selected;
    for (const p of Object.keys(files))
      if (p === doomed || p.startsWith(doomed + "/")) delete files[p];
    saveFiles();
    selected = null;
    refreshFiles();
  };
  $("#rename-file", b).onclick = () => {
    if (!selected) return toast("Select a file or folder first.");
    if (dirty && (editPath === selected || editPath.startsWith(selected + "/")))
      return toast("Save the editor before renaming.");
    const name = prompt("New name", basename(selected));
    if (!validName(name)) return;
    const dest = folder + "/" + name;
    if (Object.hasOwn(files, dest)) return toast("That name already exists.");
    const src = selected;
    for (const p of Object.keys(files))
      if (p === src || p.startsWith(src + "/")) {
        files[dest + p.slice(src.length)] = files[p];
        delete files[p];
      }
    if (editPath === src || editPath.startsWith(src + "/")) {
      editPath = dest + editPath.slice(src.length);
      if (windows.has("editor"))
        renderEditor($(".window-body", windows.get("editor")));
    }
    selected = dest;
    saveFiles();
    refreshFiles();
  };
  $("#download-file", b).onclick = () => {
    if (!selected || files[selected] === null)
      return toast("Select a file to export.");
    download(basename(selected), files[selected]);
  };
  $("#upload-file", b).onclick = () => $("#import-input", b).click();
  $("#import-input", b).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 2000000) return toast("Choose a text file smaller than 2 MB.");
    if (!validName(f.name)) return;
    const dest = folder + "/" + f.name;
    if (Object.hasOwn(files, dest) && !confirm("Replace " + f.name + "?"))
      return;
    files[dest] = await f.text();
    saveFiles();
    refreshFiles();
  };
}
function download(name, content) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function openFile(path) {
  if (dirty && !confirm("Discard unsaved changes and open this file?")) return;
  editPath = path;
  dirty = false;
  openApp("editor");
  renderEditor($(".window-body", windows.get("editor")));
}
function updateEditorTitle() {
  const w = windows.get("editor");
  if (w)
    $(".title-text", w).textContent =
      basename(editPath) + (dirty ? " •" : "") + " — Python Editor";
}
function editorSave() {
  const w = windows.get("editor");
  if (!w) return false;
  files[editPath] = $(".code-editor", w).value;
  const ok = saveFiles();
  if (ok) {
    dirty = false;
    updateEditorTitle();
    refreshFiles();
    toast("Saved " + basename(editPath));
  }
  return ok;
}
function renderEditor(b) {
  b.innerHTML = `<div class="editor-layout"><div class="toolbar"><button id="editor-new">New</button><button id="editor-save">Save</button><button id="editor-export">Export</button><span style="flex:1;font-size:10px;color:#9a8aa7">${esc(editPath)}</span><button class="run" id="editor-run">▶ Run</button><button id="editor-stop">■ Stop</button></div><div class="code-wrap"><div class="line-numbers"></div><textarea class="code-editor" aria-label="Python source code" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea></div><div class="output-panel"><div class="output-heading"><span>PYTHON CONSOLE</span><button id="clear-output">Clear</button></div><pre class="output-text" aria-live="polite">Ready. Connect the Linux backend to execute Python.</pre></div></div>`;
  const area = $(".code-editor", b);
  area.value = files[editPath] || "";
  const lines = () => {
    $(".line-numbers", b).textContent = Array.from(
      { length: area.value.split("\n").length },
      (_, i) => i + 1,
    ).join("\n");
  };
  lines();
  area.oninput = () => {
    dirty = true;
    lines();
    updateEditorTitle();
  };
  area.onscroll = () => ($(".line-numbers", b).scrollTop = area.scrollTop);
  area.onkeydown = (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const start = area.selectionStart,
        end = area.selectionEnd;
      area.setRangeText("    ", start, end, "end");
      area.dispatchEvent(new Event("input"));
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      editorSave();
    }
    if (e.key === "F5") {
      e.preventDefault();
      runEditor();
    }
  };
  $("#editor-save", b).onclick = editorSave;
  $("#editor-run", b).onclick = runEditor;
  $("#editor-stop", b).onclick = () => stopPython("Execution stopped.");
  $("#editor-new", b).onclick = () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    dirty = false;
    newFile(home + "/Python");
  };
  $("#editor-export", b).onclick = () =>
    download(basename(editPath), area.value);
  $("#clear-output", b).onclick = () => ($(".output-text", b).textContent = "");
  updateEditorTitle();
}
function runEditor() {
  toast("Connect the Linux backend to execute Python.");
}
function stopPython() {
  toast("No Python process is connected.");
}
function renderTerminal(b) {
  b.textContent = "Connecting to the Linux backend…";
}
function renderSettings(b) {
  b.innerHTML = `<div class="settings"><h3>A desktop that feels like you.</h3><p>Make a little space your own.</p><label>WALLPAPER PALETTE</label><div class="swatches"><button class="swatch" data-theme="lavender" style="background:linear-gradient(150deg,#ddd9ec,#605c91)" title="Lavender mountains" aria-label="Lavender mountains"></button><button class="swatch" data-theme="forest" style="background:linear-gradient(150deg,#d8e5da,#4d7265)" title="Forest mountains" aria-label="Forest mountains"></button><button class="swatch" data-theme="sunset" style="background:linear-gradient(150deg,#eed9d2,#805a83)" title="Sunset mountains" aria-label="Sunset mountains"></button></div><label>YOUR WORKSPACE</label><p>Files are saved in the Linux container’s /home/pi volume.<br>Export a backup before removing Docker volumes.</p><div class="row"><button class="action" id="export-workspace">Export workspace</button><button class="action" id="restore-workspace">Restore backup</button><input type="file" id="restore-input" accept=".json" hidden></div><label>ABOUT THIS PI</label><p>Pi Lab · Linux Edition 2.0<br>Independent educational project. Not affiliated with Raspberry Pi.<br>Terminal: real Bash · Python: real CPython · Hardware: unavailable</p><button class="action" data-open="help">Read the field guide ↗</button></div>`;
  b.querySelectorAll("[data-theme]").forEach(
    (el) =>
      (el.onclick = () => {
        settings.theme = el.dataset.theme;
        applyTheme(settings.theme);
        try {
          localStorage.setItem("pilab-settings", JSON.stringify(settings));
          toast("A fresh view.");
        } catch {
          toast("Theme changed. Browser storage is unavailable.");
        }
      }),
  );
  $("#export-workspace", b).onclick = () =>
    download(
      "pi-lab-workspace.json",
      JSON.stringify({ version: 1, files, settings }, null, 2),
    );
  $("#restore-workspace", b).onclick = () => $("#restore-input", b).click();
  $("#restore-input", b).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      if (f.size > 5000000) throw Error("too large");
      const data = JSON.parse(await f.text());
      if (
        data.version !== 1 ||
        !data.files ||
        typeof data.files !== "object" ||
        Array.isArray(data.files)
      )
        throw Error("invalid format");
      for (const [p, v] of Object.entries(data.files)) {
        if (
          !(p === home || p.startsWith(home + "/")) ||
          p.split("/").some((x) => x === ".." || x === ".") ||
          !(v === null || typeof v === "string")
        )
          throw Error("invalid path");
        if (
          p !== home &&
          data.files[p.substring(0, p.lastIndexOf("/"))] !== null
        )
          throw Error("missing parent folder");
      }
      if (data.files[home] !== null) throw Error("missing home folder");
      if (dirty) return toast("Save or close your editor before restoring.");
      if (!confirm("Replace your workspace with this backup?")) return;
      files = data.files;
      folder = cwd = home;
      saveFiles();
      refreshFiles();
      if (windows.has("editor")) {
        closeWindow("editor");
        editPath =
          Object.keys(files).find((p) => p.endsWith(".py")) ||
          home + "/Python/hello.py";
      }
      settings =
        data.settings && typeof data.settings === "object" ? data.settings : {};
      applyTheme(settings.theme);
      try {
        localStorage.setItem("pilab-settings", JSON.stringify(settings));
      } catch {}
      toast("Workspace restored.");
    } catch (err) {
      toast("Could not restore backup: " + err.message);
    }
  };
}
function renderHelp(b) {
  b.textContent = "Connect to the Linux backend for the field guide.";
}
function renderGPIO(b) {
  b.textContent = "Physical GPIO hardware is not available in this container.";
}
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("#app-menu").hidden = true;
  if (
    (e.ctrlKey || e.metaKey) &&
    e.key === "s" &&
    windows.get("editor")?.classList.contains("focused")
  ) {
    e.preventDefault();
    editorSave();
  }
});
