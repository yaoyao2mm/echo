const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const rootDir = resolveRootDir();
const settingsScript = path.join(rootDir, "scripts", "desktop-settings.js");
const desktopAgentScript = path.join(rootDir, "src", "desktop-agent.js");
const desktopUpdateScript = path.join(rootDir, "scripts", "desktop-update.sh");
const networkDoctorScript = path.join(rootDir, "scripts", "network-doctor.js");
const logsDir = path.join(os.homedir(), "Library", "Logs", "EchoVoice");
const desktopAppLog = path.join(logsDir, "desktop-app.log");
const appAgentOutLog = path.join(logsDir, "desktop-agent-app.out.log");
const appAgentErrLog = path.join(logsDir, "desktop-agent-app.err.log");
const appDisplayName = "Echo";

let mainWindow = null;
let settingsProcess = null;
let appAgentProcess = null;
let appAgentWanted = false;
let appAgentRestartTimer = null;
let settingsUrl = "";
let stdoutBuffer = "";
let stderrBuffer = "";
let tray = null;
let isQuitting = false;
let settingsRestartRequested = false;
let settingsUpdateReady = false;
let desktopUpdateProcess = null;

app.setName(appDisplayName);
logApp(`starting root=${rootDir}`);

process.on("uncaughtException", (error) => {
  logApp(`uncaughtException ${error.stack || error.message}`);
  dialog.showErrorBox(`${appDisplayName} crashed`, error.message);
});

process.on("unhandledRejection", (error) => {
  const message = error?.stack || error?.message || String(error);
  logApp(`unhandledRejection ${message}`);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  logApp("single instance lock denied");
  app.quit();
} else {
  app.on("second-instance", () => {
    maybeStartAppAgent().catch((error) => logApp(`maybeStartAppAgent second-instance failed ${error.message}`));
    showSettings();
  });
}

app.whenReady().then(async () => {
  logApp("ready");
  createMenu();
  createTray();
  startSettingsServer();
  await maybeStartAppAgent();
});

app.on("activate", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else if (settingsUrl) {
    openSettingsWindow(settingsUrl);
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  appAgentWanted = false;
  stopAppAgent();
  stopSettingsServer();
});

function resolveRootDir() {
  const packagedRootFile = path.join(process.resourcesPath || "", "echo-root");
  try {
    const value = fs.readFileSync(packagedRootFile, "utf8").trim();
    if (value) return value;
  } catch {
    // Dev mode uses the repository root above desktop-app.
  }
  return path.resolve(__dirname, "..");
}

function logApp(message) {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(desktopAppLog, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Logging should never prevent the desktop shell from starting.
  }
}

function startSettingsServer() {
  stdoutBuffer = "";
  stderrBuffer = "";
  settingsUrl = "";
  logApp(`starting settings service ${settingsScript}`);
  settingsProcess = spawn(process.execPath, [settingsScript], {
    cwd: rootDir,
    env: buildDesktopEnv({
      ...readDotEnvFile(),
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ECHO_SETTINGS_HOST: "127.0.0.1",
      ECHO_SETTINGS_PORT: "0"
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });

  settingsProcess.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    if (stdoutBuffer.includes("ECHO_DESKTOP_UPDATE_READY")) {
      settingsUpdateReady = true;
      logApp("settings service reported desktop update ready");
    }
    if (stdoutBuffer.includes("ECHO_DESKTOP_AGENT_RESTART_REQUESTED")) {
      stdoutBuffer = stdoutBuffer.replaceAll("ECHO_DESKTOP_AGENT_RESTART_REQUESTED", "");
      logApp("settings service requested app agent restart");
      restartAppAgent();
    }
    const url = stdoutBuffer.match(/https?:\/\/127\.0\.0\.1:\d+\/\?key=[a-f0-9]+/i)?.[0];
    if (url && !settingsUrl) {
      settingsUrl = url;
      logApp(`settings service ready ${url.replace(/key=.*/i, "key=<redacted>")}`);
      openSettingsWindow(url);
    }
  });

  settingsProcess.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
  });

  settingsProcess.on("exit", (code) => {
    logApp(`settings service exited code=${code ?? "unknown"}`);
    const shouldRestart = !isQuitting && (settingsRestartRequested || Boolean(settingsUrl));
    const shouldRestartAgent = settingsUpdateReady;
    settingsProcess = null;
    settingsRestartRequested = false;
    settingsUpdateReady = false;

    if (shouldRestart) {
      startSettingsServer();
      if (shouldRestartAgent) restartAgentAfterUpdate();
      return;
    }

    if (!settingsUrl) {
      dialog.showErrorBox(
        `${appDisplayName} could not start`,
        `The local settings service exited with code ${code ?? "unknown"}.\n\n${stderrBuffer.slice(-2000)}`
      );
      app.quit();
    }
  });
}

function stopSettingsServer() {
  if (!settingsProcess || settingsProcess.killed) return;
  settingsProcess.kill();
  settingsProcess = null;
}

