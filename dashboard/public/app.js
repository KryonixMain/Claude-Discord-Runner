// ── State ────────────────────────────────────────────────────────────────────
let connected = false;
const POLL_FAST = 5000;
const POLL_SLOW = 30000;

// ── DOM helpers ─────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Tab Navigation ──────────────────────────────────────────────────────────
const tabs = $$(".tab");
const tabContents = $$(".tab-content");
let activeTab = "overview";

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;
    if (target === activeTab) return;

    tabs.forEach((t) => t.classList.remove("active"));
    tabContents.forEach((c) => c.classList.remove("active"));

    tab.classList.add("active");
    $(`#tab-${target}`).classList.add("active");
    activeTab = target;

    // Fetch data for newly active tab
    onTabActivated(target);
  });
});

function onTabActivated(tab) {
  switch (tab) {
    case "timeouts":  fetchTimeouts(); break;
    case "analytics": fetchAnalytics(); break;
    case "archives":  fetchArchives(); break;
    case "prompts":   fetchGeneratedPrompts(); break;
    case "audit":     fetchAudit(); break;
    case "settings":  fetchSettings(); break;
  }
}

// ── Clock ────────────────────────────────────────────────────────────────────
function updateClock() {
  $("#clock").textContent = new Date().toLocaleTimeString();
}
setInterval(updateClock, 1000);
updateClock();

