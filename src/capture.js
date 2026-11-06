'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const U = require('./util.js');

const ZSTD_MAGIC = 0xfd2fb528;
const MAX_FILE_BYTES = 320 * 1024 * 1024;

const WRITE_TOOLS = new Set([
  'write', 'edit', 'notebookedit', 'notebook_edit', 'applypatch', 'apply_patch', 'writefile', 'write_file',
  'createfile', 'create_file', 'str_replace_editor', 'write_to_file', 'edit_file', 'replace', 'multiedit', 'multi_edit',
]);
const RUN_TOOLS = new Set([
  'pwsh', 'bash', 'shell', 'shell_command', 'execcommand', 'exec_command', 'runterminalcmd', 'run_terminal_cmd',
  'terminal', 'powershell', 'cmd', 'local_shell', 'locate_shell', 'exec',
]);
const READ_TOOLS = new Set(['read', 'view', 'readfile', 'read_file', 'glob', 'grep', 'searchfiles', 'search_files', 'listdir', 'list_dir']);
const WEB_TOOLS = new Set(['websearch', 'web_search', 'webfetch', 'web_fetch', 'search', 'fetch']);
const DELEGATE_TOOLS = new Set(['subagent', 'subagent_fork', 'spawn_agent', 'spawnagent', 'spawn_teammate', 'task', 'delegate', 'send_message']);

const INJECTED_PREFIXES = [
  'current runtime context',
  'time sampled while preparing turn',
  'the approval policy changed',
  'current dsh file policy',
  'the following is the codex agent history',
  '<environment_context>',
  '<user_instructions>',
  '<recommended_plugins>',
  '<app-context>',
  '<multi_agent',
  '<skills',
  '<system',
  '<permissions',
  '<turn_aborted',
  '<subagent',
  '<collaboration',
  '<world_state',
];

function assertZstd() {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error(
      `当前 Node ${process.version} 不支持内置 zstd 解压。请升级到 Node >= 22.15（DSH / Codex 的会话记录是 zstd 压缩的）`,
    );
  }
}

/**
 * Zstd frame format (RFC 8878): magic, frame header, blocks, optional checksum.
 * DSH appends one frame per flush, so a transcript file is a concatenation of
 * frames. Node's zstdDecompressSync only handles the first frame, hence this
 * walker. Codex rollouts are usually a single (much larger) frame.
 */
function frameLength(buf, offset) {
  if (offset + 4 > buf.length || buf.readUInt32LE(offset) !== ZSTD_MAGIC) return -1;
  let p = offset + 4;
  if (p >= buf.length) return -1;
  const descriptor = buf[p];
  p += 1;
  const fcsFlag = (descriptor >> 6) & 3;
  const singleSegment = (descriptor >> 5) & 1;
  const checksum = (descriptor >> 2) & 1;
  const dictFlag = descriptor & 3;
  if (!singleSegment) p += 1;
  p += [0, 1, 2, 4][dictFlag];
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  p += fcsSize;
  if (p + 3 > buf.length) return -1;
  for (;;) {
    if (p + 3 > buf.length) return -1;
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >> 3;
    if (type === 0) p += size;
    else if (type === 1) p += 1;
    else if (type === 2) p += size;
    else return -1;
    if (last) break;
    if (p > buf.length) return -1;
  }
  if (checksum) p += 4;
  return p - offset;
}

function readTranscript(file) {
  const buf = fs.readFileSync(file);
  if (buf.length === 0) return '';
  if (buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC) {
    assertZstd();
    const parts = [];
    let off = 0;
    while (off + 4 <= buf.length && buf.readUInt32LE(off) === ZSTD_MAGIC) {
      const len = frameLength(buf, off);
      if (len <= 0 || off + len > buf.length) break;
      parts.push(zlib.zstdDecompressSync(buf.subarray(off, off + len)).toString('utf8'));
      off += len;
    }
    if (off !== buf.length) {
      throw new Error(`zstd 帧解析不完整：${path.basename(file)}（已读 ${off}/${buf.length} 字节）`);
    }
    return parts.join('');
  }
  return buf.toString('utf8');
}

function isInjected(text, options = {}) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return true;
  if (INJECTED_PREFIXES.some((prefix) => t.startsWith(prefix))) return true;
  if (options.tagged && /^<[a-z][a-z0-9_-]*(\s[^>]*)?>/.test(t)) return true;
  return false;
}

function messageText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item) return '';
        if (item.type === 'text' || item.type === 'input_text' || item.type === 'output_text') return item.text || '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function hasToolResult(content) {
  return Array.isArray(content) && content.some((item) => item && item.type === 'tool_result');
}

