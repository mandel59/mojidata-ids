// ids-editor.ts
// SPDX-FileCopyrightText: 2026 Ryusei Yamaguchi <mandel59@gmail.com>
// SPDX-License-Identifier: MIT-0
// This code was generated with Codex using GPT-5.2.

// IDS.TXT compatible editor server (single-file implementation).
//
// Usage:
//   bun run scripts/ids-editor.ts <ids-file> [--port <port>]

import { validateIdsExpression, validateSourceTag } from "./ids-validate-lib.js";

type IDSItem = { ids: string; source: string };
type IDSRecord = { codepoint: string; char: string; data: IDSItem[]; comment?: string };
type RecordFlags = { isEmpty: boolean; issueCount: number };

type LayoutItem =
    | { kind: "raw"; text: string }
    | { kind: "record"; index: number };

type ValidationIssue = { path: string; message: string };

type DocumentState = {
    filePath: string;
    endsWithNewline: boolean;
    layout: LayoutItem[];
    records: IDSRecord[];
    recordFlags: RecordFlags[];
    warnings: string[];
    dirty: boolean;
    lastSavedAtMs: number | null;
    autoSave: boolean;
    pendingSaveTimer: ReturnType<typeof setTimeout> | null;
};

if (import.meta.main) {
    await main();
}

async function main() {
    const args = Bun.argv.slice(2);
    const filePath = args[0];
    if (filePath == null || filePath.trim() === "" || filePath.startsWith("-")) {
        console.error("Usage: bun run scripts/ids-editor.ts <ids-file> [--port <port>]");
        process.exitCode = 2;
        return;
    }

    const port = parsePort(args) ?? parseInt(Bun.env.PORT ?? "3000", 10);
    if (!Number.isFinite(port) || port < 0 || port >= 65536) {
        console.error("Invalid port.");
        process.exitCode = 2;
        return;
    }

    const text = await Bun.file(filePath).text();
    const parsed = parseDocument(text);

    const state: DocumentState = {
        filePath,
        endsWithNewline: parsed.endsWithNewline,
        layout: parsed.layout,
        records: parsed.records,
        recordFlags: parsed.records.map(computeRecordFlags),
        warnings: parsed.warnings,
        dirty: false,
        lastSavedAtMs: null,
        autoSave: true,
        pendingSaveTimer: null,
    };

    const server = Bun.serve({
        port,
        fetch: (req) => route(req, state),
        error: (err) => new Response(String(err), { status: 500 }),
    });

    const url = `http://localhost:${server.port}/`;
    console.log(`IDS Editor: ${filePath}`);
    console.log(`Open: ${url}`);
}

function parsePort(args: string[]) {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--port") {
            const next = args[i + 1];
            if (next == null) return null;
            const n = parseInt(next, 10);
            return Number.isFinite(n) ? n : null;
        }
        if (a?.startsWith("--port=")) {
            const n = parseInt(a.slice("--port=".length), 10);
            return Number.isFinite(n) ? n : null;
        }
    }
    return null;
}

function parseDocument(text: string) {
    const endsWithNewline = text.endsWith("\n");
    const normalized = text.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    if (endsWithNewline) lines.pop();

    const layout: LayoutItem[] = [];
    const records: IDSRecord[] = [];
    const warnings: string[] = [];

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex] ?? "";
        if (line.trim() === "" || line.startsWith("#")) {
            layout.push({ kind: "raw", text: line });
            continue;
        }

        const cols = line.split("\t");
        const codepoint = cols[0];
        const char = cols[1];
        if (codepoint == null || char == null) {
            layout.push({ kind: "raw", text: line });
            continue;
        }

        const data: IDSItem[] = [];
        let comment: string | undefined = undefined;
        let sawUnknown = false;

        for (const col of cols.slice(2)) {
            if (col === "") continue;
            if (col.startsWith("*")) {
                const c = col.slice(1);
                comment = comment == null ? c : `${comment} ${c}`;
                continue;
            }
            if (col.startsWith("^")) {
                const parsedField = parseIdsField(col);
                if (!parsedField.ok) {
                    warnings.push(`Line ${lineIndex + 1}: invalid IDS field: ${parsedField.message}`);
                }
                data.push({ ids: parsedField.ids, source: parsedField.source });
                continue;
            }
            sawUnknown = true;
        }

        if (sawUnknown) {
            layout.push({ kind: "raw", text: line });
            continue;
        }

        const index = records.length;
        records.push({ codepoint, char, data, comment });
        layout.push({ kind: "record", index });
    }

    return { endsWithNewline, layout, records, warnings };
}

function parseIdsField(field: string): { ok: true; ids: string; source: string } | { ok: false; ids: string; source: string; message: string } {
    const m = field.match(/^\^(.*)\$\((.*)\)$/);
    if (m?.[1] != null && m[2] != null) {
        return { ok: true, ids: m[1], source: m[2] };
    }
    const fallback = field.startsWith("^") ? field.slice(1) : field;
    return {
        ok: false,
        ids: fallback,
        source: "",
        message: `expected ^<ids>$(<source>), got: ${field}`,
    };
}

function serializeDocument(state: DocumentState) {
    const outLines: string[] = [];
    for (const item of state.layout) {
        if (item.kind === "raw") {
            outLines.push(item.text);
            continue;
        }
        const rec = state.records[item.index];
        if (rec == null) continue;
        outLines.push(serializeRecord(rec));
    }
    const joined = outLines.join("\n");
    return state.endsWithNewline ? `${joined}\n` : joined;
}

function serializeRecord(rec: IDSRecord) {
    const cols: string[] = [rec.codepoint, rec.char];
    for (const item of rec.data) {
        cols.push(`^${item.ids}$(${item.source})`);
    }
    const c = rec.comment?.trim();
    if (c != null && c !== "") cols.push(`*${c}`);
    // If neither IDS data nor comment exists, keep a trailing TAB at end of line.
    // This matches existing draft file style where records may end with a TAB.
    if (rec.data.length === 0 && (c == null || c === "")) {
        return `${rec.codepoint}\t${rec.char}\t`;
    }
    return cols.join("\t");
}