// ── API helpers ──────────────────────────────────────────────────────────────
async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function postCommand(cmd) {
  const res = await fetch(`/api/command/${cmd}`, { method: "POST" });
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function setConnected(ok) {
  connected = ok;
  const badge = $("#connection-badge");
  badge.className = `badge ${ok ? "badge-online" : "badge-offline"}`;
  badge.textContent = ok ? "Online" : "Offline";
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return "0m";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatTokens(n) {
  if (!n) return "0";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB: Overview
// ═══════════════════════════════════════════════════════════════════════════

async function fetchStatus() {
  try {
    const data = await api("/api/status");
    setConnected(true);

    $("#status-line").textContent = data.statusLine;
    const cardStatus = $("#card-status");
    cardStatus.textContent = data.running ? (data.paused ? "Paused" : "Running") : data.fixing ? "Security Fix" : "Idle";
    cardStatus.style.color = data.running ? (data.paused ? "var(--yellow)" : "var(--green)") : data.fixing ? "var(--purple)" : "var(--text-dim)";

    const pct = data.totalCount > 0 ? Math.round((data.completedCount / data.totalCount) * 100) : 0;
    $("#card-progress").textContent = `${data.completedCount} / ${data.totalCount}`;
    const fill = $("#progress-fill");
    fill.style.width = `${pct}%`;
    fill.className = `progress-fill ${pct >= 100 ? "green" : pct > 0 ? "yellow" : ""}`;

    $("#card-model").textContent = data.model || "—";
    $("#card-plan").textContent  = data.plan  || "—";

    // Sessions table
    const body = $("#sessions-body");
    if (data.sessions.length === 0) {
      body.innerHTML = '<tr><td colspan="5" class="muted">No sessions found</td></tr>';
    } else {
      body.innerHTML = data.sessions.map((s) => {
        const icon = s.done ? "&#10003;" : data.running ? "&#9203;" : "&#9744;";
        const iconStyle = s.done ? 'style="color:var(--green)"' : "";
        const dur = s.duration || "—";
        const tokens = s.tokenUsage?.outputTokens ? `~${formatTokens(s.tokenUsage.outputTokens)}` : "—";
        return `<tr>
          <td ${iconStyle}>${icon}</td>
          <td>${s.file}</td>
          <td>${s.promptCount}</td>
          <td>${tokens}</td>
          <td>${dur}</td>
        </tr>`;
      }).join("");
    }

    updateButtons(data);
  } catch {
    setConnected(false);
    $("#status-line").textContent = "Connection lost";
  }
}

async function fetchSessions() {
  try {
    const data = await api("/api/sessions");
    if (data.error || !data.sessions?.length) return;

    // Update token column
    const rows = $("#sessions-body").querySelectorAll("tr");
    data.sessions.forEach((s, i) => {
      if (rows[i]) {
        const cells = rows[i].querySelectorAll("td");
        if (cells[3]) cells[3].textContent = `~${formatTokens(s.outputTokens)}`;
      }
    });

    // Token budget
    const tokenBudget = $("#token-budget");
    if (data.budgetTokens > 0) {
      tokenBudget.classList.remove("hidden");
      $("#budget-used").textContent  = `~${formatTokens(data.totalOutputTokens)}`;
      $("#budget-total").textContent = `~${formatTokens(data.budgetTokens)}`;
      const pct = Math.min(100, Math.round((data.totalOutputTokens / data.budgetTokens) * 100));
      const fill = $("#budget-fill");
      fill.style.width = `${pct}%`;
      fill.className = `progress-fill budget-fill ${pct > 95 ? "red" : pct > 70 ? "yellow" : ""}`;
      $("#budget-meta").textContent = data.fitsInOneWindow
        ? `Fits in 1 window — recommended pause: ${data.recommendedPauseMinutes} min`
        : `${data.windowsNeeded} windows needed — recommended pause: ${data.recommendedPauseMinutes} min`;
    }
  } catch { /* silent */ }
}

async function fetchLogs() {
  try {
    const data = await api("/api/logs?lines=80");
    const el = $("#log-output");
    if (data.lines.length === 0) {
      el.textContent = "No log file found. Start a run first.";
    } else {
      const wasAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
      el.textContent = data.lines.join("\n");
      if (wasAtBottom) el.scrollTop = el.scrollHeight;
    }
  } catch {
    $("#log-output").textContent = "Failed to load logs.";
  }
}

async function fetchSecurity() {
  try {
    const data = await api("/api/security");
    const el = $("#security-content");
    if (data.reports.length === 0) {
      el.innerHTML = '<span class="muted">No security reports found.</span>';
      return;
    }
    const items = data.reports.map((r) => `
      <div class="security-item">
        <span>${r.name}</span>
        ${r.critical > 0 ? `<span class="sec-badge sec-critical">${r.critical}</span>` : ""}
        ${r.warning > 0  ? `<span class="sec-badge sec-warning">${r.warning}</span>`  : ""}
        ${r.info > 0     ? `<span class="sec-badge sec-info">${r.info}</span>`         : ""}
      </div>
    `).join("");
    const summary = `
      <div class="security-summary">
        <span>Critical: <strong style="color:var(--red)">${data.totalCritical}</strong></span>
        <span>Warning: <strong style="color:var(--yellow)">${data.totalWarning}</strong></span>
        <span>Info: <strong style="color:var(--blue)">${data.totalInfo}</strong></span>
      </div>`;
    el.innerHTML = items + summary;
  } catch {
    $("#security-content").innerHTML = '<span class="muted">Failed to load security data.</span>';
  }
}

async function fetchGitChanges() {
  try {
    const data = await api("/api/git-changes");
    const el = $("#git-content");
    if (data.error) { el.innerHTML = `<span class="muted">${data.error}</span>`; return; }
    if (data.files.length === 0) { el.innerHTML = '<span class="muted">No uncommitted changes.</span>'; return; }
    el.innerHTML = data.files.map((f) => `<div class="git-file">${f}</div>`).join("");
  } catch {
    $("#git-content").innerHTML = '<span class="muted">Failed to load git changes.</span>';
  }
}

// ── Live Output & Progress ───────────────────────────────────────────────────
async function fetchLiveOutput() {
  try {
    const data = await api("/api/live-output?lines=150");
    const panel = $("#live-progress");
    const outputPanel = $("#claude-output-panel");
    const indicator = $("#claude-output-indicator");

    const isActive = data.session && data.session.session;

    if (!isActive) {
      panel.style.display = "none";
      // Keep output panel visible if there's content from last session
      if (data.lines.length > 0) {
        outputPanel.style.display = "block";
        indicator.classList.remove("active");
        const el = $("#claude-output");
        const wasAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
        el.textContent = data.lines.join("\n") || "No output from last session.";
        if (wasAtBottom) el.scrollTop = el.scrollHeight;
      } else {
        outputPanel.style.display = "none";
      }
      return;
    }

    const s = data.session;

    // Show live progress panel
    panel.style.display = "block";
    outputPanel.style.display = "block";
    indicator.classList.add("active");

    $("#live-session-name").textContent = s.session;
    $("#live-model").textContent = s.model ? s.model.replace("claude-", "") : "";

    const done = s.completedPrompts?.length ?? 0;
    const total = s.totalPrompts ?? 0;
    const current = done + 1;
    const currentLabel = s.promptLabels?.[done] ?? `Prompt ${current}`;

    $("#live-prompt-label").textContent = total > 0
      ? `${currentLabel} (${done}/${total} done)`
      : "Processing...";

    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const fill = $("#live-prompt-fill");
    fill.style.width = `${pct}%`;
    fill.className = `progress-fill ${pct >= 100 ? "green" : pct > 0 ? "yellow" : ""}`;

    // Elapsed time
    if (s.startedAt) {
      const elapsed = Date.now() - new Date(s.startedAt).getTime();
      $("#live-elapsed").textContent = `Elapsed: ${formatDuration(elapsed)}`;
    }

    // Output size
    const sizeKb = ((s.outputBytes ?? 0) / 1024).toFixed(1);
    $("#live-output-size").textContent = `Output: ${sizeKb} KB | Lines: ${data.totalLines}`;

    // Live Claude output
    const el = $("#claude-output");
    const wasAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    el.textContent = data.lines.join("\n") || "Waiting for output...";
    if (wasAtBottom) el.scrollTop = el.scrollHeight;
  } catch {
    // Silent — don't break the poll cycle
  }
}

// ── Button management ────────────────────────────────────────────────────────
function updateButtons(status) {
  const r = status.running, p = status.paused, f = status.fixing;
  $("#btn-start").disabled      = r || f;
  $("#btn-stop").disabled       = !r && !f;
  $("#btn-pause").disabled      = !r || p;
  $("#btn-resume").disabled     = !p;
  $("#btn-restart").disabled    = f;
  $("#btn-reset-start").disabled = f;
  $("#btn-security").disabled   = f;
}

$$("[data-cmd]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const cmd = btn.dataset.cmd;
    btn.classList.add("loading");
    btn.disabled = true;
    try {
      const result = await postCommand(cmd);
      showFeedback(result.message, result.ok);
      await fetchStatus();
      await fetchSessions();
    } catch (err) {
      showFeedback(`Error: ${err.message}`, false);
    } finally {
      btn.classList.remove("loading");
    }
  });
});

