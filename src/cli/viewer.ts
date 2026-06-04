import { Database } from "bun:sqlite";
import { resolveDbPath } from "../index.js";
import * as path from "path";

const dbPath = resolveDbPath();
let db: Database;
try {
  db = new Database(dbPath, { readonly: true });
} catch (e) {
  console.error(`Failed to open database at ${dbPath}: ${String(e)}`);
  process.exit(1);
}

const HTML_TEMPLATE = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AgentLogger Telemetry Dashboard</title>
    <style>
        :root {
            --bg: #0f172a; --surface: #1e293b; --border: #334155;
            --text: #f8fafc; --text-muted: #94a3b8;
            --primary: #38bdf8; --danger: #f87171; --success: #4ade80;
        }
        body {
            font-family: system-ui, -apple-system, sans-serif;
            background: var(--bg); color: var(--text);
            margin: 0; padding: 0; line-height: 1.5;
        }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        header { border-bottom: 1px solid var(--border); padding-bottom: 20px; margin-bottom: 20px; }
        h1 { margin: 0; color: var(--primary); font-size: 1.5rem; }
        .subtitle { color: var(--text-muted); font-size: 0.9rem; margin-top: 5px; }
        .nav { display: flex; gap: 20px; margin: 20px 0; }
        .nav a { color: var(--text-muted); text-decoration: none; padding: 5px 10px; border-radius: 4px; }
        .nav a:hover, .nav a.active { background: var(--surface); color: var(--primary); }
        .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 20px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; }
        .stat { text-align: center; }
        .stat-value { font-size: 2rem; font-weight: bold; color: var(--primary); }
        .stat-label { color: var(--text-muted); font-size: 0.9rem; text-transform: uppercase; letter-spacing: 1px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid var(--border); }
        th { color: var(--text-muted); font-weight: 500; font-size: 0.9rem; }
        tr:last-child td { border-bottom: none; }
        .badge { padding: 2px 8px; border-radius: 12px; font-size: 0.8rem; font-weight: 500; }
        .badge.error { background: rgba(248, 113, 113, 0.2); color: var(--danger); }
        .badge.success { background: rgba(74, 222, 128, 0.2); color: var(--success); }
        .badge.pending { background: rgba(148, 163, 184, 0.2); color: var(--text-muted); }
        pre { background: rgba(0,0,0,0.3); padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 0.85rem; }
    </style>
    <script>
        function toggleDetails(id) {
            const el = document.getElementById(id);
            if (el.style.display === 'none') {
                el.style.display = 'table-row';
            } else {
                el.style.display = 'none';
            }
        }
    </script>
</head>
<body>
    <div class="container">
        <header>
            <h1>AgentLogger Dashboard</h1>
            <div class="subtitle">Connected to: ${dbPath}</div>
        </header>
        <div class="nav">
            <a href="/" class="active">Overview</a>
            <a href="/sessions">Sessions</a>
            <a href="/tools">Tool Calls</a>
        </div>
        <div id="content">{{CONTENT}}</div>
    </div>
