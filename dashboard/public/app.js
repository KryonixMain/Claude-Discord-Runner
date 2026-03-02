// ── State ────────────────────────────────────────────────────────────────────
let connected = false;
let refreshTimer = null;
const POLL_INTERVAL = 5000;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const connectionBadge = $("#connection-badge");
const statusLine      = $("#status-line");
const clock           = $("#clock");
const cardStatus      = $("#card-status");
const cardProgress    = $("#card-progress");
const cardModel       = $("#card-model");
const cardPlan        = $("#card-plan");
const progressFill    = $("#progress-fill");
const sessionsBody    = $("#sessions-body");
const logOutput       = $("#log-output");
const securityContent = $("#security-content");
const settingsContent = $("#settings-content");
const gitContent      = $("#git-content");
const tokenBudget     = $("#token-budget");
const budgetUsed      = $("#budget-used");
const budgetTotal     = $("#budget-total");
const budgetFill      = $("#budget-fill");
const budgetMeta      = $("#budget-meta");
const cmdFeedback     = $("#command-feedback");

// ── Clock ────────────────────────────────────────────────────────────────────
function updateClock() {
  clock.textContent = new Date().toLocaleTimeString();
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

function setConnected(ok) {
  connected = ok;
  connectionBadge.className = `badge ${ok ? "badge-online" : "badge-offline"}`;
  connectionBadge.textContent = ok ? "Online" : "Offline";
}

// ── Fetch & Render: Status ───────────────────────────────────────────────────
async function fetchStatus() {
  try {
    const data = await api("/api/status");
    setConnected(true);

    statusLine.textContent = data.statusLine;
    cardStatus.textContent = data.running ? (data.paused ? "Paused" : "Running") : data.fixing ? "Security Fix" : "Idle";
    cardStatus.style.color = data.running ? (data.paused ? "var(--yellow)" : "var(--green)") : data.fixing ? "var(--purple)" : "var(--text-dim)";

    const pct = data.totalCount > 0 ? Math.round((data.completedCount / data.totalCount) * 100) : 0;
    cardProgress.textContent = `${data.completedCount} / ${data.totalCount}`;
    progressFill.style.width = `${pct}%`;
    progressFill.className = `progress-fill ${pct >= 100 ? "green" : pct > 0 ? "yellow" : ""}`;

    cardModel.textContent = data.model || "—";
    cardPlan.textContent  = data.plan  || "—";

    // Render sessions table
    if (data.sessions.length === 0) {
      sessionsBody.innerHTML = '<tr><td colspan="6" class="muted">No sessions found</td></tr>';
    } else {
      sessionsBody.innerHTML = data.sessions.map((s) => {
        const icon = s.done ? "&#10003;" : data.running ? "&#9203;" : "&#9744;";
        const iconClass = s.done ? "style=\"color:var(--green)\"" : "";
        const at = s.completedAt ? new Date(s.completedAt).toLocaleString() : "—";
        return `<tr>
          <td ${iconClass}>${icon}</td>
          <td>${s.file}</td>
          <td>${s.promptCount}</td>
          <td>—</td>
          <td>${at}</td>
          <td>${s.duration || "—"}</td>
        </tr>`;
      }).join("");
    }

    // Update button states
    updateButtons(data);
  } catch (err) {
    setConnected(false);
    statusLine.textContent = "Connection lost";
  }
}

// ── Fetch & Render: Sessions (with token data) ──────────────────────────────
async function fetchSessions() {
  try {
    const data = await api("/api/sessions");
    if (data.error || !data.sessions?.length) return;

    // Update token column in table
    const rows = sessionsBody.querySelectorAll("tr");
    data.sessions.forEach((s, i) => {
      if (rows[i]) {
        const cells = rows[i].querySelectorAll("td");
        if (cells[3]) cells[3].textContent = `~${(s.outputTokens / 1000).toFixed(1)}k`;
      }
    });

    // Token budget bar
    if (data.budgetTokens > 0) {
      tokenBudget.classList.remove("hidden");
      budgetUsed.textContent  = `~${(data.totalOutputTokens / 1000).toFixed(1)}k`;
      budgetTotal.textContent = `~${(data.budgetTokens / 1000).toFixed(1)}k`;
      const pct = Math.min(100, Math.round((data.totalOutputTokens / data.budgetTokens) * 100));
      budgetFill.style.width = `${pct}%`;
      budgetFill.className = `progress-fill budget-fill ${pct > 95 ? "red" : pct > 70 ? "yellow" : ""}`;
      budgetMeta.textContent = data.fitsInOneWindow
        ? `Fits in 1 window — recommended pause: ${data.recommendedPauseMinutes} min`
        : `${data.windowsNeeded} windows needed — recommended pause: ${data.recommendedPauseMinutes} min`;
    }
  } catch { /* silent */ }
}

// ── Fetch & Render: Logs ─────────────────────────────────────────────────────
async function fetchLogs() {
  try {
    const data = await api("/api/logs?lines=80");
    if (data.lines.length === 0) {
      logOutput.textContent = "No log file found. Start a run first.";
    } else {
      const wasAtBottom = logOutput.scrollTop + logOutput.clientHeight >= logOutput.scrollHeight - 20;
      logOutput.textContent = data.lines.join("\n");
      if (wasAtBottom) logOutput.scrollTop = logOutput.scrollHeight;
    }
  } catch {
    logOutput.textContent = "Failed to load logs.";
  }
}

// ── Fetch & Render: Security ─────────────────────────────────────────────────
async function fetchSecurity() {
  try {
    const data = await api("/api/security");
    if (data.reports.length === 0) {
      securityContent.innerHTML = '<span class="muted">No security reports found.</span>';
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
      </div>
    `;

    securityContent.innerHTML = items + summary;
  } catch {
    securityContent.innerHTML = '<span class="muted">Failed to load security data.</span>';
  }
}

// ── Fetch & Render: Settings ─────────────────────────────────────────────────
async function fetchSettings() {
  try {
    const data = await api("/api/settings");
    settingsContent.textContent = JSON.stringify(data, null, 2);
  } catch {
    settingsContent.textContent = "Failed to load settings.";
  }
}

// ── Fetch & Render: Git Changes ──────────────────────────────────────────────
async function fetchGitChanges() {
  try {
    const data = await api("/api/git-changes");
    if (data.error) {
      gitContent.innerHTML = `<span class="muted">${data.error}</span>`;
      return;
    }
    if (data.files.length === 0) {
      gitContent.innerHTML = '<span class="muted">No uncommitted changes.</span>';
      return;
    }
    gitContent.innerHTML = data.files.map((f) => `<div class="git-file">${f}</div>`).join("");
  } catch {
    gitContent.innerHTML = '<span class="muted">Failed to load git changes.</span>';
  }
}

// ── Button state management ──────────────────────────────────────────────────
function updateButtons(status) {
  const btnStart      = $("#btn-start");
  const btnStop       = $("#btn-stop");
  const btnPause      = $("#btn-pause");
  const btnResume     = $("#btn-resume");
  const btnRestart    = $("#btn-restart");
  const btnResetStart = $("#btn-reset-start");
  const btnSecurity   = $("#btn-security");

  const running = status.running;
  const paused  = status.paused;
  const fixing  = status.fixing;

  btnStart.disabled      = running || fixing;
  btnStop.disabled       = !running && !fixing;
  btnPause.disabled      = !running || paused;
  btnResume.disabled     = !paused;
  btnRestart.disabled    = fixing;
  btnResetStart.disabled = fixing;
  btnSecurity.disabled   = fixing;
}

// ── Command execution ────────────────────────────────────────────────────────
document.querySelectorAll("[data-cmd]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const cmd = btn.dataset.cmd;
    btn.classList.add("loading");
    btn.disabled = true;

    try {
      const result = await postCommand(cmd);
      showFeedback(result.message, result.ok);
      // Immediately refresh status
      await fetchStatus();
      await fetchSessions();
    } catch (err) {
      showFeedback(`Error: ${err.message}`, false);
    } finally {
      btn.classList.remove("loading");
      // Re-enable is handled by next status fetch
    }
  });
});

function showFeedback(msg, ok) {
  cmdFeedback.textContent = msg;
  cmdFeedback.className = `feedback ${ok ? "ok" : "err"}`;
  setTimeout(() => { cmdFeedback.className = "feedback hidden"; }, 4000);
}

// ── Log refresh button ───────────────────────────────────────────────────────
$("#btn-refresh-logs").addEventListener("click", fetchLogs);

// ── Polling loop ─────────────────────────────────────────────────────────────
async function pollAll() {
  await Promise.all([
    fetchStatus(),
    fetchSessions(),
    fetchLogs(),
  ]);
}

// Initial load: fetch everything
(async () => {
  await pollAll();
  await Promise.all([fetchSecurity(), fetchSettings(), fetchGitChanges()]);

  // Poll fast-changing data every 5s
  refreshTimer = setInterval(pollAll, POLL_INTERVAL);

  // Poll slow-changing data every 30s
  setInterval(() => {
    fetchSecurity();
    fetchSettings();
    fetchGitChanges();
  }, 30000);
})();