function parseJsonish(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : { value };
  } catch {
    return { raw };
  }
}

function normalizeToolName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function toolTarget(raw) {
  const args = parseJsonish(raw);
  const value =
    args.file_path ??
    args.filePath ??
    args.path ??
    args.file ??
    args.notebook_path ??
    args.pattern ??
    args.query ??
    args.url ??
    args.command ??
    args.cmd ??
    args.description ??
    args.prompt ??
    args.goal ??
    args.patch ??
    '';
  let text = Array.isArray(value) ? value.join(' ') : String(value || '');
  if (!text && typeof raw === 'string') text = raw;
  // Codex `exec` passes a JS snippet: text(await tools.exec_command({cmd:"...", ...}))
  const cmdMatch = /(?:cmd|command)\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (cmdMatch) {
    try {
      text = JSON.parse(`"${cmdMatch[1]}"`);
    } catch {
      text = cmdMatch[1];
    }
  }
  return U.shorten(text, 160);
}

function filesFromPatch(patch) {
  const out = [];
  const re = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
  let match;
  while ((match = re.exec(String(patch || ''))) !== null) out.push(match[1].trim());
  return out;
}

function summarizeTools(tools) {
  const files = new Set();
  const commands = new Set();
  let writes = 0;
  let reads = 0;
  let web = 0;
  let delegates = 0;
  let errors = 0;
  const toolNames = new Map();
  for (const tool of tools) {
    const rawName = String(tool.name || 'unknown');
    const name = normalizeToolName(rawName);
    toolNames.set(rawName, (toolNames.get(rawName) || 0) + 1);
    const target = U.redact(tool.target || toolTarget(tool.args));
    if (WRITE_TOOLS.has(name)) {
      writes += 1;
      if (target) files.add(target);
      const patch = parseJsonish(tool.args).patch;
      if (patch) for (const file of filesFromPatch(patch)) files.add(file);
    } else if (RUN_TOOLS.has(name)) {
      if (target) {
        commands.add(target);
        const rawArgs = typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args || '');
        if (/apply_patch/.test(rawArgs) || /apply_patch/.test(target)) {
          writes += 1;
          for (const file of filesFromPatch(rawArgs)) files.add(file);
          for (const file of filesFromPatch(target)) files.add(file);
        } else if (/(Set-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item)\b/i.test(target)) {
          writes += 1;
        }
      }
    } else if (READ_TOOLS.has(name)) {
      reads += 1;
    } else if (WEB_TOOLS.has(name)) {
      web += 1;
    } else if (DELEGATE_TOOLS.has(name)) {
      delegates += 1;
    }
    if (tool.isError) errors += 1;
  }
  return {
    files: [...files],
    commands: [...commands],
    writes,
    reads,
    web,
    delegates,
    errors,
    toolCount: tools.length,
    toolNames: [...toolNames.entries()].map(([name, count]) => ({ name, count })),
  };
}

function pickUserText(texts) {
  const merged = texts
    .map((t) => String(t || '').trim())
    .filter((t) => t && !isInjected(t))
    .join('\n\n')
    .trim();
  return U.shorten(merged, 600);
}

function buildTurn(meta) {
  const userText = pickUserText(meta.userTexts || []);
  // A turn without a genuine human ask is harness noise (reminders, job
  // notifications, approvals). Skip it instead of turning it into a card.
  if (!userText) return null;
  const tools = (meta.tools || []).map((tool) => ({ ...tool, target: tool.target || toolTarget(tool.args) }));
  const summary = summarizeTools(tools);
  const startMs = U.toMs(meta.startedAt);
  const endMs = U.toMs(meta.endedAt) || startMs;
  return {
    id: U.shortId('turn', meta.source, meta.sessionId, meta.turnIndex),
    source: meta.source,
    sessionId: meta.sessionId,
    turnIndex: meta.turnIndex,
    cwd: meta.cwd || '',
    file: meta.file || '',
    title: U.redact(meta.title || ''),
    model: meta.model || '',
    startedAt: startMs ? U.iso(startMs) : '',
    endedAt: endMs ? U.iso(endMs) : '',
    durationMs: Math.max(0, endMs - startMs),
    userText: U.redact(userText),
    steps: meta.steps || 0,
    tools: summary.toolNames,
    files: summary.files.slice(0, 80),
    commands: summary.commands.slice(0, 40),
    writes: summary.writes,
    reads: summary.reads,
    web: summary.web,
    delegates: summary.delegates,
    errors: summary.errors,
    toolCount: summary.toolCount,
    delegationDepth: meta.delegationDepth || 0,
  };
}