function requestSettingsRestart() {
  settingsRestartRequested = true;
  if (settingsProcess && !settingsProcess.killed) {
    settingsProcess.kill("SIGTERM");
    return;
  }
  startSettingsServer();
}

function openSettingsWindow(url) {
  if (mainWindow) {
    if (url && mainWindow.webContents.getURL() !== url) {
      mainWindow.loadURL(url);
    }
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 440,
    minHeight: 600,
    title: appDisplayName,
    backgroundColor: "#f6f7f8",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadURL(url);

  mainWindow.on("close", (event) => {
    if (isQuitting || process.platform !== "darwin") return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (process.platform !== "darwin") app.quit();
  });
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip(appDisplayName);
  refreshTray();
  tray.on("click", () => showSettings());
}

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(`${appDisplayName} · ${agentStatusLabel()}`);
  tray.setContextMenu(buildTrayMenu());
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: `Agent: ${agentStatusLabel()}`,
      enabled: false
    },
    {
      label: "Show Settings",
      click: () => showSettings()
    },
    {
      label: "Open In Browser",
      click: () => {
        if (settingsUrl) shell.openExternal(settingsUrl);
      }
    },
    { type: "separator" },
    {
      label: "Start App Agent",
      click: () => startAppAgent({ userInitiated: true })
    },
    {
      label: "Stop App Agent",
      enabled: Boolean(appAgentProcess),
      click: () => {
        appAgentWanted = false;
        stopAppAgent();
      }
    },
    {
      label: "Restart App Agent",
      click: () => restartAppAgent()
    },
    {
      label: "Update Desktop App",
      enabled: !desktopUpdateProcess,
      click: () => runDesktopUpdate()
    },
    {
      label: "Network Doctor",
      click: () => runNetworkDoctor()
    },
    {
      label: "Open Logs",
      click: () => shell.openPath(logsDir)
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit()
    }
  ]);
}

function showSettings() {
  if (settingsUrl) {
    openSettingsWindow(settingsUrl);
  }
}

async function maybeStartAppAgent() {
  if (readEnvFlag("ECHO_DESKTOP_APP_AGENT", true) === false) return;
  startAppAgent();
}