function showFeedback(msg, ok) {
  const el = $("#command-feedback");
  el.textContent = msg;
  el.className = `feedback ${ok ? "ok" : "err"}`;
  setTimeout(() => { el.className = "feedback hidden"; }, 4000);
}

$("#btn-refresh-logs").addEventListener("click", fetchLogs);

// ═══════════════════════════════════════════════════════════════════════════
// TAB: Timeouts
// ═══════════════════════════════════════════════════════════════════════════

// ── Global Pause Config ──────────────────────────────────────────────────
$("#btn-save-global-pause").addEventListener("click", async () => {
  const input = $("#global-pause-input");
  const feedback = $("#global-pause-feedback");
  const val = parseInt(input.value);

  if (isNaN(val) || val < 0) {
    feedback.textContent = "Invalid value";
    feedback.style.color = "var(--red)";
    return;
  }

  const btn = $("#btn-save-global-pause");
  btn.classList.add("loading");
  btn.disabled = true;
  try {
    const result = await postJson("/api/pause-config", { minutes: val });
    if (result.ok) {
      feedback.textContent = "Saved!";
      feedback.style.color = "var(--green)";
    } else {
      feedback.textContent = result.message;
      feedback.style.color = "var(--red)";
    }
  } catch (err) {
    feedback.textContent = err.message;
    feedback.style.color = "var(--red)";
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
    setTimeout(() => { feedback.textContent = ""; }, 3000);
  }
});

