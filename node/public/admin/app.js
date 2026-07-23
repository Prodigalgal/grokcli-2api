const state = { password: sessionStorage.getItem("grok2api-admin-password") || "", tab: "overview", accountPage: 1 };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function setConnection(text, kind = "") {
  const node = $("#connection-state");
  node.textContent = text;
  node.className = `state ${kind}`;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("x-admin-password", state.password);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
  return payload;
}

function date(value) {
  return typeof value === "number" && value > 0 ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-";
}

function status(value) {
  const normalized = String(value || "-");
  const kind = /succeeded|normal|active|waiting_user/.test(normalized) ? "good" : /failed|expired|disabled|cancelled/.test(normalized) ? "bad" : "warn";
  return `<span class="status ${kind}">${escapeHtml(normalized)}</span>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (item) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[item]));
}

function json(value) { return JSON.stringify(value || {}, null, 2); }

function showTab(tab) {
  state.tab = tab;
  $$("[data-tab]").forEach((node) => node.classList.toggle("active", node.dataset.tab === tab));
  $$("[data-panel]").forEach((node) => node.classList.toggle("active", node.dataset.panel === tab));
  void loadTab();
}

async function loadOverview() {
  const data = await api("/admin/api/status");
  const metrics = [
    ["账号", data.accounts?.account_count || 0], ["可用", data.accounts?.active_count || 0],
    ["API Key", data.keys?.enabled || 0], ["模型", data.models_count || 0],
  ];
  $("#overview-grid").innerHTML = metrics.map(([name, value]) => `<div class="metric"><span>${escapeHtml(name)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  $("#pool-summary").textContent = json(data.pool);
  $("#usage-summary").textContent = json(data.usage);
  setConnection(data.direct_xai?.configured ? "已连接" : "缺少上游", data.direct_xai?.configured ? "ready" : "error");
}

async function loadAccounts() {
  const query = new URLSearchParams({ page: String(state.accountPage), page_size: "25" });
  const q = $("#account-query").value.trim();
  const filter = $("#account-status").value;
  if (q) query.set("q", q);
  if (filter) query.set("status", filter);
  const data = await api(`/admin/api/accounts?${query}`);
  $("#accounts-body").innerHTML = data.accounts.map((account) => `<tr>
    <td><strong>${escapeHtml(account.email || account.id)}</strong><br><small>${escapeHtml(account.id)}</small></td>
    <td>${status(account.poolStatus)}</td><td>${account.weight}</td><td>${account.requestCount}</td><td>${date(account.expiresAt)}</td>
    <td><div class="row-actions"><button type="button" data-account-toggle="${escapeHtml(account.id)}" data-enabled="${account.enabled}">${account.enabled ? "停用" : "启用"}</button>${account.hasEmailMailbox ? `<button type="button" data-account-email="${escapeHtml(account.id)}">邮箱码</button>` : ""}<button type="button" data-account-device="${escapeHtml(account.id)}">设备码</button></div></td>
  </tr>`).join("") || `<tr><td colspan="6">没有匹配账号</td></tr>`;
  $("#account-pagination").innerHTML = `<button type="button" ${data.page <= 1 ? "disabled" : ""} id="page-prev">上一页</button><span>${data.page || 0} / ${data.totalPages || 0}，共 ${data.total || 0} 个</span><button type="button" ${data.page >= data.totalPages ? "disabled" : ""} id="page-next">下一页</button>`;
  $("#page-prev")?.addEventListener("click", () => { state.accountPage -= 1; void loadAccounts(); });
  $("#page-next")?.addEventListener("click", () => { state.accountPage += 1; void loadAccounts(); });
  $$('[data-account-toggle]').forEach((button) => button.addEventListener("click", async () => {
    await api(`/admin/api/accounts/${encodeURIComponent(button.dataset.accountToggle)}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: button.dataset.enabled !== "true" }) });
    await loadAccounts();
  }));
  $$('[data-account-device]').forEach((button) => button.addEventListener("click", () => void startDeviceLogin(button.dataset.accountDevice)));
  $$('[data-account-email]').forEach((button) => button.addEventListener("click", () => emailLoginDialog(button.dataset.accountEmail)));
}

async function loadKeys() {
  const data = await api("/admin/api/keys");
  $("#keys-body").innerHTML = data.keys.map((key) => `<tr><td>${escapeHtml(key.name)}</td><td>${escapeHtml(key.prefix)}</td><td>${status(key.enabled ? "active" : "disabled")}</td><td>${key.requestCount}</td><td>${key.totalTokensTotal}</td><td><div class="row-actions"><button type="button" data-key-toggle="${escapeHtml(key.id)}" data-enabled="${key.enabled}">${key.enabled ? "停用" : "启用"}</button><button type="button" data-key-rotate="${escapeHtml(key.id)}">轮换</button></div></td></tr>`).join("") || `<tr><td colspan="6">没有 API Key</td></tr>`;
  $$('[data-key-toggle]').forEach((button) => button.addEventListener("click", async () => { await api(`/admin/api/keys/${encodeURIComponent(button.dataset.keyToggle)}`, { method: "PATCH", body: JSON.stringify({ enabled: button.dataset.enabled !== "true" }) }); await loadKeys(); }));
  $$('[data-key-rotate]').forEach((button) => button.addEventListener("click", async () => { const data = await api(`/admin/api/keys/${encodeURIComponent(button.dataset.keyRotate)}/regenerate`, { method: "POST" }); showSecret(data.secret); await loadKeys(); }));
}

async function loadDevices() {
  const data = await api("/admin/api/device/sessions");
  $("#devices-body").innerHTML = data.sessions.map((session) => `<tr><td><strong>${escapeHtml(session.userCode)}</strong></td><td>${status(session.status)}</td><td>${escapeHtml(session.email || session.targetAccountId || "-")}</td><td>${date(session.expiresAt)}</td><td><div class="row-actions"><button type="button" data-device-open="${escapeHtml(session.verificationUrl)}">打开验证页</button></div></td></tr>`).join("") || `<tr><td colspan="5">没有设备登录会话</td></tr>`;
  $$('[data-device-open]').forEach((button) => button.addEventListener("click", () => window.open(button.dataset.deviceOpen, "_blank", "noopener")));
}

async function loadTasks() {
  const data = await api("/admin/api/automation/tasks?limit=100");
  $("#tasks-body").innerHTML = data.tasks.map((task) => `<tr><td>${escapeHtml(task.kind)}</td><td>${status(task.status)}</td><td>${task.attempts}</td><td>${date(task.updatedAt)}</td><td><div class="row-actions">${["queued", "waiting_input"].includes(task.status) ? `<button type="button" data-task-cancel="${escapeHtml(task.id)}">取消</button>` : ""}</div></td></tr>`).join("") || `<tr><td colspan="5">没有自动化任务</td></tr>`;
  $$('[data-task-cancel]').forEach((button) => button.addEventListener("click", async () => { await api(`/admin/api/automation/tasks/${encodeURIComponent(button.dataset.taskCancel)}/cancel`, { method: "POST" }); await loadTasks(); }));
}

async function loadTab() {
  try {
    if (state.tab === "overview") await loadOverview();
    if (state.tab === "accounts") await loadAccounts();
    if (state.tab === "keys") await loadKeys();
    if (state.tab === "device") await loadDevices();
    if (state.tab === "tasks") await loadTasks();
  } catch (error) { setConnection(error.message || "连接失败", "error"); }
}

function dialog(title, fields, submit) {
  $("#dialog-title").textContent = title;
  $("#dialog-fields").innerHTML = fields;
  $("#dialog-error").hidden = true;
  const form = $("#dialog-form");
  const close = () => $("#form-dialog").close();
  $("#dialog-close").onclick = close;
  form.onsubmit = async (event) => {
    event.preventDefault();
    try { await submit(new FormData(form)); close(); await loadTab(); }
    catch (error) { const message = $("#dialog-error"); message.textContent = error.message || "操作失败"; message.hidden = false; }
  };
  $("#form-dialog").showModal();
}

async function startDeviceLogin(accountId = "") {
  const data = await api("/admin/api/device/login", { method: "POST", body: JSON.stringify(accountId ? { account_id: accountId } : {}) });
  window.open(data.session.verificationUrl, "_blank", "noopener");
  showTab("device");
}

function showSecret(secret) {
  $("#issued-secret").textContent = secret;
  $("#secret-dialog").showModal();
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.password = $("#admin-password").value;
  try {
    await api("/admin/api/status");
    sessionStorage.setItem("grok2api-admin-password", state.password);
    $("#login-view").hidden = true; $("#app-view").hidden = false; await loadTab();
  } catch (error) { const message = $("#login-error"); message.textContent = error.message || "认证失败"; message.hidden = false; }
});
$("#logout-button").addEventListener("click", () => { sessionStorage.removeItem("grok2api-admin-password"); state.password = ""; $("#app-view").hidden = true; $("#login-view").hidden = false; setConnection("未连接"); });
$("#refresh-button").addEventListener("click", () => void loadTab());
$$('[data-tab]').forEach((button) => button.addEventListener("click", () => showTab(button.dataset.tab)));
$("#account-search").addEventListener("click", () => { state.accountPage = 1; void loadAccounts(); });
$("#device-start").addEventListener("click", () => void startDeviceLogin());
$("#device-start-secondary").addEventListener("click", () => void startDeviceLogin());
$("#key-create").addEventListener("click", () => dialog("创建 API Key", `<label>名称<input name="name" required maxlength="120"></label><label>备注<input name="note" maxlength="1000"></label>`, async (form) => { const data = await api("/admin/api/keys", { method: "POST", body: JSON.stringify({ name: form.get("name"), note: form.get("note") }) }); showSecret(data.secret); }));
$("#registration-start").addEventListener("click", () => browserTaskDialog("注册任务", "/admin/api/accounts/register"));
$("#automation-start").addEventListener("click", () => browserTaskDialog("浏览器任务", "/admin/api/automation/browser"));
$("#copy-secret").addEventListener("click", async () => { await navigator.clipboard.writeText($("#issued-secret").textContent || ""); });

function browserTaskDialog(title, endpoint) {
  dialog(title, `<label>浏览器工作流 JSON<textarea name="browser" required>{"url":"https://accounts.x.ai/","actions":[]}</textarea></label><label>幂等键（可选）<input name="idempotency_key"></label>`, async (form) => {
    const body = { browser: JSON.parse(String(form.get("browser") || "{}")), idempotency_key: String(form.get("idempotency_key") || "") || undefined };
    await api(endpoint, { method: "POST", body: JSON.stringify(body) });
  });
}

function emailLoginDialog(accountId) {
  dialog("邮箱验证码重登", `<label>浏览器工作流 JSON<textarea name="browser" required>{"url":"https://accounts.x.ai/","actions":[{"type":"fill","selector":"#email","value":"{{account.email}}"}]}</textarea></label><label>幂等键（可选）<input name="idempotency_key"></label>`, async (form) => {
    const body = { browser: JSON.parse(String(form.get("browser") || "{}")), idempotency_key: String(form.get("idempotency_key") || "") || undefined };
    await api(`/admin/api/accounts/${encodeURIComponent(accountId)}/email-login`, { method: "POST", body: JSON.stringify(body) });
    showTab("tasks");
  });
}

if (state.password) { $("#admin-password").value = state.password; $("#login-form").requestSubmit(); }