function validateRecord(rec: IDSRecord): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (rec.codepoint.includes("\t") || rec.codepoint.includes("\n") || rec.codepoint.includes("\r")) {
        issues.push({ path: "codepoint", message: "Codepoint must not contain tabs/newlines." });
    }
    if (rec.char.includes("\t") || rec.char.includes("\n") || rec.char.includes("\r")) {
        issues.push({ path: "char", message: "Char must not contain tabs/newlines." });
    }

    for (let i = 0; i < rec.data.length; i++) {
        const item = rec.data[i];
        if (item == null) continue;
        const ids = String(item.ids ?? "");
        const source = String(item.source ?? "");

        const idsRes = validateIdsExpression(ids);
        if (!idsRes.ok) issues.push({ path: `data[${i}].ids`, message: idsRes.issues[0]?.message ?? "Invalid IDS." });

        const srcRes = validateSourceTag(source);
        if (!srcRes.ok) issues.push({ path: `data[${i}].source`, message: srcRes.issues[0]?.message ?? "Invalid source." });
    }

    const comment = rec.comment ?? "";
    if (/\t/.test(comment)) issues.push({ path: "comment", message: "Comment must not contain tabs." });

    return issues;
}

function computeRecordFlags(rec: IDSRecord): RecordFlags {
    const comment = (rec.comment ?? "").trim();
    const isEmpty = rec.data.length === 0 && comment === "";
    const issueCount = validateRecord(rec).length;
    return { isEmpty, issueCount };
}

function recordMatchesTerm(rec: IDSRecord, termLower: string) {
    if (rec.codepoint.toLowerCase().includes(termLower)) return true;
    if (rec.char.toLowerCase().includes(termLower)) return true;
    if ((rec.comment ?? "").toLowerCase().includes(termLower)) return true;
    for (const d of rec.data) {
        if ((d.ids ?? "").toLowerCase().includes(termLower)) return true;
        if ((d.source ?? "").toLowerCase().includes(termLower)) return true;
    }
    return false;
}

async function route(req: Request, state: DocumentState): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
        return new Response(renderHtml(), {
            headers: {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
            },
        });
    }

    if (req.method === "GET" && path === "/api/meta") {
        return json({
            filePath: state.filePath,
            recordCount: state.records.length,
            dirty: state.dirty,
            lastSavedAtMs: state.lastSavedAtMs,
            warnings: state.warnings,
        });
    }

    if (req.method === "GET" && path === "/api/records") {
        return json({
            records: state.records.map((r, i) => {
                const flags = state.recordFlags[i] ?? computeRecordFlags(r);
                return {
                    index: i,
                    codepoint: r.codepoint,
                    char: r.char,
                    isEmpty: flags.isEmpty,
                    issueCount: flags.issueCount,
                    hasError: flags.issueCount > 0,
                };
            }),
        });
    }

    if (req.method === "GET" && path === "/assets/ids-validate.js") {
        return new Response(Bun.file(new URL("./ids-validate-lib.js", import.meta.url)), {
            headers: {
                "content-type": "text/javascript; charset=utf-8",
                "cache-control": "no-store",
            },
        });
    }

    if (req.method === "GET" && path === "/api/search") {
        const termRaw = url.searchParams.get("term") ?? "";
        const term = termRaw.trim();
        if (term === "") {
            return json({ indices: state.records.map((_, i) => i), totalMatches: state.records.length, truncated: false });
        }

        const termLower = term.toLowerCase();
        const limitRaw = parseInt(url.searchParams.get("limit") ?? "20000", 10);
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100000, limitRaw)) : 20000;

        const indices: number[] = [];
        let totalMatches = 0;
        for (let i = 0; i < state.records.length; i++) {
            const rec = state.records[i];
            if (rec != null && recordMatchesTerm(rec, termLower)) {
                totalMatches++;
                if (indices.length < limit) indices.push(i);
            }
        }

        return json({ indices, totalMatches, truncated: totalMatches > indices.length });
    }

    const recordMatch = path.match(/^\/api\/record\/(\d+)$/);
    if (recordMatch != null) {
        const index = parseInt(recordMatch[1] ?? "", 10);
        const rec = state.records[index];
        if (rec == null) return json({ error: "Not found." }, 404);

        if (req.method === "GET") {
            return json({ index, record: rec });
        }

        if (req.method === "POST") {
            const body = await req.json().catch(() => null) as unknown;
            if (body == null || typeof body !== "object") return json({ error: "Invalid JSON." }, 400);
            const candidate = (body as { record?: IDSRecord }).record;
            if (candidate == null) return json({ error: "Missing record." }, 400);

            const normalized = normalizeRecord(candidate);
            const issues = validateRecord(normalized);
            if (issues.length > 0) return json({ error: "Validation failed.", issues }, 400);

            state.records[index] = normalized;
            state.recordFlags[index] = computeRecordFlags(normalized);
            state.dirty = true;

            if (state.autoSave) scheduleSave(state);
            return json({ ok: true });
        }

        return json({ error: "Method not allowed." }, 405);
    }

    if (req.method === "POST" && path === "/api/save") {
        const issues = validateAllRecords(state.records);
        if (issues.length > 0) return json({ error: "Validation failed.", issues }, 400);

        const output = serializeDocument(state);
        await Bun.write(state.filePath, output);
        state.dirty = false;
        state.lastSavedAtMs = Date.now();
        return json({ ok: true, lastSavedAtMs: state.lastSavedAtMs, bytes: output.length });
    }

    if (req.method === "POST" && path === "/api/autosave") {
        const body = await req.json().catch(() => null) as unknown;
        const enabled = (body as { enabled?: unknown } | null)?.enabled;
        state.autoSave = enabled === true;
        if (!state.autoSave && state.pendingSaveTimer != null) {
            clearTimeout(state.pendingSaveTimer);
            state.pendingSaveTimer = null;
        }
        return json({ ok: true, enabled: state.autoSave });
    }

    return new Response("Not found.", { status: 404 });
}