function parseDsh(text, file) {
  const turns = [];
  let session = null;
  let current = null;
  let title = '';
  let model = '';

  const ensureCurrent = (time) => {
    if (!current) {
      current = {
        turnIndex: turns.length + 1,
        startedAt: time,
        userTexts: [],
        tools: [],
        steps: 0,
      };
    }
    return current;
  };

  const finish = (time) => {
    if (!current) return;
    const turn = buildTurn({
      source: 'dsh',
      sessionId: session ? session.id : path.basename(file),
      cwd: session ? session.cwd : '',
      turnIndex: current.turnIndex,
      startedAt: current.startedAt,
      endedAt: time || current.endedAt || current.startedAt,
      userTexts: current.userTexts,
      tools: current.tools,
      steps: current.steps,
      title,
      model,
      file,
      delegationDepth: session ? session.depth : 0,
    });
    if (turn) turns.push(turn);
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    const data = evt.data || {};
    switch (evt.type) {
      case 'session':
        session = {
          id: evt.id || data.id || path.basename(file),
          cwd: evt.cwd || data.cwd || '',
          depth: Number(evt.delegationDepth ?? data.delegationDepth ?? 0),
          seeded: Boolean(evt.isSeeded ?? data.isSeeded),
          origin: evt.origin || data.origin || '',
          createdAt: evt.createdAt || data.createdAt,
        };
        break;
      case 'session/title':
        if (!title) title = data.title || '';
        break;
      case 'request/context':
        model = data.model || model;
        break;
      case 'turn/start':
        finish(current && current.endedAt);
        current = {
          turnIndex: Number(data.turn) || turns.length + 1,
          startedAt: evt.time,
          userTexts: [],
          tools: [],
          steps: 0,
        };
        break;
      case 'step/start':
        ensureCurrent(evt.time).steps += 1;
        break;
      case 'user/message': {
        const kind = (data.source && data.source.kind) || '';
        // Only genuine human turns count as "the user asking AI to do work".
        // Runtime context, skill catalogs, reminders, job notifications and
        // subagent settlements are all injected as user/messages by the harness.
        if (kind && kind !== 'user') break;
        const value = messageText(data.content);
        if (value && !isInjected(value)) ensureCurrent(evt.time).userTexts.push(value);
        break;
      }
      case 'tool/call': {
        const turn = ensureCurrent(evt.time);
        turn.tools.push({ name: data.name, args: data.arguments, callId: data.callId, isError: false });
        break;
      }
      case 'tool/result': {
        const turn = current;
        if (turn && data.message && data.message.isError) {
          const callId = data.toolCallId || (data.message.source && data.message.source.callId);
          const call = turn.tools.find((tool) => tool.callId === callId) || turn.tools[turn.tools.length - 1];
          if (call) call.isError = true;
        }
        break;
      }
      case 'turn/end':
        finish(evt.time);
        break;
      default:
        break;
    }
  }
  finish();
  const meta = session || { depth: 0, seeded: false };
  const usable = meta.seeded || meta.depth > 0 || meta.origin === 'subagent' ? [] : turns;
  return { turns: usable, session: meta };
}

function parseCodex(text, file) {
  const turns = [];
  let meta = null;
  let current = null;
  let turnIndex = 0;

  const ensure = (time) => {
    if (!current) {
      turnIndex += 1;
      current = { turnIndex, startedAt: time, userTexts: [], tools: [], steps: 0, cwd: meta ? meta.cwd : '' };
    }
    return current;
  };
  const finish = (time) => {
    if (!current) return;
    const turn = buildTurn({
      source: 'codex',
      sessionId: meta ? meta.session_id || meta.id : path.basename(file),
      cwd: current.cwd || (meta && meta.cwd) || '',
      turnIndex: current.turnIndex,
      startedAt: current.startedAt,
      endedAt: time || current.endedAt,
      userTexts: current.userTexts,
      tools: current.tools,
      steps: current.steps,
      file,
    });
    if (turn) turns.push(turn);
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = row.payload || {};
    if (row.type === 'session_meta') {
      meta = payload;
    } else if (row.type === 'turn_context') {
      ensure(row.timestamp).cwd = payload.cwd || current.cwd;
      if (current) current.endedAt = row.timestamp;
    } else if (row.type === 'event_msg') {
      if (payload.type === 'task_started') {
        finish(row.timestamp);
        ensure(row.timestamp);
        current.endedAt = row.timestamp;
      } else if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
        if (current) current.endedAt = row.timestamp;
        finish(row.timestamp);
      }
    } else if (row.type === 'response_item') {
      ensure(row.timestamp);
      current.endedAt = row.timestamp;
      if (payload.type === 'message' && payload.role === 'user') {
        const value = messageText(payload.content);
        if (value && !isInjected(value, { tagged: true })) current.userTexts.push(value);
      } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call' || payload.type === 'tool_call') {
        current.tools.push({
          name: payload.name || payload.tool_name,
          args: payload.arguments || payload.input || '',
          callId: payload.call_id || payload.id,
          isError: false,
        });
        current.steps += 1;
      } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output' || payload.type === 'tool_output') {
        const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output || '');
        if (/\b(error|failed|denied|exit code: [1-9])/i.test(output.slice(0, 400))) {
          const callId = payload.call_id;
          const call = current.tools.find((tool) => tool.callId === callId) || current.tools[current.tools.length - 1];
          if (call) call.isError = true;
        }
      }
    }
  }
  finish();
  return { turns, session: meta || {} };
}

