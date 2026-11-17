/* Real execution transport. There is deliberately no simulated shell fallback. */
"use strict";
let connected = false,
  serverFiles = {},
  syncQueue = Promise.resolve(),
  syncing = 0,
  runSocket = null;
const wsURL = (path) =>
  (location.protocol === "https:" ? "wss:" : "ws:") +
  "//" +
  location.host +
  path;
async function api(path, options = {}) {
  const requestOptions = {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  };
  let r = await fetch(path, requestOptions);
  if (r.status === 403) {
    // A restarted container issues a new local session cookie.
    await fetch("/", { cache: "no-store" });
    r = await fetch(path, requestOptions);
  }
  if (!r.ok) {
    const body = await r.text();
    throw Error(body.slice(0, 180));
  }
  return r.json();
}
async function pullFiles() {
  if (syncing) return;
  const data = await api("/api/workspace");
  files = data.files;
  serverFiles = { ...files };
  if (files[folder] !== null) folder = home;
  refreshFiles();
  const w = windows.get("editor");
  if (w && !dirty && Object.hasOwn(files, editPath)) {
    const area = $(".code-editor", w);
    if (area.value !== files[editPath]) {
      area.value = files[editPath] || "";
      area.dispatchEvent(new Event("refresh"));
    }
  }
}
saveFiles = function () {
  if (!connected) {
    toast("Linux backend is disconnected. Start docker compose up --build.");
    return Promise.resolve(false);
  }
  const desired = { ...files },
    before = { ...serverFiles },
    ops = [];
  for (const p of Object.keys(before).sort((a, b) => b.length - a.length))
    if (p !== home && !Object.hasOwn(desired, p))
      ops.push({ kind: "delete", path: p });
  for (const p of Object.keys(desired).sort((a, b) => a.length - b.length))
    if (p !== home && (!Object.hasOwn(before, p) || before[p] !== desired[p]))
      ops.push(
        desired[p] === null
          ? { kind: "mkdir", path: p }
          : { kind: "write", path: p, content: desired[p] },
      );
  serverFiles = desired;
  syncing++;
  const job = syncQueue.then(async () => {
    try {
      if (ops.length)
        await api("/api/workspace", {
          method: "POST",
          body: JSON.stringify({ operations: ops }),
        });
      return true;
    } catch (e) {
      toast("Save failed: " + e.message);
      return false;
    } finally {
      syncing--;
    }
  });
  syncQueue = job.then(() => {});
  return job;
};
editorSave = async function () {
  const w = windows.get("editor");
  if (!w) return false;
  files[editPath] = $(".code-editor", w).value;
  const ok = await saveFiles();
  if (ok) {
    dirty = false;
    updateEditorTitle();
    refreshFiles();
    toast("Saved to Linux: " + basename(editPath));
  }
  return ok;
};
function setConnection(ok, info) {
  connected = ok;
  const badge = $(".browser-badge");
  badge.textContent = ok ? "LINUX CONNECTED" : "BACKEND OFFLINE";
  badge.classList.toggle("connected", ok);
  $(".desktop-bottom>span:first-child").innerHTML =
    `<i class="status-dot" style="background:${ok ? "#91b978" : "#c98a77"}"></i>${ok ? "Linux container · " + info.platform + " · Python " + info.python : "Linux backend disconnected"}`;
}
async function connectBackend() {
  try {
    const info = await api("/api/status");
    setConnection(true, info);
    await pullFiles();
    return true;
  } catch {
    setConnection(false);
    return false;
  }
}
renderTerminal = function (b) {
  b.innerHTML =
    '<div class="terminal-status"><span class="status-dot"></span><span>Connecting to Linux…</span><button class="action reconnect-terminal">Reconnect</button></div><div class="real-terminal" aria-label="Real Linux terminal"></div>';
  const term = new Terminal({
      cursorBlink: true,
      fontFamily: "Consolas, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: "#24212d",
        foreground: "#e1d8ed",
        cursor: "#c3a0c9",
        selectionBackground: "#89749f70",
      },
    }),
    fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($(".real-terminal", b));
  let socket = null,
    observer;
  const status = $(".terminal-status>span:nth-child(2)", b);
  const resize = () => {
    try {
      fit.fit();
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
        );
    } catch {}
  };
  const connect = () => {
    socket?.close();
    if (!connected) {
      status.textContent =
        "Backend offline. Start docker compose up --build, then reconnect.";
      return;
    }
    socket = new WebSocket(wsURL("/api/terminal"));
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      status.textContent = "Real Bash · Debian Linux · isolated container";
      resize();
      term.focus();
    };
    socket.onmessage = (e) => term.write(new Uint8Array(e.data));
    socket.onclose = () =>
      (status.textContent =
        "Shell disconnected. Reconnect to start a new session.");
    socket.onerror = () =>
      (status.textContent = "Cannot connect to Linux. Check the backend.");
  };
  term.onData((data) => {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: "input", data }));
  });
  $(".reconnect-terminal", b).onclick = async () => {
    await connectBackend();
    connect();
  };
  observer = new ResizeObserver(resize);
  observer.observe(b);
  setTimeout(() => {
    resize();
    connect();
  }, 50);
  const cleanup = () => {
    observer.disconnect();
    socket?.close();
    term.dispose();
  };
  windows.get("terminal")._cleanup = cleanup;
};
renderers.terminal = renderTerminal;
const originalClose = closeWindow;
closeWindow = function (id) {
  const w = windows.get(id);
  if (id === "terminal") w?._cleanup?.();
  originalClose(id);
};
const originalEditor = renderEditor;
renderers.editor = renderEditor = function (b) {
  originalEditor(b);
  $(".output-text", b).textContent = connected
    ? "Ready. Run executes real CPython in the Linux container."
    : "Backend offline. Start docker compose up --build.";
  const panel = $(".output-panel", b);
  panel.insertAdjacentHTML(
    "beforeend",
    '<form class="python-input"><label>stdin ›</label><input aria-label="Python program input" placeholder="Type input for your program, then Enter" autocomplete="off"><button>Send</button></form>',
  );
  $(".python-input", b).onsubmit = (e) => {
    e.preventDefault();
    const input = $(".python-input input", b);
    if (runSocket?.readyState === WebSocket.OPEN) {
      runSocket.send(
        JSON.stringify({ type: "input", text: input.value + "\n" }),
      );
      input.value = "";
    } else toast("Run a Python program first.");
  };
};
runEditor = async function () {
  const w = windows.get("editor");
  if (!w) return;
  const out = $(".output-text", w);
  out.textContent = "";
  if (!connected) {
    out.textContent =
      "Linux backend is disconnected. Start docker compose up --build and reload.";
    return;
  }
  if (runSocket) {
    out.textContent = "A program is already running. Stop it first.";
    return;
  }
  const code = $(".code-editor", w).value;
  out.textContent = "Starting CPython in Linux…\n";
  const ws = (runSocket = new WebSocket(wsURL("/api/run")));
  ws.onopen = () => ws.send(JSON.stringify({ code, path: editPath }));
  ws.onmessage = async (event) => {
    const m = JSON.parse(event.data);
    if (m.type === "output" || m.type === "error") out.textContent += m.text;
    if (m.type === "done") {
      out.textContent += "\nProcess exited with code " + m.exitCode + ".\n";
      await pullFiles();
    }
    out.scrollTop = out.scrollHeight;
  };
  ws.onerror = () =>
    (out.textContent +=
      "\nCould not connect to the Linux execution backend.\n");
  ws.onclose = () => {
    if (runSocket === ws) runSocket = null;
  };
};
stopPython = function () {
  if (runSocket?.readyState === WebSocket.OPEN) {
    runSocket.send(JSON.stringify({ type: "stop" }));
  } else toast("No Python program is running.");
};
renderers.welcome = function (b) {
  b.innerHTML = `<div class="welcome"><div class="eyebrow">YOUR OWN LINUX WORKSPACE</div><h2>A little computer. Real execution.</h2><p>A real Bash terminal and Python editor, connected to the same<br>isolated Linux container. Make something that actually runs.</p><div class="welcome-apps"><button data-open="editor"><span>⌘</span><strong>Write Python</strong><small>Real CPython. Real output.</small></button><button data-open="terminal"><span>›_</span><strong>Open Bash</strong><small>Commands run in Linux.</small></button><button data-open="files"><span>▰</span><strong>Explore your files</strong><small>A shared Linux filesystem.</small></button></div><div class="notice">${connected ? "Connected to a real Debian Linux container on your computer." : "Backend offline. Run <code>docker compose up --build</code> and open <code>http://localhost:4180</code>."}<br>Raspberry Pi-inspired workspace · hardware and ARM-specific behavior require a real Pi.</div></div>`;
};
renderers.gpio = function (b) {
  b.innerHTML =
    '<div class="help-content"><div class="eyebrow">PHYSICAL HARDWARE</div><h2>GPIO needs a real board.</h2><p>This container executes real Linux commands and Python, but it does not have physical Raspberry Pi GPIO, cameras, HATs, or sensors. Hardware-specific libraries may fail without those devices.</p><p>No simulated GPIO results are presented as hardware execution. Use this workspace to develop general Python and Linux code; test hardware integration on a physical Pi.</p></div>';
};
renderers.help = function (b) {
  b.innerHTML = `<article class="help-content"><div class="eyebrow">REAL EXECUTION · LOCAL LAB</div><h2>Your Linux workbench.</h2><h3>Terminal</h3><p>A real Bash shell over a pseudo-terminal. Run <code>ls</code>, <code>pwd</code>, <code>python3</code>, <code>nano hello.py</code>, shell scripts, pipes, or interactive programs. Ctrl+C interrupts; Ctrl+D exits. Terminal commands run inside the container, not your Windows host.</p><h3>Python Editor</h3><p>Write Python and press Run or F5. Output and errors stream from a real CPython process. Use the input box below the console for <code>input()</code>. Stop kills the process group. Runs have a 10 minute limit. Save with Ctrl/Cmd+S to share your file with the terminal.</p><h3>Files and packages</h3><p>File Manager and Python share <code>/home/pi</code> with Bash. Files refresh automatically, and persist in a Docker volume across container restarts. Export a workspace backup from Preferences. The terminal runs as root inside this personal container, so <code>apt update</code> and <code>apt install</code> can install packages. Installed packages survive restarts but are lost on image rebuild; add permanent dependencies to Dockerfile. Outbound network access is needed for installs.</p><h3>What this environment is</h3><p>Debian Linux on your computer’s CPU architecture, with a Raspberry Pi-inspired interface. It is not Raspberry Pi OS, an ARM emulator, or physical hardware. GPIO, USB peripherals, and Pi-specific camera interfaces are not supplied.</p><h3>Local use only</h3><p>Start with <code>docker compose up --build</code>, then open <code>http://localhost:4180</code>. This is a single-user development service bound to loopback. Do not expose it publicly. A multi-user hosted version requires authentication and a separate isolated execution environment per user.</p></article>`;
};
// Connect the launchpad and preferences to the Linux environment.
$(".desktop-bottom>span:last-child").textContent =
  "Real Linux execution · physical hardware unavailable";
$(".small-note").textContent = "Real Linux execution · Docker backend required";
$(".landing-main p").innerHTML =
  "A real Linux terminal and Python workspace.<br>Run commands, write code, and explore.<br>No Raspberry Pi board required.";
$(".landing-footer>div>span:nth-child(2)").textContent =
  "⌁ Real Bash + CPython";
const oldSettings = renderers.settings;
renderers.settings = function (b) {
  oldSettings(b);
  b.querySelectorAll("p").forEach((el) => {
    if (el.textContent.includes("Saved files and preferences"))
      el.innerHTML =
        "Files are saved in the Linux container’s /home/pi volume.<br>Export a backup before removing Docker volumes.";
    if (el.textContent.includes("Pi Lab · Browser Edition"))
      el.innerHTML =
        "Pi Lab · Linux Edition 2.0<br>Independent project. Not affiliated with Raspberry Pi.<br>Terminal: real Bash · Python: real CPython · Hardware: unavailable";
  });
};
connectBackend();
setInterval(async () => {
  if (!connected) {
    await connectBackend();
    return;
  }
  try {
    if (!syncing) await pullFiles();
  } catch {
    setConnection(false);
  }
}, 4000);