async function fetchTimeouts() {
  try {
    const [data, settings] = await Promise.all([
      api("/api/timeouts"),
      api("/api/settings"),
    ]);

    // Set global pause input
    const globalPauseInput = $("#global-pause-input");
    const currentGlobalPause = settings?.runner?.pauseMinutes;
    if (currentGlobalPause != null) {
      globalPauseInput.value = currentGlobalPause;
      globalPauseInput.placeholder = currentGlobalPause;
    }

    const el = $("#timeouts-content");

    if (!data.sessions?.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128338;</div>No sessions found.</div>';
      return;
    }

    el.innerHTML = data.sessions.map((s) => {
      // Per-prompt rows with individual timeout inputs
      const promptRows = s.prompts.map((p) => {
        const currentMin = p.source === "prompt" ? Math.round(p.timeoutMs / 60000) : "";
        const effectiveMin = Math.round(p.timeoutMs / 60000);
        return `
          <div class="prompt-timeout-row" data-prompt="${p.number}">
            <span class="timeout-prompt-label">[${p.number}] ${p.label}</span>
            <div class="prompt-timeout-info">
              <span class="timeout-prompt-src">(${p.source}: ${effectiveMin}m)</span>
              <input type="number" class="prompt-timeout-input" placeholder="${effectiveMin}" value="${currentMin}" min="1" max="600" title="Per-prompt timeout in minutes">
            </div>
          </div>
        `;
      }).join("");

      // Current session-level override values
      const currentTimeoutMin = s.override.timeoutMs ? Math.round(s.override.timeoutMs / 60000) : "";
      const currentPauseMin   = s.override.pauseAfterMs != null ? Math.round(s.override.pauseAfterMs / 60000) : "";

      return `
        <div class="timeout-session" data-session-num="${s.num}">
          <div class="timeout-session-header">
            <span class="timeout-session-title">${s.name}</span>
            <div class="timeout-session-badges">
              ${s.isDone ? '<span class="timeout-badge done">Done</span>' : ""}
              ${s.hasTimeoutOverride ? '<span class="timeout-badge override">Timeout Override</span>' : ""}
              ${s.hasPauseOverride ? '<span class="timeout-badge override">Pause Override</span>' : ""}
              ${s.skipSecurityFix ? '<span class="timeout-badge sec-skip">Security: Off</span>' : ""}
              <span class="timeout-badge timeout">${formatDuration(s.totalTimeoutMs)}</span>
              <span class="timeout-badge pause">Pause: ${formatDuration(s.pauseAfterMs)}</span>
            </div>
          </div>
          <div class="timeout-prompts">${promptRows}</div>
          <div class="timeout-edit" data-session="${s.num}">
            <label>Session Timeout (min):</label>
            <input type="number" class="timeout-input" placeholder="${currentTimeoutMin || "default"}" value="${currentTimeoutMin}" min="1" max="600" title="Session-wide default timeout for all prompts">
            <label>Pause (min):</label>
            <input type="number" class="pause-input" placeholder="${currentPauseMin || "default"}" value="${currentPauseMin}" min="0" max="360" title="Pause after this session">
            <label class="security-toggle-label">
              <input type="checkbox" class="security-toggle" ${s.skipSecurityFix ? "" : "checked"}>
              Security Fix
            </label>
            <button class="btn btn-sm btn-blue save-timeout-btn">Save</button>
          </div>
        </div>
      `;
    }).join("");

    // Summary
    const summary = $("#timeouts-summary");
    summary.classList.remove("hidden");
    summary.innerHTML = `
      <div class="stat">
        <span class="stat-label">Max. Execution Time</span>
        <span class="stat-value">${formatDuration(data.totalTimeoutMs)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Total Pause Time</span>
        <span class="stat-value">${formatDuration(data.totalPauseMs)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Max. Total Runtime</span>
        <span class="stat-value">${formatDuration(data.totalRuntimeMs)}</span>
      </div>
    `;

    // Attach save handlers (session-level + per-prompt)
    el.querySelectorAll(".save-timeout-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const editRow = btn.closest(".timeout-edit");
        const sessionBlock = btn.closest(".timeout-session");
        const num = editRow.dataset.session;
        const timeoutVal = editRow.querySelector(".timeout-input").value;
        const pauseVal   = editRow.querySelector(".pause-input").value;

        const body = {};
        if (timeoutVal) body.timeoutMinutes = parseInt(timeoutVal);
        if (pauseVal !== "") body.pauseMinutes = parseInt(pauseVal);

        // Collect per-prompt timeout overrides
        const promptInputs = sessionBlock.querySelectorAll(".prompt-timeout-input");
        const promptTimeouts = {};
        promptInputs.forEach((input) => {
          const pNum = input.closest(".prompt-timeout-row").dataset.prompt;
          if (input.value) promptTimeouts[pNum] = parseInt(input.value);
        });
        if (Object.keys(promptTimeouts).length > 0) body.promptTimeouts = promptTimeouts;

        // Security toggle
        const secToggle = editRow.querySelector(".security-toggle");
        const secEnabled = secToggle?.checked ?? true;

        if (Object.keys(body).length === 0 && secEnabled === true) return;

        btn.classList.add("loading");
        btn.disabled = true;
        try {
          const promises = [];
          if (Object.keys(body).length > 0) {
            promises.push(postJson(`/api/timeout/${num}`, body));
          }
          promises.push(postJson(`/api/security-toggle/${num}`, { enabled: secEnabled }));
          const results = await Promise.all(promises);
          const allOk = results.every((r) => r.ok);
          if (allOk) {
            showTimeoutFeedback(btn, "Saved!", true);
            await fetchTimeouts();
          } else {
            const errMsg = results.find((r) => !r.ok)?.message ?? "Error";
            showTimeoutFeedback(btn, errMsg, false);
          }
        } catch (err) {
          showTimeoutFeedback(btn, err.message, false);
        } finally {
          btn.classList.remove("loading");
          btn.disabled = false;
        }
      });
    });
  } catch {
    $("#timeouts-content").innerHTML = '<span class="muted">Failed to load timeout data.</span>';
  }
}