function parseClaude(text, file) {
  const turns = [];
  let sessionId = '';
  let cwd = '';
  let current = null;
  let turnIndex = 0;

  const finish = (time) => {
    if (!current) return;
    const turn = buildTurn({
      source: 'claude',
      sessionId: sessionId || path.basename(file),
      cwd: current.cwd || cwd,
      turnIndex: current.turnIndex,
      startedAt: current.startedAt,
      endedAt: time || current.endedAt,
      userTexts: current.userTexts,
      tools: current.tools,
      steps: current.steps,
      file,
    });
    if (turn) turns.push(turn);
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    sessionId = row.sessionId || sessionId;
    cwd = row.cwd || cwd;
    const time = row.timestamp;
    const content = row.message && row.message.content;
    if (row.type === 'user') {
      if (hasToolResult(content)) {
        const item = content.find((part) => part && part.type === 'tool_result');
        if (item && item.is_error && current) {
          const call = current.tools.find((tool) => tool.callId === item.tool_use_id) || current.tools[current.tools.length - 1];
          if (call) call.isError = true;
        }
        continue;
      }
      const value = messageText(content);
      if (!value || isInjected(value, { tagged: true })) continue;
      finish(time);
      turnIndex += 1;
      current = { turnIndex, startedAt: time, userTexts: [value], tools: [], steps: 0, cwd };
    } else if (row.type === 'assistant' && Array.isArray(content)) {
      if (!current) continue;
      current.endedAt = time;
      for (const item of content) {
        if (item && item.type === 'tool_use') {
          current.tools.push({ name: item.name, args: item.input, callId: item.id, isError: false });
          current.steps += 1;
        }
      }
    }
  }
  finish();
  return { turns, session: { id: sessionId, cwd } };
}

function expandHome(value) {
  if (!value) return value;
  return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
}

function dshRoots() {
  return [process.env.CUOTIBEN_DSH_DIR, path.join(os.homedir(), '.dsh', 'sessions')].filter(Boolean).map(expandHome);
}

function codexRoots() {
  return [process.env.CUOTIBEN_CODEX_DIR, path.join(os.homedir(), '.codex', 'sessions')].filter(Boolean).map(expandHome);
}

function claudeRoots() {
  return [
    process.env.CUOTIBEN_CLAUDE_DIR,
    path.join(os.homedir(), '.claude', 'projects'),
    path.join(os.homedir(), '.claude', 'sessions'),
  ]
    .filter(Boolean)
    .map(expandHome);
}