function normalizeRecord(rec: IDSRecord): IDSRecord {
    const codepoint = String(rec.codepoint ?? "").trim();
    const char = String(rec.char ?? "");
    const data = Array.isArray(rec.data) ? rec.data.map((d) => ({ ids: String(d?.ids ?? ""), source: String(d?.source ?? "") })) : [];
    const commentRaw = rec.comment == null ? undefined : String(rec.comment);
    const comment = commentRaw == null ? undefined : commentRaw.replace(/[\r\n]+/g, " ");
    return { codepoint, char, data, comment };
}

function validateAllRecords(records: IDSRecord[]): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        if (rec == null) continue;
        for (const issue of validateRecord(rec)) {
            issues.push({ path: `record[${i}].${issue.path}`, message: issue.message });
        }
        if (issues.length > 5000) break;
    }
    return issues;
}

function scheduleSave(state: DocumentState) {
    if (state.pendingSaveTimer != null) clearTimeout(state.pendingSaveTimer);
    state.pendingSaveTimer = setTimeout(async () => {
        state.pendingSaveTimer = null;
        if (!state.autoSave || !state.dirty) return;
        const issues = validateAllRecords(state.records);
        if (issues.length > 0) return;
        const output = serializeDocument(state);
        await Bun.write(state.filePath, output);
        state.dirty = false;
        state.lastSavedAtMs = Date.now();
    }, 1500);
}

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
        },
    });
}

function renderHtml() {
    return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>IDS Editor</title>
  <style>
    :root{
      --bg:#0b1020;
      --panel:#111a33;
      --panel2:#0f1730;
      --text:#e6e9f2;
      --muted:#9aa4c4;
      --accent:#7aa2ff;
      --danger:#ff6b6b;
      --ok:#47d18c;
      --border:rgba(255,255,255,.10);
      --shadow: 0 10px 30px rgba(0,0,0,.35);
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      --sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family:var(--sans);
      background: radial-gradient(1200px 700px at 20% 0%, rgba(122,162,255,.22), transparent 55%),
                  radial-gradient(900px 600px at 80% 0%, rgba(71,209,140,.16), transparent 55%),
                  var(--bg);
      color:var(--text);
      height:100vh;
      overflow:hidden;
    }
    header{
      display:flex; align-items:center; justify-content:space-between;
      padding:12px 14px;
      border-bottom:1px solid var(--border);
      background: linear-gradient(to bottom, rgba(255,255,255,.06), rgba(255,255,255,0));
    }
    header .title{font-weight:700; letter-spacing:.2px}
    header .meta{color:var(--muted); font-size:12px; font-family:var(--mono)}
    .layout{display:flex; height:calc(100vh - 49px)}
    .sidebar{
      width: var(--sidebar-w, 360px); min-width:260px; max-width:720px;
      border-right:1px solid var(--border);
      background: rgba(17,26,51,.65);
      backdrop-filter: blur(8px);
      display:flex; flex-direction:column;
    }
    .splitter-v{
      width: 10px;
      cursor: col-resize;
      background: rgba(255,255,255,.02);
      position: relative;
    }
    .splitter-v::before{
      content:'';
      position:absolute;
      top:0; bottom:0;
      left:50%;
      width:1px;
      transform: translateX(-50%);
      background: rgba(255,255,255,.08);
    }
    .splitter-v:hover::before{background: rgba(122,162,255,.45)}
    .controls{padding:12px; border-bottom:1px solid var(--border)}
    .controls input{
      width:100%;
      padding:10px 12px;
      border-radius:12px;
      border:1px solid var(--border);
      background: rgba(15,23,48,.9);
      color:var(--text);
      outline:none;
    }
    .controls .hint{margin-top:8px; color:var(--muted); font-size:12px; display:flex; justify-content:space-between}
    .list{
      position:relative;
      flex:1;
      overflow:auto;
      font-family:var(--mono);
      font-size:12px;
      outline:none;
    }
    .list:focus{box-shadow: inset 0 0 0 2px rgba(122,162,255,.35)}
    .list-inner{position:relative; width:100%;}
    .row{
      position:absolute; left:0; right:0;
      height:28px;
      display:flex; align-items:center;
      padding:0 10px;
      border-bottom:1px solid rgba(255,255,255,.06);
      cursor:pointer;
      user-select:none;
      gap:10px;
    }
    .row:hover{background: rgba(122,162,255,.10)}
    .row.active{background: rgba(122,162,255,.18)}
    .row.has-error{box-shadow: inset 3px 0 0 rgba(255,107,107,.85)}
    .row.is-empty{opacity:.72}
    .cell-code{width:84px; color:var(--muted)}
    .cell-char{font-size:16px}
    .cell-right{margin-left:auto; display:flex; gap:6px; align-items:center}
    .badge{
      font-family: var(--mono);
      font-size: 9px;
      padding: 2px 6px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(15,23,48,.85);
      color: var(--muted);
      line-height: 1;
      white-space: nowrap;
      height: 18px;
      display: inline-flex;
      align-items: center;
    }
    .badge.err{border-color: rgba(255,107,107,.40); color: rgba(255,107,107,.95); background: rgba(255,107,107,.10)}
    .badge.empty{border-color: rgba(154,164,196,.35); color: rgba(154,164,196,.95); background: rgba(154,164,196,.08)}
    main{
      flex:1;
      display:flex;
      flex-direction:column;
      background: rgba(11,16,32,.6);
      backdrop-filter: blur(8px);
    }
    .main-top{
      padding:14px;
      border-bottom:1px solid var(--border);
      display:flex;
      gap:12px;
      align-items:center;
      justify-content:space-between;
    }
    .statusbar{
      padding:10px 14px;
      border-bottom:1px solid var(--border);
      background: rgba(17,26,51,.22);
    }
    .chip{
      display:inline-flex; align-items:center; gap:8px;
      padding:8px 10px;
      border:1px solid var(--border);
      border-radius:999px;
      background: rgba(15,23,48,.85);
      box-shadow: var(--shadow);
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted);
    }
    .chip b{color:var(--text); font-weight:700}
    .actions{display:flex; gap:10px; align-items:center}
    button{
      border:1px solid var(--border);
      background: rgba(15,23,48,.85);
      color: var(--text);
      padding:10px 12px;
      border-radius: 12px;
      cursor:pointer;
    }
    button:hover{border-color: rgba(122,162,255,.55)}
    button.primary{background: rgba(122,162,255,.18); border-color: rgba(122,162,255,.40)}
    button.danger{background: rgba(255,107,107,.14); border-color: rgba(255,107,107,.35)}
    button:disabled{opacity:.5; cursor:not-allowed}
    label.switch{display:flex; gap:8px; align-items:center; color:var(--muted); font-family:var(--mono); font-size:12px}
    label.switch input{accent-color: var(--accent)}
    .editor{
      flex: 1;
      min-width: 0;
      padding:16px;
      overflow:auto;
    }
    .content{
      flex: 1;
      min-height: 0;
      display: flex;
    }
    .zi-panel{
      width: var(--zi-w, 520px);
      min-width: 320px;
      max-width: 75vw;
      border-left: 1px solid var(--border);
      background: rgba(17,26,51,.38);
      display: none;
      flex-direction: column;
      overflow: hidden;
    }
    .zi-bar{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      padding:10px 14px;
      border-bottom: 1px solid rgba(255,255,255,.08);
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted);
    }
    .zi-bar a{color: var(--accent); text-decoration:none}
    .zi-bar a:hover{text-decoration: underline}
    .zi-frame{
      width: 100%;
      height: 100%;
      border: 0;
      background: rgba(15,23,48,.9);
    }
    .card{
      border:1px solid var(--border);
      border-radius:16px;
      padding:14px;
      background: rgba(17,26,51,.6);
      box-shadow: var(--shadow);
    }
    .grid{
      display:grid;
      grid-template-columns: 150px 1fr;
      gap:10px 14px;
      align-items:center;
    }
    .grid .value{
      padding:10px 12px;
      border-radius:12px;
      border:1px solid var(--border);
      background: rgba(15,23,48,.9);
      font-family: var(--mono);
    }
    .bigchar{
      font-size:56px;
      line-height:1;
      padding: 6px 0;
      font-family: "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif CJK JP", serif;
      text-shadow: 0 6px 24px rgba(0,0,0,.35);
    }
    .section-title{
      margin:16px 0 10px;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 12px;
      letter-spacing: .4px;
      text-transform: uppercase;
    }
    table{width:100%; border-collapse:collapse; font-family:var(--mono)}
    th, td{padding:10px 8px; border-bottom:1px solid rgba(255,255,255,.08); vertical-align:top}
    th{color:var(--muted); font-size:12px; text-align:left; font-weight:600}
    input.text, textarea{
      width:100%;
      padding:10px 12px;
      border-radius:12px;
      border:1px solid var(--border);
      background: rgba(15,23,48,.9);
      color: var(--text);
      outline:none;
      font-family: var(--mono);
      font-size: 12px;
    }
    textarea{min-height:90px; resize:vertical}
    .error{
      border-color: rgba(255,107,107,.55) !important;
      box-shadow: 0 0 0 3px rgba(255,107,107,.12);
    }
    .errtext{color: var(--danger); font-size:12px; margin-top:6px}
    .status{
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted);
      display:flex;
      gap:10px;
      align-items:center;
    }
    .empty{
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted);
      padding: 12px;
    }
    .status .dot{width:10px; height:10px; border-radius:50%}
    .dot.ok{background: var(--ok)}
    .dot.warn{background: var(--danger)}
    .dot.neutral{background: var(--muted)}
  </style>