function showTimeoutFeedback(btn, msg, ok) {
  const orig = btn.textContent;
  btn.textContent = msg;
  btn.style.background = ok ? "var(--green)" : "var(--red)";
  setTimeout(() => {
    btn.textContent = orig;
    btn.style.background = "";
  }, 2000);
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB: Analytics
// ═══════════════════════════════════════════════════════════════════════════

async function fetchAnalytics() {
  try {
    const data = await api("/api/analytics");
    const s = data.summary;

    $("#stat-total-runs").textContent     = s.totalRuns;
    $("#stat-total-sessions").textContent = s.totalSessions;
    $("#stat-success-rate").textContent   = `${s.successRate}%`;
    $("#stat-success-rate").style.color   = s.successRate >= 90 ? "var(--green)" : s.successRate >= 60 ? "var(--yellow)" : "var(--red)";
    $("#stat-avg-duration").textContent   = formatDuration(s.avgDurationMs);
    $("#stat-input-tokens").textContent   = formatTokens(s.totalInputTokens);
    $("#stat-output-tokens").textContent  = formatTokens(s.totalOutputTokens);

    // Success/Failure chart
    renderSuccessChart(data.runHistory);

    // Duration chart
    renderDurationChart(data.runHistory);

    // Run history table
    const tbody = $("#analytics-runs-body");
    if (data.runHistory.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted">No archived runs found. Complete a run and archive it to see analytics.</td></tr>';
    } else {
      tbody.innerHTML = data.runHistory.map((r) => {
        const date = r.startedAt ? new Date(r.startedAt).toLocaleDateString() : "—";
        return `<tr>
          <td>${r.runId?.replace("run-", "").slice(0, 16) || "—"}</td>
          <td>${date}</td>
          <td>${r.sessions}</td>
          <td style="color:var(--green)">${r.successes}</td>
          <td style="color:${r.failures > 0 ? "var(--red)" : "var(--text-dim)"}">${r.failures}</td>
          <td>${formatDuration(r.durationMs)}</td>
          <td>${formatTokens(r.outputTokens)}</td>
          <td>${r.model?.replace("claude-", "") || "—"}</td>
        </tr>`;
      }).join("");
    }
  } catch {
    $("#analytics-runs-body").innerHTML = '<tr><td colspan="8" class="muted">Failed to load analytics.</td></tr>';
  }
}

function renderSuccessChart(runs) {
  const container = $("#analytics-success-chart");
  if (runs.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128202;</div>No data yet</div>';
    return;
  }

  const maxSessions = Math.max(...runs.map((r) => r.sessions), 1);
  const chartHeight = 160;

  container.innerHTML = runs.slice(-15).map((r) => {
    const successH = Math.round((r.successes / maxSessions) * chartHeight);
    const failH    = Math.round((r.failures / maxSessions) * chartHeight);
    const label = r.runId?.replace("run-", "").slice(5, 10) || "?";
    return `
      <div class="chart-bar-wrap">
        <div style="display:flex;flex-direction:column;gap:2px;align-items:center;height:${chartHeight}px;justify-content:flex-end;">
          ${failH > 0 ? `<div class="chart-bar" style="height:${failH}px;background:var(--red);" data-tooltip="${r.failures} failed"></div>` : ""}
          <div class="chart-bar" style="height:${Math.max(successH, 4)}px;background:var(--green);" data-tooltip="${r.successes} success"></div>
        </div>
        <span class="chart-label">${label}</span>
      </div>`;
  }).join("") + `
    <div class="chart-legend" style="position:absolute;bottom:-24px;left:0;">
      <span><span class="chart-legend-dot" style="background:var(--green)"></span>Success</span>
      <span><span class="chart-legend-dot" style="background:var(--red)"></span>Failed</span>
    </div>`;
  container.style.position = "relative";
  container.style.paddingBottom = "30px";
}

function renderDurationChart(runs) {
  const container = $("#analytics-duration-chart");
  if (runs.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#9201;</div>No data yet</div>';
    return;
  }

  const maxDur = Math.max(...runs.map((r) => r.durationMs || 0), 1);
  const chartHeight = 160;

  container.innerHTML = runs.slice(-15).map((r) => {
    const h = Math.max(Math.round(((r.durationMs || 0) / maxDur) * chartHeight), 4);
    const label = r.runId?.replace("run-", "").slice(5, 10) || "?";
    return `
      <div class="chart-bar-wrap">
        <div class="chart-bar" style="height:${h}px;background:var(--accent);" data-tooltip="${formatDuration(r.durationMs)}"></div>
        <span class="chart-label">${label}</span>
      </div>`;
  }).join("");
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB: Archives
// ═══════════════════════════════════════════════════════════════════════════

async function fetchArchives() {
  try {
    const data = await api("/api/archives");
    const el = $("#archives-content");

    if (data.archives.length === 0) {
      el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128451;</div>No archives found. Complete a run to create an archive.</div>';
      return;
    }

    el.innerHTML = data.archives.map((arc, i) => {
      const m = arc.manifest;
      const status = m?.status ?? "unknown";
      const started = m?.startedAt ? new Date(m.startedAt).toLocaleString() : "—";
      const finished = m?.finishedAt ? new Date(m.finishedAt).toLocaleString() : "—";
      const sessionCount = m?.completedSessions?.length ?? 0;
      const fileCount = m?.fileCount ?? 0;
      const model = m?.settings?.model?.replace("claude-", "") ?? "—";
      const plan = m?.settings?.plan ?? "—";

      const sessions = m?.sessions ?? {};
      const sessionRows = Object.entries(sessions).map(([name, detail]) => {
        const icon = detail.success ? "&#10003;" : "&#10007;";
        const iconColor = detail.success ? "var(--green)" : "var(--red)";
        const dur = detail.durationMs ? formatDuration(detail.durationMs) : "—";
        const tokens = detail.tokenUsage?.outputTokens ? formatTokens(detail.tokenUsage.outputTokens) : "—";
        return `
          <div class="archive-session-row">
            <span><span style="color:${iconColor}">${icon}</span> ${name}</span>
            <span>${detail.promptsCompleted ?? 0}/${detail.totalPrompts ?? 0} prompts — ${dur} — ${tokens} tokens</span>
          </div>`;
      }).join("");

      const totalDuration = Object.values(sessions).reduce((s, v) => s + (v.durationMs ?? 0), 0);
      const totalTokens   = Object.values(sessions).reduce((s, v) => s + (v.tokenUsage?.outputTokens ?? 0), 0);

      return `
        <div class="archive-card" data-idx="${i}">
          <div class="archive-card-header">
            <span class="archive-card-title">${arc.name}</span>
            <span class="archive-card-status ${status}">${status}</span>
          </div>
          <div class="archive-card-meta">
            <span>Started: <strong>${started}</strong></span>
            <span>Finished: <strong>${finished}</strong></span>
            <span>Sessions: <strong>${sessionCount}</strong></span>
            <span>Duration: <strong>${formatDuration(totalDuration)}</strong></span>
            <span>Tokens: <strong>${formatTokens(totalTokens)}</strong></span>
            <span>Files: <strong>${fileCount}</strong></span>
            <span>Model: <strong>${model}</strong></span>
          </div>
          <div class="archive-details" id="archive-details-${i}">
            ${sessionRows || '<span class="muted">No session data in manifest</span>'}
            <div style="margin-top:10px;font-size:0.78rem;color:var(--text-dim)">
              Plan: ${plan} | Pause: ${m?.settings?.pauseMinutes ?? "—"} min | MaxTurns: ${m?.settings?.maxTurns ?? "—"}
            </div>
          </div>
        </div>
      `;
    }).join("");

    // Toggle archive details on click
    el.querySelectorAll(".archive-card").forEach((card) => {
      card.addEventListener("click", () => {
        const idx = card.dataset.idx;
        const details = $(`#archive-details-${idx}`);
        details.classList.toggle("open");
      });
    });
  } catch {
    $("#archives-content").innerHTML = '<span class="muted">Failed to load archives.</span>';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB: Audit
// ═══════════════════════════════════════════════════════════════════════════

async function fetchAudit() {
  try {
    const data = await api("/api/audit?limit=100");
    const tbody = $("#audit-body");

    if (data.entries.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">No audit entries found.</td></tr>';
      return;
    }

    // Show newest first
    tbody.innerHTML = [...data.entries].reverse().map((e) => {
      const time = e.timestamp ? new Date(e.timestamp).toLocaleString() : "—";
      const args = Object.keys(e.args ?? {}).length > 0
        ? Object.entries(e.args).map(([k, v]) => `${k}=${v}`).join(", ")
        : "—";
      const isOk = e.outcome === "ok";
      return `<tr>
        <td>${time}</td>
        <td><strong>${e.command}</strong></td>
        <td>${e.actor || "system"}</td>
        <td style="font-family:var(--mono);font-size:0.78rem">${args}</td>
        <td class="${isOk ? "outcome-ok" : "outcome-error"}">${e.outcome}</td>
      </tr>`;
    }).join("");
  } catch {
    $("#audit-body").innerHTML = '<tr><td colspan="5" class="muted">Failed to load audit log.</td></tr>';
  }
}

$("#btn-refresh-audit").addEventListener("click", fetchAudit);

// ═══════════════════════════════════════════════════════════════════════════
// TAB: Settings
// ═══════════════════════════════════════════════════════════════════════════

async function fetchSettings() {
  try {
    const data = await api("/api/settings");
    $("#settings-content").textContent = JSON.stringify(data, null, 2);
  } catch {
    $("#settings-content").textContent = "Failed to load settings.";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB: Prompts
// ═══════════════════════════════════════════════════════════════════════════

// Toggle save setting
$("#prompts-enabled-toggle").addEventListener("change", async (e) => {
  const feedback = $("#prompts-toggle-feedback");
  try {
    const result = await postJson("/api/generated-prompts/toggle", { enabled: e.target.checked });
    if (result.ok) {
      feedback.textContent = result.enabled ? "Enabled" : "Disabled";
      feedback.style.color = "var(--green)";
    } else {
      feedback.textContent = result.message || "Error";
      feedback.style.color = "var(--red)";
    }
  } catch (err) {
    feedback.textContent = err.message;
    feedback.style.color = "var(--red)";
  }
  setTimeout(() => { feedback.textContent = ""; }, 3000);
});

async function fetchGeneratedPrompts() {
  try {
    const data = await api("/api/generated-prompts");

    // Set toggle state
    $("#prompts-enabled-toggle").checked = !!data.enabled;

    const el = $("#prompts-list");
    if (!data.prompts?.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128196;</div>No generated prompts found. Enable the setting and run a session.</div>';
      return;
    }

    el.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Size</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${data.prompts.map((p) => {
              const sizeKb = (p.size / 1024).toFixed(1);
              const created = new Date(p.createdAt).toLocaleString();
              return `<tr>
                <td><strong>${p.name}</strong></td>
                <td>${sizeKb} KB</td>
                <td>${created}</td>
                <td><button class="btn btn-sm btn-blue view-prompt-btn" data-name="${p.name}">View</button></td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;

    // Attach view handlers
    el.querySelectorAll(".view-prompt-btn").forEach((btn) => {
      btn.addEventListener("click", () => viewPrompt(btn.dataset.name));
    });
  } catch {
    $("#prompts-list").innerHTML = '<span class="muted">Failed to load generated prompts.</span>';
  }
}

async function viewPrompt(name) {
  const panel = $("#prompt-viewer-panel");
  const meta = $("#prompt-viewer-meta");
  const content = $("#prompt-viewer-content");

  meta.textContent = `Loading ${name}...`;
  content.textContent = "";
  panel.style.display = "block";

  try {
    const data = await api(`/api/generated-prompts/${encodeURIComponent(name)}`);
    meta.textContent = `${data.name} — ${(data.size / 1024).toFixed(1)} KB`;
    content.textContent = data.content;
  } catch (err) {
    meta.textContent = "Error loading prompt";
    content.textContent = err.message;
  }
}

$("#btn-close-prompt-viewer").addEventListener("click", () => {
  $("#prompt-viewer-panel").style.display = "none";
});

$("#btn-refresh-prompts").addEventListener("click", fetchGeneratedPrompts);

// ═══════════════════════════════════════════════════════════════════════════
// Polling
// ═══════════════════════════════════════════════════════════════════════════

async function pollFast() {
  if (activeTab === "overview") {
    await Promise.all([fetchStatus(), fetchSessions(), fetchLogs(), fetchLiveOutput()]);
  }
}

async function pollSlow() {
  if (activeTab === "overview") {
    fetchSecurity();
    fetchGitChanges();
  }
  // Refresh current non-overview tab on slow poll
  if (activeTab === "timeouts") fetchTimeouts();
}

// ── Initial load ─────────────────────────────────────────────────────────────
(async () => {
  await Promise.all([fetchStatus(), fetchSessions(), fetchLogs(), fetchLiveOutput()]);
  await Promise.all([fetchSecurity(), fetchGitChanges()]);

  setInterval(pollFast, POLL_FAST);
  setInterval(pollSlow, POLL_SLOW);
})();
