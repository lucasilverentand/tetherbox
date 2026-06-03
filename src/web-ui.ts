import type { DaemonEvent, DaemonState, JobRecord } from "./types";

export function renderWebUi(initialState: DaemonState): string {
  const initialJson = JSON.stringify(initialState).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tetherbox</title>
  <style>
${styles()}
  </style>
</head>
<body>
  <main class="app" data-view="jobs">
    <header class="topbar">
      <div>
        <h1>Tetherbox</h1>
        <p id="daemon-summary">${escapeHtml(formatDaemonSummary(initialState))}</p>
      </div>
      <div class="toolbar">
        <input id="operator-token" type="password" autocomplete="off" placeholder="Operator token" aria-label="Operator token">
        <button id="refresh" type="button">Refresh</button>
      </div>
    </header>

    <section class="status-grid" aria-label="Daemon status">
      <article>
        <span>Linear</span>
        <strong id="linear-status">${escapeHtml(formatLinearStatus(initialState))}</strong>
      </article>
      <article>
        <span>Queue</span>
        <strong id="queue-status">${escapeHtml(formatQueueStatus(initialState))}</strong>
      </article>
      <article>
        <span>Jobs</span>
        <strong id="job-count">${initialState.jobs.length}</strong>
      </article>
      <article>
        <span>Events</span>
        <strong id="event-count">${initialState.events.length}</strong>
      </article>
    </section>

    <section class="layout">
      <section class="panel jobs-panel" aria-labelledby="jobs-heading">
        <div class="panel-head">
          <h2 id="jobs-heading">Jobs</h2>
          <span id="jobs-empty" class="muted">${initialState.jobs.length ? "" : "No jobs yet."}</span>
        </div>
        <div id="jobs" class="jobs">${initialState.jobs.map(renderJobCard).join("")}</div>
      </section>

      <section class="panel detail-panel" aria-labelledby="detail-heading">
        <div class="panel-head">
          <h2 id="detail-heading">Job Detail</h2>
        </div>
        <div id="job-detail">${renderJobDetail(initialState.jobs[0], initialState.events)}</div>
      </section>
    </section>

    <section class="panel events-panel" aria-labelledby="events-heading">
      <div class="panel-head">
        <h2 id="events-heading">Recent Events</h2>
        <span id="events-empty" class="muted">${initialState.events.length ? "" : "No events yet."}</span>
      </div>
      <div id="events" class="events">${initialState.events.slice(0, 30).map(renderEventRow).join("")}</div>
    </section>
  </main>
  <script>
    window.__TETHERBOX_INITIAL_STATE__ = ${initialJson};
${clientScript()}
  </script>
</body>
</html>`;
}

function renderJobCard(job: JobRecord, index: number): string {
  const selected = index === 0 ? " selected" : "";
  return `<button class="job-card${selected}" type="button" data-job-id="${escapeAttr(job.id)}">
    <span class="job-row">
      <strong>${escapeHtml(job.issueIdentifier ?? "No issue")}</strong>
      <span class="status status-${escapeAttr(job.status)}">${escapeHtml(job.status)}</span>
    </span>
    <span class="job-title">${escapeHtml(job.issueTitle ?? job.id)}</span>
    <span class="job-meta">${escapeHtml(job.repo)} · ${escapeHtml(formatDate(job.updatedAt))}</span>
    <span class="job-message">${escapeHtml(job.lastMessage)}</span>
  </button>`;
}

function renderJobDetail(job: JobRecord | undefined, events: DaemonEvent[]): string {
  if (!job) {
    return `<p class="muted">No job selected.</p>`;
  }
  const actions = renderActions(job);
  const rows = [
    ["ID", job.id],
    ["Session", job.sessionId],
    ["Status", job.status],
    ["Repository", job.repo],
    ["Issue", [job.issueIdentifier, job.issueTitle].filter(Boolean).join(" ") || "none"],
    ["Policy", `${job.policyRule} -> ${job.policyDecision}`],
    ["Branch", job.branchName ?? "none"],
    ["Worktree", job.worktreePath ?? "none"],
    ["Retry", `${job.retryEligible ? "eligible" : "not eligible"} (${job.retryCount})`],
    ["Last", job.lastMessage],
  ];
  const jobEvents = events.filter((event) => event.jobId === job.id).slice(0, 8);
  return `<div class="detail">
    ${actions ? `<div class="actions">${actions}</div>` : ""}
    <dl>${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
    ${job.failureReason ? `<p class="failure">${escapeHtml(job.failureReason)}</p>` : ""}
    <h3>Job Events</h3>
    <div class="events compact">${jobEvents.length ? jobEvents.map(renderEventRow).join("") : `<p class="muted">No job events yet.</p>`}</div>
  </div>`;
}

function renderActions(job: JobRecord): string {
  const actions: string[] = [];
  if (job.status === "queued" || job.status === "running" || job.status === "waiting_approval") {
    actions.push(`<button type="button" data-action="cancel" data-job-id="${escapeAttr(job.id)}">Cancel</button>`);
  }
  if (job.retryEligible) {
    actions.push(`<button type="button" data-action="retry" data-job-id="${escapeAttr(job.id)}">Retry</button>`);
  }
  if (job.status === "waiting_approval") {
    actions.push(`<button type="button" data-action="approve" data-job-id="${escapeAttr(job.id)}">Approve</button>`);
    actions.push(`<button type="button" data-action="deny" data-job-id="${escapeAttr(job.id)}">Deny</button>`);
  }
  return actions.join("");
}

function renderEventRow(event: DaemonEvent): string {
  return `<article class="event event-${escapeAttr(event.level)}">
    <span>${escapeHtml(formatDate(event.createdAt))}</span>
    <strong>${escapeHtml(event.level)}</strong>
    <em>${escapeHtml(event.source)}</em>
    <p>${escapeHtml(event.message)}</p>
  </article>`;
}

function formatDaemonSummary(state: DaemonState): string {
  return `Started ${formatDate(state.startedAt)}`;
}

function formatLinearStatus(state: DaemonState): string {
  if (!state.linear?.installed) {
    return "Not installed";
  }
  return state.linear.appUserId ? `Installed as ${state.linear.appUserId}` : "Installed";
}

function formatQueueStatus(state: DaemonState): string {
  if (!state.queue) {
    return "Unavailable";
  }
  const mode = state.queue.accepting ? "accepting" : "draining";
  return `${mode}, ${state.queue.running}/${state.queue.concurrency} running, ${state.queue.queued} queued`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function styles(): string {
  return `:root {
  color-scheme: light dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f7f8f5;
  color: #19201e;
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; }
button, input { font: inherit; }
.app { min-height: 100vh; padding: 24px; }
.topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 20px; }
h1, h2, h3, p { margin: 0; }
h1 { font-size: 28px; line-height: 1.1; }
h2 { font-size: 16px; }
h3 { font-size: 13px; margin-top: 18px; margin-bottom: 8px; color: #42504b; }
.topbar p, .muted { color: #65716d; font-size: 13px; }
.toolbar { display: flex; gap: 8px; align-items: center; }
input { width: min(260px, 44vw); border: 1px solid #c8d0cc; border-radius: 6px; padding: 8px 10px; background: #ffffff; color: inherit; }
button { border: 1px solid #b8c2bd; border-radius: 6px; padding: 8px 10px; background: #ffffff; color: inherit; cursor: pointer; }
button:hover { border-color: #65716d; }
.status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
.status-grid article, .panel { background: #ffffff; border: 1px solid #d8dedb; border-radius: 8px; }
.status-grid article { padding: 14px; min-height: 76px; }
.status-grid span { display: block; color: #65716d; font-size: 12px; margin-bottom: 8px; }
.status-grid strong { display: block; font-size: 16px; line-height: 1.25; overflow-wrap: anywhere; }
.layout { display: grid; grid-template-columns: minmax(320px, 0.85fr) minmax(360px, 1.15fr); gap: 16px; align-items: start; }
.panel { min-width: 0; overflow: hidden; }
.panel-head { min-height: 48px; padding: 14px 16px; border-bottom: 1px solid #e3e7e5; display: flex; justify-content: space-between; gap: 12px; align-items: center; }
.jobs, .events, #job-detail { padding: 12px; }
.job-card { width: 100%; text-align: left; display: grid; gap: 7px; padding: 12px; margin-bottom: 8px; background: #fbfcfa; }
.job-card.selected { border-color: #28705f; box-shadow: inset 3px 0 0 #28705f; }
.job-row { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
.job-title, .job-message, .job-meta { overflow-wrap: anywhere; }
.job-title { font-weight: 650; }
.job-message { color: #384641; font-size: 13px; }
.job-meta { color: #65716d; font-size: 12px; }
.status { border-radius: 999px; padding: 3px 8px; background: #eef1ef; font-size: 11px; text-transform: uppercase; letter-spacing: 0; white-space: nowrap; }
.status-running, .status-queued { background: #e6f3ee; color: #145c49; }
.status-failed, .status-canceled, .status-denied { background: #f8e9e7; color: #8d281f; }
.status-completed { background: #e8eef7; color: #234f87; }
.status-waiting_approval { background: #f7efdd; color: #725314; }
.detail dl { display: grid; gap: 8px; margin: 0; }
.detail dl div { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 12px; }
dt { color: #65716d; font-size: 12px; }
dd { margin: 0; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.failure { margin-top: 12px; padding: 10px; border-radius: 6px; background: #f8e9e7; color: #8d281f; }
.events-panel { margin-top: 16px; }
.event { display: grid; grid-template-columns: 120px 62px 92px minmax(0, 1fr); gap: 10px; align-items: start; padding: 10px 0; border-bottom: 1px solid #edf0ee; }
.event:last-child { border-bottom: 0; }
.event span, .event em { color: #65716d; font-size: 12px; font-style: normal; }
.event strong { font-size: 12px; text-transform: uppercase; }
.event p { overflow-wrap: anywhere; }
.event-error strong { color: #8d281f; }
.event-warn strong { color: #725314; }
@media (max-width: 860px) {
  .app { padding: 14px; }
  .topbar, .toolbar { flex-direction: column; align-items: stretch; }
  input { width: 100%; }
  .status-grid, .layout { grid-template-columns: 1fr; }
  .event { grid-template-columns: 1fr; gap: 4px; }
}`;
}

function clientScript(): string {
  return `const state = { value: window.__TETHERBOX_INITIAL_STATE__, selectedJobId: window.__TETHERBOX_INITIAL_STATE__.jobs[0]?.id };
const els = {
  summary: document.getElementById("daemon-summary"),
  linear: document.getElementById("linear-status"),
  queue: document.getElementById("queue-status"),
  jobCount: document.getElementById("job-count"),
  eventCount: document.getElementById("event-count"),
  jobs: document.getElementById("jobs"),
  jobsEmpty: document.getElementById("jobs-empty"),
  detail: document.getElementById("job-detail"),
  events: document.getElementById("events"),
  eventsEmpty: document.getElementById("events-empty"),
  token: document.getElementById("operator-token"),
};
els.token.value = sessionStorage.getItem("tetherbox.operatorToken") || "";
els.token.addEventListener("input", () => sessionStorage.setItem("tetherbox.operatorToken", els.token.value));
document.getElementById("refresh").addEventListener("click", refresh);
document.addEventListener("click", async (event) => {
  const jobButton = event.target.closest("[data-job-id].job-card");
  if (jobButton) {
    state.selectedJobId = jobButton.dataset.jobId;
    render();
    return;
  }
  const actionButton = event.target.closest("[data-action]");
  if (actionButton) {
    await runAction(actionButton.dataset.jobId, actionButton.dataset.action);
  }
});
async function refresh() {
  try {
    const response = await fetch("/api/status", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("status " + response.status);
    state.value = await response.json();
    if (!state.value.jobs.some((job) => job.id === state.selectedJobId)) {
      state.selectedJobId = state.value.jobs[0]?.id;
    }
    render();
  } catch (error) {
    els.summary.textContent = "Daemon unavailable: " + (error instanceof Error ? error.message : "unknown error");
  }
}
async function runAction(jobId, action) {
  if (!jobId || !action) return;
  const headers = {};
  if (els.token.value) headers.Authorization = "Bearer " + els.token.value;
  const response = await fetch("/api/jobs/" + encodeURIComponent(jobId) + "/" + action, { method: "POST", headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    els.summary.textContent = action + " failed: " + (body.reason || response.status);
    return;
  }
  await refresh();
}
function render() {
  const data = state.value;
  els.summary.textContent = daemonSummary(data);
  els.linear.textContent = linearStatus(data);
  els.queue.textContent = queueStatus(data);
  els.jobCount.textContent = data.jobs.length;
  els.eventCount.textContent = data.events.length;
  els.jobsEmpty.textContent = data.jobs.length ? "" : "No jobs yet.";
  els.eventsEmpty.textContent = data.events.length ? "" : "No events yet.";
  els.jobs.innerHTML = data.jobs.map((job) => jobCard(job, job.id === state.selectedJobId)).join("");
  const selected = data.jobs.find((job) => job.id === state.selectedJobId);
  els.detail.innerHTML = jobDetail(selected, data.events);
  els.events.innerHTML = data.events.slice(0, 30).map(eventRow).join("");
}
function jobCard(job, selected) {
  return '<button class="job-card' + (selected ? ' selected' : '') + '" type="button" data-job-id="' + escAttr(job.id) + '">' +
    '<span class="job-row"><strong>' + esc(job.issueIdentifier || 'No issue') + '</strong><span class="status status-' + escAttr(job.status) + '">' + esc(job.status) + '</span></span>' +
    '<span class="job-title">' + esc(job.issueTitle || job.id) + '</span>' +
    '<span class="job-meta">' + esc(job.repo) + ' &middot; ' + esc(formatDate(job.updatedAt)) + '</span>' +
    '<span class="job-message">' + esc(job.lastMessage) + '</span></button>';
}
function jobDetail(job, events) {
  if (!job) return '<p class="muted">No job selected.</p>';
  const rows = [
    ['ID', job.id], ['Session', job.sessionId], ['Status', job.status], ['Repository', job.repo],
    ['Issue', [job.issueIdentifier, job.issueTitle].filter(Boolean).join(' ') || 'none'],
    ['Policy', job.policyRule + ' -> ' + job.policyDecision], ['Branch', job.branchName || 'none'],
    ['Worktree', job.worktreePath || 'none'], ['Retry', (job.retryEligible ? 'eligible' : 'not eligible') + ' (' + job.retryCount + ')'],
    ['Last', job.lastMessage],
  ];
  const actions = actionsFor(job);
  const jobEvents = events.filter((event) => event.jobId === job.id).slice(0, 8);
  return '<div class="detail">' + (actions ? '<div class="actions">' + actions + '</div>' : '') +
    '<dl>' + rows.map(([label, value]) => '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>').join('') + '</dl>' +
    (job.failureReason ? '<p class="failure">' + esc(job.failureReason) + '</p>' : '') +
    '<h3>Job Events</h3><div class="events compact">' + (jobEvents.length ? jobEvents.map(eventRow).join('') : '<p class="muted">No job events yet.</p>') + '</div></div>';
}
function actionsFor(job) {
  const buttons = [];
  if (['queued', 'running', 'waiting_approval'].includes(job.status)) buttons.push(actionButton(job, 'cancel', 'Cancel'));
  if (job.retryEligible) buttons.push(actionButton(job, 'retry', 'Retry'));
  if (job.status === 'waiting_approval') {
    buttons.push(actionButton(job, 'approve', 'Approve'));
    buttons.push(actionButton(job, 'deny', 'Deny'));
  }
  return buttons.join('');
}
function actionButton(job, action, label) {
  return '<button type="button" data-action="' + action + '" data-job-id="' + escAttr(job.id) + '">' + label + '</button>';
}
function eventRow(event) {
  return '<article class="event event-' + escAttr(event.level) + '"><span>' + esc(formatDate(event.createdAt)) + '</span><strong>' + esc(event.level) + '</strong><em>' + esc(event.source) + '</em><p>' + esc(event.message) + '</p></article>';
}
function daemonSummary(data) { return 'Started ' + formatDate(data.startedAt); }
function linearStatus(data) { return data.linear?.installed ? (data.linear.appUserId ? 'Installed as ' + data.linear.appUserId : 'Installed') : 'Not installed'; }
function queueStatus(data) {
  if (!data.queue) return 'Unavailable';
  return (data.queue.accepting ? 'accepting' : 'draining') + ', ' + data.queue.running + '/' + data.queue.concurrency + ' running, ' + data.queue.queued + ' queued';
}
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function escAttr(value) { return esc(value); }
setInterval(refresh, 2000);`;
}