</head>
<body>
  <header>
    <div class="title">IDS Editor</div>
    <div class="meta" id="meta">loading...</div>
  </header>
  <div class="layout">
    <aside class="sidebar">
      <div class="controls">
        <input id="filter" placeholder="Filter (codepoint / char / ids / source / comment)" />
        <div class="hint">
          <span id="count">0</span>
          <span id="warn"></span>
        </div>
      </div>
      <div class="list" id="list" tabindex="0" role="listbox" aria-label="Record list">
        <div class="list-inner" id="listInner"></div>
      </div>
    </aside>
    <div class="splitter-v" id="splitV" title="Resize list"></div>
    <main>
      <div class="main-top">
        <div class="chip"><b id="curCode">—</b><span id="curIndex"></span></div>
        <div class="actions">
          <label class="switch"><input type="checkbox" id="autosave" /> autosave</label>
          <button id="openZi">Zi.tools</button>
          <button class="primary" id="saveBtn">Save</button>
        </div>
      </div>
      <div class="statusbar">
        <div class="status" id="status"><span class="dot neutral"></span><span>Open a record from the list.</span></div>
      </div>
      <div class="content">
        <div class="editor">
          <div class="card" id="editorCard">
            <div class="empty" id="emptyState">Select a record from the list.</div>
            <div id="editorBody" style="display:none">
              <div class="grid" style="margin-top:12px">
                <div style="color:var(--muted); font-family:var(--mono); font-size:12px">Codepoint</div>
                <div class="value" id="codepoint"></div>
                <div style="color:var(--muted); font-family:var(--mono); font-size:12px">Char</div>
                <div class="value" id="charBox"><div class="bigchar" id="char"></div></div>
              </div>

              <div class="section-title">IDS + Source</div>
              <table>
                <thead>
                  <tr><th style="width:60%">IDS</th><th style="width:30%">Source</th><th style="width:10%"></th></tr>
                </thead>
                <tbody id="dataRows"></tbody>
              </table>
              <div style="display:flex; gap:10px; margin-top:10px">
                <button id="addRow">Add row</button>
                <button class="danger" id="clearRows">Clear</button>
              </div>

              <div class="section-title">Comment</div>
              <textarea id="comment" placeholder="(optional)"></textarea>
              <div id="commentErr" class="errtext" style="display:none"></div>
            </div>
          </div>
        </div>
        <div class="splitter-v" id="splitZiV" title="Resize Zi.tools pane" style="display:none"></div>
        <div class="zi-panel" id="ziPanel">
          <div class="zi-bar">
            <div><span style="color:var(--text)">Zi.tools</span> <span id="ziTitle">—</span></div>
            <div style="display:flex; gap:10px; align-items:center">
              <a id="ziLink" href="#" target="_blank" rel="noreferrer">open in new tab</a>
              <button id="closeZi">Close</button>
            </div>
          </div>
          <iframe class="zi-frame" id="ziFrame" loading="lazy" referrerpolicy="no-referrer"></iframe>
        </div>
      </div>
    </main>
  </div>

  <script type="module">
    import { validateIdsExpression, validateSourceTag } from '/assets/ids-validate.js';

    const qs = (s) => document.querySelector(s);
    const elMeta = qs('#meta');
    const elCount = qs('#count');
    const elWarn = qs('#warn');
    const elFilter = qs('#filter');
    const elList = qs('#list');
    const elListInner = qs('#listInner');
    const elSidebar = qs('.sidebar');
    const elSplitV = qs('#splitV');
    const elCurCode = qs('#curCode');
    const elCurIndex = qs('#curIndex');
    const elAutoSave = qs('#autosave');
    const elOpenZi = qs('#openZi');
    const elZiPanel = qs('#ziPanel');
    const elSplitZiV = qs('#splitZiV');
    const elZiFrame = qs('#ziFrame');
    const elZiLink = qs('#ziLink');
    const elZiTitle = qs('#ziTitle');
    const elCloseZi = qs('#closeZi');
    const elSaveBtn = qs('#saveBtn');
    const elStatus = qs('#status');
    const elEmptyState = qs('#emptyState');
    const elEditorBody = qs('#editorBody');
    const elCodepoint = qs('#codepoint');
    const elCharBox = qs('#charBox');
    const elChar = qs('#char');
    const elDataRows = qs('#dataRows');
    const elAddRow = qs('#addRow');
    const elClearRows = qs('#clearRows');
    const elComment = qs('#comment');
    const elCommentErr = qs('#commentErr');

    const ROW_H = 28;
    let meta = null;
    let summaries = [];
    let filtered = [];
    let activeIndex = null;
    let activeRecord = null;
    let activeErrors = [];
    let activeServerErrors = [];
    const pendingServerIssues = new Map();
    let updateTimer = null;
    let lastSavedAtMs = null;
	    let serverDirty = false;
	    let metaPollTimer = null;
	    let activePos = null;
	    let posByIndex = new Map();
    let searchTimer = null;
    let searchToken = 0;
    let searchTruncated = false;

    const sidebarWidthKey = 'ids-editor:sidebarWidthPx';
    const ziWidthKey = 'ids-editor:ziWidthPx';
    let dragging = null;

    function ziUrlForChar(ch){
      const s = String(ch ?? '');
      if(!s) return null;
      return 'https://zi.tools/zi/' + encodeURIComponent(s);
    }

    function openZiForActive(){
      if(activeRecord == null){
        setStatus('warn', 'Select a record first.');
        return;
      }
      const url = ziUrlForChar(activeRecord.char);
      if(url == null){
        setStatus('warn', 'No character.');
        return;
      }
      elZiPanel.style.display = 'flex';
      elSplitZiV.style.display = 'block';
      elZiFrame.src = url;
      elZiLink.href = url;
      elZiTitle.textContent = activeRecord.codepoint + ' ' + activeRecord.char;
    }

    function closeZi(){
      elZiPanel.style.display = 'none';
      elSplitZiV.style.display = 'none';
      elZiFrame.src = 'about:blank';
      elZiLink.href = '#';
      elZiTitle.textContent = '—';
    }

    function applySidebarWidthPx(px){
      const w = Math.max(260, Math.min(720, Math.floor(px)));
      document.documentElement.style.setProperty('--sidebar-w', w + 'px');
      return w;
    }

    function applyZiWidthPx(px){
      const minW = 320;
      const maxW = Math.floor(window.innerWidth * 0.75);
      const w = Math.max(minW, Math.min(maxW, Math.floor(px)));
      document.documentElement.style.setProperty('--zi-w', w + 'px');
      return w;
    }

    function startDrag(kind, ev){
      dragging = kind;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = kind === 'v' ? 'col-resize' : 'row-resize';
      try { ev.target.setPointerCapture(ev.pointerId); } catch {}
    }

    function endDrag(){
      dragging = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }

    const autosaveKey = 'ids-editor:autosave';
    elAutoSave.checked = (localStorage.getItem(autosaveKey) ?? 'true') === 'true';

    async function apiGet(path){
      const res = await fetch(path, {cache:'no-store'});
      if(!res.ok) throw new Error(await res.text());
      return await res.json();
    }
    async function apiPost(path, body){
      const res = await fetch(path, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body ?? {})});
      const data = await res.json().catch(() => null);
      if(!res.ok) {
        const msg = data?.error ? data.error : 'Request failed';
        const err = new Error(msg);
        err.data = data;
        throw err;
      }
      return data;
    }

    function ingestServerIssues(issues){
      const byIndex = new Map();
      let firstIndex = null;
      for(const it of (issues ?? [])){
        const path = String(it?.path ?? '');
        const message = String(it?.message ?? 'Validation failed.');
        const m = path.match(/^record\[(\d+)\]\.(.+)$/);
        if(m){
          const idx = Number(m[1]);
          const p = m[2];
          if(!byIndex.has(idx)) byIndex.set(idx, []);
          byIndex.get(idx).push({path:p, message});
          if(firstIndex == null) firstIndex = idx;
        } else {
          // record-local issues (e.g. /api/record/:id)
          if(activeIndex != null){
            const idx = activeIndex;
            if(!byIndex.has(idx)) byIndex.set(idx, []);
            byIndex.get(idx).push({path, message});
            if(firstIndex == null) firstIndex = idx;
          }
        }
      }
      return { byIndex, firstIndex };
    }

    function setStatus(kind, text){
      const dot = elStatus.querySelector('.dot');
      dot.className = 'dot ' + (kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : 'neutral');
      elStatus.querySelector('span:last-child').textContent = text;
    }

	    function validateRecord(rec){
	      const issues = [];
	      for(let i=0;i<rec.data.length;i++){
	        const d = rec.data[i] || {ids:'',source:''};
	        const ids = String(d.ids ?? '');
	        const src = String(d.source ?? '');

	        const idsRes = validateIdsExpression(ids);
	        if(!idsRes.ok) issues.push({path:\`data[\${i}].ids\`, message: idsRes.issues?.[0]?.message ?? 'Invalid IDS.'});

	        const srcRes = validateSourceTag(src);
	        if(!srcRes.ok) issues.push({path:\`data[\${i}].source\`, message: srcRes.issues?.[0]?.message ?? 'Invalid source.'});
	      }
	      const c = String(rec.comment ?? '');
	      if(/\\t/.test(c)) issues.push({path:'comment', message:'Comment must not contain tabs.'});
	      return issues;
	    }

	    function applyFilter(){
	      const term = elFilter.value.trim();
	      if(searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
	      const token = ++searchToken;

	      if(!term){
	        filtered = summaries.map((_,i)=>i);
	        searchTruncated = false;

	        posByIndex = new Map();
	        for(let pos=0; pos<filtered.length; pos++){
	          posByIndex.set(filtered[pos], pos);
	        }
	        if(activeIndex != null && posByIndex.has(activeIndex)){
	          activePos = posByIndex.get(activeIndex);
	        } else {
	          activePos = null;
	        }

	        elCount.textContent = \`\${filtered.length} / \${summaries.length}\`;
	        refreshList(true);
	        return;
	      }

	      // Server-side search supports partial match on IDS/source/comment without per-record fetches.
	      elCount.textContent = \`… / \${summaries.length}\`;
	      searchTimer = setTimeout(async () => {
	        try{
	          const res = await apiGet('/api/search?term=' + encodeURIComponent(term));
	          if(token !== searchToken) return;
	          filtered = res.indices || [];
	          searchTruncated = !!res.truncated;

	          posByIndex = new Map();
	          for(let pos=0; pos<filtered.length; pos++){
	            posByIndex.set(filtered[pos], pos);
	          }
	          if(activeIndex != null && posByIndex.has(activeIndex)){
	            activePos = posByIndex.get(activeIndex);
	          } else {
	            activePos = null;
	          }

	          const suffix = searchTruncated ? ' (truncated)' : '';
	          elCount.textContent = \`\${filtered.length} / \${summaries.length}\${suffix}\`;
	          refreshList(true);
	        } catch(e){
	          if(token !== searchToken) return;
	          setStatus('warn', String(e?.message ?? e));
	        }
	      }, 180);
	    }

    function refreshList(resetScroll){
      const total = filtered.length;
      const height = total * ROW_H;
      elListInner.style.height = height + 'px';
      if(resetScroll) elList.scrollTop = 0;
      renderVisibleRows();
    }

    function ensurePosVisible(pos){
      const top = pos * ROW_H;
      const bottom = top + ROW_H;
      const viewTop = elList.scrollTop;
      const viewBottom = viewTop + elList.clientHeight;
      if(top < viewTop){
        elList.scrollTop = top;
      } else if(bottom > viewBottom){
        elList.scrollTop = Math.max(0, bottom - elList.clientHeight);
      }
    }

    function renderVisibleRows(){
      const total = filtered.length;
      const scrollTop = elList.scrollTop;
      const viewH = elList.clientHeight;
      const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
      const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + 10);

      elListInner.replaceChildren();

      for(let pos=start; pos<end; pos++){
        const idx = filtered[pos];
        const s = summaries[idx];
        const row = document.createElement('div');
        row.className = 'row' + (idx === activeIndex ? ' active' : '') + (s?.hasError ? ' has-error' : '') + (s?.isEmpty ? ' is-empty' : '');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', idx === activeIndex ? 'true' : 'false');
        row.style.transform = \`translateY(\${pos * ROW_H}px)\`;
        const code = document.createElement('div');
        code.className = 'cell-code';
        code.textContent = s.codepoint;
        const ch = document.createElement('div');
        ch.className = 'cell-char';
        ch.textContent = s.char;
        row.appendChild(code);
        row.appendChild(ch);

        const right = document.createElement('div');
        right.className = 'cell-right';
        if(s?.isEmpty){
          const b = document.createElement('div');
          b.className = 'badge empty';
          b.textContent = 'EMPTY';
          right.appendChild(b);
        }
        if(s?.hasError){
          const b = document.createElement('div');
          b.className = 'badge err';
          b.textContent = s.issueCount > 0 ? ('ERR ' + s.issueCount) : 'ERR';
          right.appendChild(b);
        }
        row.appendChild(right);

        row.addEventListener('click', () => { elList.focus(); openRecord(idx); });
        elListInner.appendChild(row);
      }
    }

    async function openRecord(index){
      activeIndex = index;
      activePos = posByIndex.get(index) ?? null;
      elCurIndex.textContent = \`#\${index}\`;
      elCurCode.textContent = summaries[index]?.codepoint ?? '—';
      renderVisibleRows();

      setStatus('neutral', 'Loading...');
      try{
        const data = await apiGet('/api/record/' + index);
        activeRecord = structuredClone(data.record);
        activeServerErrors = pendingServerIssues.get(index) ?? [];
        pendingServerIssues.delete(index);
        activeErrors = validateRecord(activeRecord);
        renderEditor();
        updateStatusFromErrors();
        elOpenZi.disabled = false;
        if(elZiPanel.style.display !== 'none'){
          openZiForActive();
        }
      } catch (e){
        setStatus('warn', String(e?.message ?? e));
      }
    }

    function updateStatusFromErrors(){
      if(activeIndex == null || !activeRecord){
        setStatus('neutral', 'Open a record from the list.');
        return;
      }
      if(activeErrors.length){
        setStatus('warn', \`Fix errors (\${activeErrors.length})\`);
      } else {
        const saved = lastSavedAtMs ? new Date(lastSavedAtMs).toLocaleString() : '—';
        if(serverDirty){
          setStatus('neutral', \`OK. autosave pending… (last saved: \${saved})\`);
        } else {
          setStatus('ok', \`OK. last saved: \${saved}\`);
        }
      }
    }

    function renderEditor(){
      if(activeIndex == null || !activeRecord) return;
      elEditorBody.style.display = '';
      elEmptyState.style.display = 'none';
      elCodepoint.textContent = activeRecord.codepoint;
      elChar.textContent = activeRecord.char;

      elDataRows.replaceChildren();
      for(let i=0;i<activeRecord.data.length;i++){
        const d = activeRecord.data[i];
        const tr = document.createElement('tr');
        const tdIds = document.createElement('td');
        const tdSrc = document.createElement('td');
        const tdAct = document.createElement('td');

        const inIds = document.createElement('input');
        inIds.className = 'text';
        inIds.value = d.ids ?? '';
        inIds.addEventListener('input', () => {
          activeRecord.data[i].ids = inIds.value;
          scheduleUpdate();
          rerenderErrorsOnly();
        });

        const inSrc = document.createElement('input');
        inSrc.className = 'text';
        inSrc.value = d.source ?? '';
        inSrc.addEventListener('input', () => {
          activeRecord.data[i].source = inSrc.value;
          scheduleUpdate();
          rerenderErrorsOnly();
        });

        const btnDel = document.createElement('button');
        btnDel.className = 'danger';
        btnDel.textContent = 'Del';
        btnDel.addEventListener('click', () => {
          activeRecord.data.splice(i, 1);
          scheduleUpdate();
          renderEditor();
          rerenderErrorsOnly();
        });

        tdIds.appendChild(inIds);
        tdSrc.appendChild(inSrc);
        tdAct.appendChild(btnDel);
        tr.appendChild(tdIds);
        tr.appendChild(tdSrc);
        tr.appendChild(tdAct);

        const errRow = document.createElement('div');
        errRow.className = 'errtext';
        errRow.style.display = 'none';

        // Keep a pointer for error updates
        inIds.dataset.errKey = 'data['+i+'].ids';
        inSrc.dataset.errKey = 'data['+i+'].source';
        tr.dataset.rowIndex = String(i);
        tr._inIds = inIds;
        tr._inSrc = inSrc;
        tr._errRow = errRow;

        elDataRows.appendChild(tr);
      }

      elComment.value = activeRecord.comment ?? '';
      elComment.oninput = () => {
        // IDS.TXT is line-based; normalize newlines to spaces for the comment field.
        const normalized = elComment.value.replace(/[\\r\\n]+/g, ' ');
        if(normalized !== elComment.value){
          const start = elComment.selectionStart ?? normalized.length;
          const end = elComment.selectionEnd ?? normalized.length;
          elComment.value = normalized;
          elComment.setSelectionRange(start, end);
        }
        activeRecord.comment = elComment.value;
        scheduleUpdate();
        rerenderErrorsOnly();
      };

      elAddRow.onclick = () => {
        activeRecord.data.push({ids:'', source:''});
        scheduleUpdate();
        renderEditor();
        rerenderErrorsOnly();
      };
      elClearRows.onclick = () => {
        activeRecord.data = [];
        scheduleUpdate();
        renderEditor();
        rerenderErrorsOnly();
      };

      rerenderErrorsOnly();
    }

    function rerenderErrorsOnly(){
      if(activeIndex == null || !activeRecord) return;
      activeErrors = validateRecord(activeRecord);
      const errMap = new Map();
      for(const e of activeErrors) errMap.set(e.path, e.message);
      for(const e of (activeServerErrors ?? [])) errMap.set(e.path, e.message);

      const codeMsg = errMap.get('codepoint');
      elCodepoint.classList.toggle('error', !!codeMsg);
      elCodepoint.title = codeMsg || '';

      const charMsg = errMap.get('char');
      elCharBox.classList.toggle('error', !!charMsg);
      elCharBox.title = charMsg || '';

      // data rows
      for(const tr of elDataRows.querySelectorAll('tr')){
        const i = Number(tr.dataset.rowIndex);
        const inIds = tr._inIds;
        const inSrc = tr._inSrc;
        const msgIds = errMap.get('data['+i+'].ids');
        const msgSrc = errMap.get('data['+i+'].source');
        inIds.classList.toggle('error', !!msgIds);
        inSrc.classList.toggle('error', !!msgSrc);
        const anyMsg = msgIds || msgSrc;
        // Show inline hint via title
        inIds.title = msgIds || '';
        inSrc.title = msgSrc || '';
        tr.style.background = anyMsg ? 'rgba(255,107,107,.06)' : '';
      }

      const cmsg = errMap.get('comment');
      elComment.classList.toggle('error', !!cmsg);
      elCommentErr.style.display = cmsg ? '' : 'none';
      elCommentErr.textContent = cmsg || '';

      updateStatusFromErrors();

      // reflect in list summary
      if(activeIndex != null){
        const issueCount = errMap.size;
        const comment = String(activeRecord.comment ?? '').trim();
        const isEmpty = (activeRecord.data?.length ?? 0) === 0 && comment === '';
        const s = summaries[activeIndex];
        if(s){
          s.issueCount = issueCount;
          s.hasError = issueCount > 0;
          s.isEmpty = isEmpty;
          renderVisibleRows();
        }
      }
    }

    function scheduleUpdate(){
      if(activeIndex == null || !activeRecord) return;
      if(updateTimer) clearTimeout(updateTimer);
      updateTimer = setTimeout(async () => {
        updateTimer = null;
        // Do not send invalid records.
        const issues = validateRecord(activeRecord);
        if(issues.length) return;
        try{
          await apiPost('/api/record/' + activeIndex, {record: activeRecord});
          activeServerErrors = [];
          serverDirty = true;
          updateStatusFromErrors();
        } catch(e){
          const srvIssues = e?.data?.issues;
          if(Array.isArray(srvIssues)){
            const ing = ingestServerIssues(srvIssues);
            const list = ing.byIndex.get(activeIndex) ?? [];
            activeServerErrors = list;
            rerenderErrorsOnly();
            setStatus('warn', 'Validation failed (highlighted).');
          } else {
            setStatus('warn', String(e?.message ?? e));
          }
        }
      }, 250);
    }

    elSaveBtn.addEventListener('click', async () => {
      if(activeRecord && validateRecord(activeRecord).length){
        setStatus('warn', 'Fix errors before saving.');
        return;
      }
      try{
        const res = await apiPost('/api/save', {});
        lastSavedAtMs = res.lastSavedAtMs ?? lastSavedAtMs;
        updateStatusFromErrors();
      } catch(e){
        console.error(e);
        const srvIssues = e?.data?.issues;
        if(Array.isArray(srvIssues)){
          const ing = ingestServerIssues(srvIssues);
          for(const [idx, list] of ing.byIndex.entries()){
            pendingServerIssues.set(idx, list);
          }
          if(ing.firstIndex != null){
            await openRecord(ing.firstIndex);
          }
          setStatus('warn', 'Validation failed (highlighted).');
        } else {
          setStatus('warn', String(e?.message ?? e));
        }
      }
    });

    elAutoSave.addEventListener('change', async () => {
      localStorage.setItem(autosaveKey, elAutoSave.checked ? 'true' : 'false');
      try{
        await apiPost('/api/autosave', {enabled: elAutoSave.checked});
      } catch(e){
        setStatus('warn', String(e?.message ?? e));
      }
    });

    elFilter.addEventListener('input', () => applyFilter());
    elList.addEventListener('scroll', () => renderVisibleRows());
    elOpenZi.addEventListener('click', () => openZiForActive());
    elCloseZi.addEventListener('click', () => closeZi());

    elSplitV.addEventListener('pointerdown', (ev) => {
      if(ev.button !== 0) return;
      const startX = ev.clientX;
      const startW = elSidebar.getBoundingClientRect().width;
      startDrag('v', ev);
      const onMove = (e) => {
        if(dragging !== 'v') return;
        const next = applySidebarWidthPx(startW + (e.clientX - startX));
        localStorage.setItem(sidebarWidthKey, String(next));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        endDrag();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
    elSplitV.addEventListener('dblclick', () => {
      localStorage.removeItem(sidebarWidthKey);
      document.documentElement.style.removeProperty('--sidebar-w');
    });

    elSplitZiV.addEventListener('pointerdown', (ev) => {
      if(ev.button !== 0) return;
      if(elZiPanel.style.display === 'none') return;
      const startX = ev.clientX;
      const startW = elZiPanel.getBoundingClientRect().width;
      startDrag('zi', ev);
      const onMove = (e) => {
        if(dragging !== 'zi') return;
        const next = applyZiWidthPx(startW - (e.clientX - startX));
        localStorage.setItem(ziWidthKey, String(next));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        endDrag();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
    elSplitZiV.addEventListener('dblclick', () => {
      localStorage.removeItem(ziWidthKey);
      document.documentElement.style.removeProperty('--zi-w');
    });
    elList.addEventListener('keydown', (ev) => {
      const key = ev.key;
      if(filtered.length === 0) return;

      const page = Math.max(1, Math.floor(elList.clientHeight / ROW_H) - 1);
      let nextPos = activePos;
      if(nextPos == null){
        nextPos = 0;
      }

      if(key === 'ArrowDown') nextPos += 1;
      else if(key === 'ArrowUp') nextPos -= 1;
      else if(key === 'PageDown') nextPos += page;
      else if(key === 'PageUp') nextPos -= page;
      else if(key === 'Home') nextPos = 0;
      else if(key === 'End') nextPos = filtered.length - 1;
      else if(key === 'Enter' && activeIndex != null) {
        // Already open; just keep it.
        ev.preventDefault();
        return;
      } else {
        return;
      }

      ev.preventDefault();
      nextPos = Math.max(0, Math.min(filtered.length - 1, nextPos));
      activePos = nextPos;
      ensurePosVisible(nextPos);
      const idx = filtered[nextPos];
      if(idx != null) openRecord(idx);
    });

    async function pollMeta(){
      try{
        const m = await apiGet('/api/meta');
        meta = m;
        serverDirty = !!m.dirty;
        if(m.lastSavedAtMs != null) lastSavedAtMs = m.lastSavedAtMs;
        elMeta.textContent = m.filePath;
        elWarn.textContent = m.warnings && m.warnings.length ? ('warnings: ' + m.warnings.length) : '';
        updateStatusFromErrors();
      } catch {
        // ignore
      }
    }

    async function init(){
      try{
        await apiPost('/api/autosave', {enabled: elAutoSave.checked});
      } catch {}

      const data = await apiGet('/api/records');
      summaries = data.records || [];
      filtered = summaries.map((_,i)=>i);
      posByIndex = new Map();
      for(let pos=0; pos<filtered.length; pos++){
        posByIndex.set(filtered[pos], pos);
      }
      elCount.textContent = \`\${filtered.length} / \${summaries.length}\`;
      refreshList(true);
      setStatus('neutral', 'Select a record to edit.');
      elOpenZi.disabled = true;
      closeZi();

      const w = parseInt(localStorage.getItem(sidebarWidthKey) ?? '', 10);
      if(Number.isFinite(w)) applySidebarWidthPx(w);
      const zw = parseInt(localStorage.getItem(ziWidthKey) ?? '', 10);
      if(Number.isFinite(zw)) applyZiWidthPx(zw);

      await pollMeta();
      if(metaPollTimer) clearInterval(metaPollTimer);
      metaPollTimer = setInterval(pollMeta, 1200);
    }

    init().catch(e => {
      console.error(e);
      elMeta.textContent = 'failed to load';
      setStatus('warn', String(e?.message ?? e));
    });
  </script>
</body>
</html>`;
}