function startAppAgent({ userInitiated = false } = {}) {
  if (appAgentProcess) {
    refreshTray();
    return;
  }

  appAgentWanted = true;
  fs.mkdirSync(logsDir, { recursive: true });
  const out = fs.createWriteStream(appAgentOutLog, { flags: "a" });
  const err = fs.createWriteStream(appAgentErrLog, { flags: "a" });
  const env = buildDesktopEnv({
    ...readDotEnvFile(),
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1"
  });

  appAgentProcess = spawn(process.execPath, [desktopAgentScript], {
    cwd: rootDir,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  out.write(`\n[${new Date().toISOString()}] ${appDisplayName} app agent starting\n`);
  logApp(`app agent started pid=${appAgentProcess.pid}`);
  appAgentProcess.stdout.pipe(out);
  appAgentProcess.stderr.pipe(err);
  refreshTray();

  appAgentProcess.on("exit", (code, signal) => {
    out.write(`\n[${new Date().toISOString()}] ${appDisplayName} app agent exited code=${code ?? ""} signal=${signal ?? ""}\n`);
    appAgentProcess = null;
    refreshTray();
    if (!isQuitting && appAgentWanted) {
      clearTimeout(appAgentRestartTimer);
      const restartDelayMs = code === 75 ? 500 : 3000;
      appAgentRestartTimer = setTimeout(() => startAppAgent(), restartDelayMs);
    }
  });

  appAgentProcess.on("error", (error) => {
    appAgentProcess = null;
    refreshTray();
    if (userInitiated) {
      dialog.showErrorBox("Echo app agent failed", error.message);
    }
  });
}

function stopAppAgent() {
  clearTimeout(appAgentRestartTimer);
  appAgentRestartTimer = null;
  if (!appAgentProcess || appAgentProcess.killed) {
    appAgentProcess = null;
    refreshTray();
    return;
  }
  appAgentProcess.kill("SIGTERM");
  appAgentProcess = null;
  refreshTray();
}

function restartAppAgent() {
  appAgentWanted = true;
  stopAppAgent();
  setTimeout(() => startAppAgent({ userInitiated: true }), 500);
}

function restartAgentAfterUpdate() {
  restartAppAgent();
}

function agentStatusLabel() {
  if (appAgentProcess) return "app agent running";
  if (appAgentWanted) return "app agent restarting";
  return "app agent stopped";
}

function readEnvFlag(key, fallback) {
  const envValue = process.env[key] || readDotEnvValue(key);
  if (envValue === undefined || envValue === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(envValue).toLowerCase());
}

function readDotEnvFile() {
  try {
    const text = fs.readFileSync(path.join(rootDir, ".env"), "utf8");
    const values = {};
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      values[match[1]] = parseDotEnvValue(match[2]);
    }
    return values;
  } catch {
    return {};
  }
}

function readDotEnvValue(key) {
  try {
    const text = fs.readFileSync(path.join(rootDir, ".env"), "utf8");
    const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*([^\\n]*)`, "m");
    const match = text.match(pattern);
    return match ? parseDotEnvValue(match[1]) : "";
  } catch {
    return "";
  }
}

function parseDotEnvValue(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  return stripUnquotedDotEnvComment(text);
}

function stripUnquotedDotEnvComment(value) {
  const text = String(value || "");
  const commentIndex = text.search(/\s+#/);
  return commentIndex >= 0 ? text.slice(0, commentIndex).trimEnd() : text;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildDesktopEnv(env) {
  const home = app.getPath("home");
  return {
    ...env,
    HOME: env.HOME || home,
    USER: env.USER || process.env.USER || "",
    LOGNAME: env.LOGNAME || process.env.LOGNAME || process.env.USER || "",
    SHELL: env.SHELL || "/bin/zsh",
    CODEX_HOME: env.CODEX_HOME || path.join(home, ".codex"),
    PATH: normalizeDesktopPath(env.PATH, home),
    LANG: env.LANG || "en_US.UTF-8"
  };
}

function normalizeDesktopPath(value, home) {
  const segments = String(value || "")
    .split(path.delimiter)
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of defaultDesktopPathSegments(home)) {
    if (!segments.includes(segment)) segments.push(segment);
  }

  return segments.join(path.delimiter);
}

function defaultDesktopPathSegments(home) {
  return [
    path.join(home, ".local", "bin"),
    path.join(home, "Library", "pnpm"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ];
}

function runNetworkDoctor() {
  const env = buildDesktopEnv({ ...readDotEnvFile(), ...process.env, ELECTRON_RUN_AS_NODE: "1" });
  execFile(process.execPath, [networkDoctorScript], { cwd: rootDir, env, timeout: 30000 }, (error, stdout, stderr) => {
    const title = error ? "Echo network doctor failed" : "Echo network doctor finished";
    const detail = `${stdout || ""}${stderr || ""}`.trim() || (error ? error.message : "Done.");
    dialog.showMessageBox({
      type: error ? "error" : "info",
      title,
      message: title,
      detail: detail.slice(-4000)
    });
  });
}

function runDesktopUpdate() {
  if (desktopUpdateProcess) {
    dialog.showMessageBox({
      type: "info",
      title: "Echo update already running",
      message: "Echo update already running"
    });
    return;
  }

  const env = buildDesktopEnv({ ...readDotEnvFile(), ...process.env });
  desktopUpdateProcess = execFile("bash", [desktopUpdateScript], { cwd: rootDir, env, timeout: 10 * 60 * 1000 }, (error, stdout, stderr) => {
    desktopUpdateProcess = null;
    refreshTray();
    const ok = !error;
    const detail = `${stdout || ""}${stderr || error?.message || ""}`.trim() || (ok ? "Updated." : "Update failed.");

    if (!ok) {
      dialog.showMessageBox({
        type: "error",
        title: "Echo update failed",
        message: "Echo update failed",
        detail: detail.slice(-4000)
      });
      return;
    }

    logApp("desktop update completed from app menu");
    requestSettingsRestart();
    restartAgentAfterUpdate();
    dialog
      .showMessageBox({
        type: "info",
        title: "Echo update finished",
        message: "Echo update finished",
        detail: `${detail.slice(-3200)}\n\nReopen ${appDisplayName} to load any desktop shell changes.`,
        buttons: [`Relaunch ${appDisplayName}`, "Later"],
        defaultId: 0,
        cancelId: 1
      })
      .then((result) => {
        if (result.response === 0) {
          app.relaunch();
          app.exit(0);
        }
      });
  });

  refreshTray();
}

function createTrayIcon() {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">',
    '<rect width="32" height="32" rx="8" fill="#0b6f6a"/>',
    '<path d="M8 17c2.3 0 2.3-8 4.6-8s2.3 14 4.6 14 2.3-10 4.6-10 2.3 4 2.3 4" fill="none" stroke="#fff" stroke-width="2.7" stroke-linecap="round"/>',
    "</svg>"
  ].join("");
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  image.setTemplateImage(false);
  return image;
}

function createMenu() {
  const template = [
    {
      label: appDisplayName,
      submenu: [
        {
          label: "Show Settings",
          accelerator: "CommandOrControl+,",
          click: () => showSettings()
        },
        {
          label: "Open In Browser",
          click: () => {
            if (settingsUrl) shell.openExternal(settingsUrl);
          }
        },
        { type: "separator" },
        {
          label: "Start App Agent",
          click: () => startAppAgent({ userInitiated: true })
        },
        {
          label: "Stop App Agent",
          click: () => {
            appAgentWanted = false;
            stopAppAgent();
          }
        },
        {
          label: "Restart App Agent",
          click: () => restartAppAgent()
        },
        {
          label: "Update Desktop App",
          enabled: !desktopUpdateProcess,
          click: () => runDesktopUpdate()
        },
        {
          label: "Network Doctor",
          click: () => runNetworkDoctor()
        },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }]
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
