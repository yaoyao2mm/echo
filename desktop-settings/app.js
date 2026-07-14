const params = new URLSearchParams(window.location.search);
const settingsKey = params.get("key") || "";

const elements = {
  loadingView: document.querySelector("#loadingView"),
  mainView: document.querySelector("#mainView"),
  setupView: document.querySelector("#setupView"),
  form: document.querySelector("#settingsForm"),
  desktopName: document.querySelector("#desktopName"),
  connectionBadge: document.querySelector("#connectionBadge"),
  connectionLabel: document.querySelector("#connectionLabel"),
  pairingQr: document.querySelector("#pairingQr"),
  pairingHint: document.querySelector("#pairingHint"),
  copyPairingUrl: document.querySelector("#copyPairingUrl"),
  relayStatus: document.querySelector("#relayStatus"),
  agentStatus: document.querySelector("#agentStatus"),
  capabilityStatus: document.querySelector("#capabilityStatus"),
  detailsToggle: document.querySelector("#detailsToggle"),
  detailsPanel: document.querySelector("#detailsPanel"),
  detailsList: document.querySelector("#detailsList"),
  envPath: document.querySelector("#envPath"),
  toast: document.querySelector("#toast")
};

let pairingUrl = "";
let currentState = null;
let toastTimer = null;

if (!settingsKey) {
  finishLoading();
  showSetup();
  showToast("本地连接密钥缺失", { error: true, sticky: true });
} else {
  bindEvents();
  await loadState();
  window.setInterval(() => loadHealth({ quiet: true }), 10000);
}

function bindEvents() {
  elements.form.addEventListener("submit", saveConnection);
  document.querySelector("#refreshPairingQr").addEventListener("click", () => loadPairing({ announce: true }));
  elements.copyPairingUrl.addEventListener("click", copyPairingUrl);
  document.querySelector("#restartAgent").addEventListener("click", (event) => runAction(event.currentTarget, "/api/desktop/restart", "正在重启", "Agent 已重启"));
  document.querySelector("#networkTest").addEventListener("click", (event) => runAction(event.currentTarget, "/api/test/network", "正在诊断", "网络诊断完成"));
  document.querySelector("#desktopUpdate").addEventListener("click", (event) => runAction(event.currentTarget, "/api/desktop/update", "正在更新", "更新完成"));
  elements.detailsToggle.addEventListener("click", toggleDetails);
}

async function loadState() {
  try {
    const state = await apiGet("/api/state");
    currentState = state;
    fillSetupForm(state.fields);
    renderState(state);
    finishLoading();

    if (hasConnectionConfig(state.fields)) {
      showMain();
      await loadPairing();
    } else {
      showSetup();
    }
  } catch (error) {
    finishLoading();
    showSetup();
    setConnectionState("offline", "不可用");
    showToast(error.message, { error: true, sticky: true });
  }
}

async function loadHealth(options = {}) {
  try {
    const result = await apiGet("/api/desktop/health");
    if (!currentState) currentState = { fields: {}, envFile: "" };
    currentState.health = result.health;
    renderState(currentState);
    if (!options.quiet) showToast("状态已刷新");
  } catch (error) {
    setConnectionState("offline", "已断开");
    if (!options.quiet) showToast(error.message, { error: true });
  }
}

function renderState(state) {
  const health = state.health || {};
  const relay = health.relay || {};
  const relayCodex = relay.codex || {};
  const runtime = relayCodex.runtime || {};
  const backends = runtimeBackends(runtime);
  const workspaces = Array.isArray(relayCodex.workspaces) ? relayCodex.workspaces : health.workspaces?.items || [];
  const displayName = valueOf(state.fields, "ECHO_AGENT_DISPLAY_NAME") || valueOf(state.fields, "ECHO_AGENT_ID") || "Desktop";
  const agentOnline = Boolean(relayCodex.agentOnline || health.agent?.ok);
  const relayOnline = Boolean(relay.ok);

  elements.desktopName.textContent = displayName;
  elements.envPath.textContent = state.envFile || "";

  if (relayOnline && agentOnline) setConnectionState("online", "已连接");
  else if (relayOnline) setConnectionState("loading", "启动中");
  else setConnectionState("offline", "未连接");

  setStatus(elements.relayStatus, relayOnline ? "在线" : relay.status || "离线", relayOnline);
  setStatus(elements.agentStatus, agentOnline ? "运行中" : health.agent?.status || "未运行", agentOnline);
  setStatus(elements.capabilityStatus, capabilityLabel(backends, workspaces), backends.length > 0 && workspaces.length > 0);

  renderDetails({
    relayUrl: health.connection?.relayUrl || valueOf(state.fields, "ECHO_RELAY_URL") || "-",
    agentId: valueOf(state.fields, "ECHO_AGENT_ID") || "-",
    backends,
    workspaces,
    proxy: health.connection?.proxy || "direct",
    updatedAt: health.generatedAt || ""
  });
}

function renderDetails({ relayUrl, agentId, backends, workspaces, proxy, updatedAt }) {
  const rows = [
    ["Relay", relayUrl],
    ["Agent ID", agentId],
    ["Backends", backends.map((item) => item.backendName || item.backendId).filter(Boolean).join(", ") || "-"],
    ["Workspaces", String(workspaces.length)],
    ["Proxy", proxy || "direct"],
    ["Updated", formatTime(updatedAt) || "-"]
  ];

  elements.detailsList.replaceChildren();
  for (const [label, value] of rows) {
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    detail.title = value;
    elements.detailsList.append(term, detail);
  }
}