function withStat(file) {
  try {
    const stat = fs.statSync(file);
    return { path: file, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function discoverFiles(sources) {
  const files = [];
  const wanted = new Set(sources && sources.length ? sources : ['dsh', 'codex', 'claude']);
  if (wanted.has('dsh')) {
    for (const root of dshRoots()) {
      for (const file of U.listFiles(root, (f) => /session\.v4\.jsonl\.zstd$|session\.v4\.jsonl$/.test(f))) {
        const item = withStat(file);
        if (item) files.push({ ...item, source: 'dsh' });
      }
    }
  }
  if (wanted.has('codex')) {
    for (const root of codexRoots()) {
      for (const file of U.listFiles(root, (f) => /\.jsonl(\.zst)?$/.test(f) && /rollout-/.test(path.basename(f)))) {
        const item = withStat(file);
        if (item) files.push({ ...item, source: 'codex' });
      }
    }
  }
  if (wanted.has('claude')) {
    for (const root of claudeRoots()) {
      for (const file of U.listFiles(root, (f) => f.endsWith('.jsonl'))) {
        const item = withStat(file);
        if (item) files.push({ ...item, source: 'claude' });
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

const PARSERS = { dsh: parseDsh, codex: parseCodex, claude: parseClaude };

function normalizeCwd(value) {
  if (!value) return '';
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function scanSessions(options = {}) {
  const sinceMs = options.sinceMs || 0;
  const here = options.here ? normalizeCwd(options.here) : '';
  const files = discoverFiles(options.sources);
  const maxFiles = options.maxFiles || 200;
  const limitPerSource = options.limitPerSource || 200;
  const cache = options.cache || {};
  const stats = { files: 0, parsedFiles: 0, turns: 0, newTurns: 0, skipped: 0, cached: 0, errors: [], sources: {} };
  const turns = [];
  const seenSessions = new Set();
  const perSource = new Map();
  for (const file of files) {
    const count = (perSource.get(file.source) || 0) + 1;
    perSource.set(file.source, count);
    if (count > limitPerSource) {
      stats.skipped += 1;
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      stats.skipped += 1;
      stats.errors.push(`${U.homeShort(file.path)} 过大（${Math.round(file.size / 1048576)}MB），已跳过`);
      continue;
    }
    const cached = cache[file.path];
    if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
      stats.cached += 1;
      continue;
    }
    if (sinceMs && file.mtimeMs < sinceMs) {
      stats.skipped += 1;
      continue;
    }
    stats.files += 1;
    if (stats.files > maxFiles) break;
    try {
      const text = readTranscript(file.path);
      const parsed = PARSERS[file.source](text, file.path);
      stats.parsedFiles += 1;
      cache[file.path] = { size: file.size, mtimeMs: file.mtimeMs, parsedAt: Date.now(), source: file.source };
      const sourceStats = stats.sources[file.source] || { files: 0, turns: 0 };
      sourceStats.files += 1;
      for (const turn of parsed.turns) {
        if (sinceMs && U.toMs(turn.startedAt) < sinceMs) continue;
        if (here && normalizeCwd(turn.cwd) !== here) continue;
        const sessionKey = `${turn.source}:${turn.sessionId}:${turn.turnIndex}`;
        if (seenSessions.has(sessionKey)) continue;
        seenSessions.add(sessionKey);
        turns.push(turn);
        sourceStats.turns += 1;
      }
      stats.sources[file.source] = sourceStats;
    } catch (err) {
      stats.errors.push(`${U.homeShort(file.path)}: ${err.message}`);
    }
  }
  stats.turns = turns.length;
  turns.sort((a, b) => U.toMs(b.startedAt) - U.toMs(a.startedAt));
  return { turns, stats };
}

function hookEventsPath(storeDir) {
  return path.join(storeDir, 'hook-events.jsonl');
}

function appendHookEvent(storeDir, payload, extra = {}) {
  const row = {
    ts: new Date().toISOString(),
    sessionId: payload.session_id || payload.sessionId || '',
    cwd: payload.cwd || '',
    hook: payload.hook_event_name || payload.hookEventName || extra.hook || 'unknown',
    tool: payload.tool_name || payload.toolName || '',
    input: payload.tool_input || payload.toolInput || null,
    prompt: payload.prompt || '',
    source: extra.source || 'claude-hook',
  };
  U.appendJsonl(hookEventsPath(storeDir), row);
  return row;
}

function turnsFromHookEvents(storeDir) {
  const rows = U.readJsonl(hookEventsPath(storeDir));
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.sessionId || 'unknown'}:${U.localDay(new Date(row.ts))}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const turns = [];
  for (const [key, items] of groups) {
    const first = items[0];
    const prompts = items.map((item) => item.prompt).filter(Boolean);
    const tools = items.map((item) => ({
      name: item.tool,
      args: item.input ? JSON.stringify(item.input) : '',
      isError: false,
    }));
    const turn = buildTurn({
      source: 'claude-hook',
      sessionId: first.sessionId || 'hook',
      cwd: first.cwd || '',
      turnIndex: U.sha1(key).slice(0, 8),
      startedAt: first.ts,
      endedAt: items[items.length - 1].ts,
      userTexts: prompts.length ? prompts : ['（Claude Code Hook 自动记录的会话）'],
      tools,
      steps: tools.length,
      file: hookEventsPath(storeDir),
    });
    if (turn) turns.push(turn);
  }
  return turns;
}

module.exports = {
  ZSTD_MAGIC,
  frameLength,
  readTranscript,
  isInjected,
  messageText,
  toolTarget,
  normalizeToolName,
  summarizeTools,
  buildTurn,
  parseDsh,
  parseCodex,
  parseClaude,
  discoverFiles,
  scanSessions,
  appendHookEvent,
  hookEventsPath,
  turnsFromHookEvents,
  dshRoots,
  codexRoots,
  claudeRoots,
};