</body>
</html>
`;

function renderOverview() {
  try {
    const sessionCount = db.prepare("SELECT COUNT(*) as c FROM codex_sessions").get() as any;
    const toolCount = db.prepare("SELECT COUNT(*) as c, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as err FROM codex_tool_calls").get() as any;
    
    return `<div class="grid">
      <div class="card stat">
        <div class="stat-value">${sessionCount?.c || 0}</div>
        <div class="stat-label">Total Sessions</div>
      </div>
      <div class="card stat">
        <div class="stat-value">${toolCount?.c || 0}</div>
        <div class="stat-label">Total Tool Calls</div>
      </div>
      <div class="card stat">
        <div class="stat-value" style="color: var(--danger)">${toolCount?.err || 0}</div>
        <div class="stat-label">Tool Errors</div>
      </div>
    </div>`;
  } catch (e) {
    return `<div class="card"><p style="color: var(--danger)">Database error: ${String(e)} (Ensure telemetry has been ingested first)</p></div>`;
  }
}

function renderSessions() {
  try {
    const sessions = db.prepare("SELECT session_id, agent_name, start_time, end_time, finish_reason FROM codex_sessions ORDER BY start_time DESC LIMIT 100").all() as any[];
    let html = '<div class="card"><table><tr><th>Session ID</th><th>Agent</th><th>Start Time</th><th>Duration</th><th>Status</th></tr>';
    for (const s of sessions) {
      const start = new Date(s.start_time);
      const duration = s.end_time ? ((s.end_time - s.start_time) / 1000).toFixed(1) + 's' : '-';
      const statusCls = s.finish_reason === 'error' ? 'error' : (s.finish_reason ? 'success' : 'pending');
      html += `<tr>
        <td><code style="color: var(--primary)">${s.session_id.split('-')[0]}...</code></td>
        <td>${s.agent_name || 'unknown'}</td>
        <td>${start.toLocaleString()}</td>
        <td>${duration}</td>
        <td><span class="badge ${statusCls}">${s.finish_reason || 'running'}</span></td>
      </tr>`;
    }
    return html + '</table></div>';
  } catch (e) {
    return `<div class="card"><p>No sessions found. ${String(e)}</p></div>`;
  }
}

function renderTools() {
  try {
    const tools = db.prepare("SELECT call_id, tool_name, status, duration_ms, start_time, input_args, output FROM codex_tool_calls ORDER BY start_time DESC LIMIT 50").all() as any[];
    let html = '<div class="card"><table><tr><th>Tool</th><th>Status</th><th>Duration</th><th>Time</th><th>Details</th></tr>';
    for (let i = 0; i < tools.length; i++) {
      const t = tools[i];
      const date = new Date(t.start_time).toLocaleString();
      const statusCls = t.status === 'error' ? 'error' : (t.status === 'completed' ? 'success' : 'pending');
      const inputStr = t.input_args ? (t.input_args.length > 60 ? t.input_args.substring(0, 60) + '...' : t.input_args) : '';
      
      const safeInput = t.input_args ? String(t.input_args).replace(/</g, '&lt;') : 'null';
      const safeOutput = t.output ? String(t.output).replace(/</g, '&lt;') : 'null';

      html += `<tr>
        <td><strong>${t.tool_name}</strong></td>
        <td><span class="badge ${statusCls}">${t.status}</span></td>
        <td>${t.duration_ms ? t.duration_ms + 'ms' : '-'}</td>
        <td>${date}</td>
        <td>
          <code style="color: var(--primary); font-size: 0.8rem; cursor: pointer;" onclick="toggleDetails('details-${i}')" title="Click to view full input and output">
            ${inputStr.replace(/</g, '&lt;')} <span style="opacity: 0.7;">&#9660;</span>
          </code>
        </td>
      </tr>
      <tr id="details-${i}" style="display: none; background: rgba(0,0,0,0.2);">
        <td colspan="5" style="padding: 15px;">
          <div style="margin-bottom: 10px;">
            <strong style="color: var(--primary); font-size: 0.85rem; text-transform: uppercase;">Full Input Arguments:</strong>
            <pre style="white-space: pre-wrap; word-wrap: break-word; max-height: 200px; overflow-y: auto; margin-top: 5px;">${safeInput}</pre>
          </div>
          <div>
            <strong style="color: var(--primary); font-size: 0.85rem; text-transform: uppercase;">Tool Output:</strong>
            <pre style="white-space: pre-wrap; word-wrap: break-word; max-height: 400px; overflow-y: auto; margin-top: 5px; border-left: 3px solid var(--${statusCls}); padding-left: 10px;">${safeOutput}</pre>
          </div>
        </td>
      </tr>`;
    }
    return html + '</table></div>';
  } catch (e) {
    return `<div class="card"><p>No tool calls found. ${String(e)}</p></div>`;
  }
}

Bun.serve({
  port: 3333,
  fetch(req) {
    const url = new URL(req.url);
    let content = "";
    let template = HTML_TEMPLATE;
    
    if (url.pathname === "/") {
      content = renderOverview();
    } else if (url.pathname === "/sessions") {
      content = renderSessions();
      template = template.replace('href="/" class="active"', 'href="/"').replace('href="/sessions"', 'href="/sessions" class="active"');
    } else if (url.pathname === "/tools") {
      content = renderTools();
      template = template.replace('href="/" class="active"', 'href="/"').replace('href="/tools"', 'href="/tools" class="active"');
    } else {
      return new Response("Not found", { status: 404 });
    }

    return new Response(template.replace("{{CONTENT}}", content), { 
      headers: { "Content-Type": "text/html" } 
    });
  }
});

console.log("----------------------------------------");
console.log(" AgentLogger Telemetry Viewer Started!  ");
console.log("----------------------------------------");
console.log(` DB Path: ${dbPath}`);
console.log(" URL:     http://localhost:3333");
console.log("----------------------------------------");