async function loadPairing(options = {}) {
  elements.pairingQr.classList.remove("error");
  elements.pairingQr.innerHTML = '<div class="qrLoading"><span></span><span></span><span></span></div>';
  elements.copyPairingUrl.disabled = true;
  try {
    const pairing = await apiGet("/api/pairing");
    pairingUrl = pairing.mobileUrl;
    elements.pairingQr.innerHTML = pairing.qrSvg;
    elements.pairingHint.textContent = "用手机扫描二维码";
    elements.copyPairingUrl.disabled = false;
    if (options.announce) showToast("二维码已刷新");
  } catch (error) {
    pairingUrl = "";
    elements.pairingQr.classList.add("error");
    elements.pairingQr.textContent = "配对二维码不可用";
    elements.pairingHint.textContent = "检查 Relay 和配对 Token";
    elements.copyPairingUrl.disabled = true;
    if (options.announce) showToast(error.message, { error: true });
  }
}

async function copyPairingUrl() {
  if (!pairingUrl) await loadPairing();
  if (!pairingUrl) return;
  try {
    await navigator.clipboard.writeText(pairingUrl);
    showToast("配对链接已复制");
  } catch (error) {
    showToast(error.message || "复制失败", { error: true });
  }
}

async function saveConnection(event) {
  event.preventDefault();
  const submit = event.submitter || elements.form.querySelector('button[type="submit"]');
  const values = {};
  for (const input of elements.form.querySelectorAll("[data-key]")) {
    values[input.dataset.key] = input.value;
  }

  setButtonPending(submit, true, "正在连接");
  try {
    const result = await apiPost("/api/config", { values, clearSecrets: {} });
    currentState = { ...(currentState || {}), fields: result.fields };
    await apiPost("/api/desktop/restart", {});
    await loadState();
    showToast("已保存并连接");
  } catch (error) {
    showToast(error.message, { error: true });
  } finally {
    setButtonPending(submit, false);
  }
}

async function runAction(button, path, pendingLabel, successLabel) {
  setButtonPending(button, true, pendingLabel);
  try {
    const result = await apiPost(path, {});
    if (result.ok === false) throw new Error(commandError(result));
    showToast(successLabel);
    window.setTimeout(() => loadHealth({ quiet: true }), 800);
  } catch (error) {
    showToast(error.message, { error: true });
  } finally {
    setButtonPending(button, false);
  }
}

function fillSetupForm(fields = {}) {
  for (const input of elements.form.querySelectorAll("[data-key]")) {
    const field = fields[input.dataset.key];
    if (!field) continue;
    if (input.dataset.secret === "true") {
      input.value = "";
      input.placeholder = field.set ? "已设置，留空保持" : input.placeholder;
      if (field.set) input.required = false;
    } else {
      input.value = field.value || "";
    }
  }
}

function hasConnectionConfig(fields = {}) {
  return Boolean(valueOf(fields, "ECHO_RELAY_URL") && (fields.ECHO_AGENT_TOKEN?.set || fields.ECHO_TOKEN?.set));
}

function runtimeBackends(runtime = {}) {
  if (Array.isArray(runtime.backends) && runtime.backends.length) return runtime.backends.filter(Boolean);
  return runtime.backendId || runtime.provider ? [runtime] : [];
}

function capabilityLabel(backends, workspaces) {
  const backendCount = backends.length;
  const workspaceCount = workspaces.length;
  if (!backendCount && !workspaceCount) return "等待同步";
  return `${backendCount} 个后端 · ${workspaceCount} 个项目`;
}

function setStatus(node, label, ok) {
  node.textContent = label;
  node.classList.toggle("good", Boolean(ok));
  node.classList.toggle("bad", ok === false);
}

function setConnectionState(state, label) {
  elements.connectionBadge.classList.remove("online", "offline", "loading");
  elements.connectionBadge.classList.add(state);
  elements.connectionLabel.textContent = label;
}

function toggleDetails() {
  const expanded = elements.detailsToggle.getAttribute("aria-expanded") === "true";
  elements.detailsToggle.setAttribute("aria-expanded", String(!expanded));
  elements.detailsPanel.hidden = expanded;
}

function showMain() {
  elements.mainView.hidden = false;
  elements.setupView.hidden = true;
}

function showSetup() {
  elements.mainView.hidden = true;
  elements.setupView.hidden = false;
}

function finishLoading() {
  elements.loadingView.hidden = true;
}

function setButtonPending(button, pending, label = "") {
  if (!button) return;
  if (pending) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = label;
    button.disabled = true;
    return;
  }
  button.textContent = button.dataset.originalLabel || button.textContent;
  button.disabled = false;
  delete button.dataset.originalLabel;
}

function showToast(message, options = {}) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = String(message || "");
  elements.toast.classList.toggle("error", Boolean(options.error));
  elements.toast.hidden = false;
  if (!options.sticky) {
    toastTimer = window.setTimeout(() => {
      elements.toast.hidden = true;
    }, 2600);
  }
}

function commandError(result = {}) {
  return String(result.stderr || result.stdout || `操作失败 (${result.code ?? "unknown"})`).trim();
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function valueOf(fields, key) {
  return fields?.[key]?.value || "";
}

async function apiGet(path) {
  const response = await fetch(path, { headers: { "X-Echo-Settings-Key": settingsKey } });
  return parseApiResponse(response);
}

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Echo-Settings-Key": settingsKey
    },
    body: JSON.stringify(body)
  });
  return parseApiResponse(response);
}

async function parseApiResponse(response) {
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
}
