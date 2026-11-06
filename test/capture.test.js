'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const capture = require('../src/capture.js');

const NOW = Date.now();

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuotiben-test-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

function dshTranscript({ kind = 'user', depth = 0, writes = 1 } = {}) {
  const session = {
    type: 'session',
    version: 4,
    id: 'session-test',
    cwd: 'C:\\work\\demo',
    isSeeded: false,
    delegationDepth: depth,
  };
  const lines = [
    session,
    { type: 'session/title', seq: 1, data: { title: '测试会话' } },
    { type: 'request/context', seq: 2, data: { model: 'deepseek-flash' } },
    { type: 'turn/start', seq: 3, time: NOW, data: { turn: 1 } },
    { type: 'step/start', seq: 4, time: NOW, data: { turn: 1, step: 1 } },
  ];
  lines.push({
    type: 'user/message',
    seq: 5,
    time: NOW,
    data: {
      content: [{ type: 'text', text: '帮我把主页的按钮颜色改成蓝色，再跑一下测试' }],
      source: { kind },
      role: 'user',
    },
  });
  lines.push({
    type: 'tool/call',
    seq: 6,
    time: NOW,
    data: { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: 'C:\\work\\demo\\index.html' }) },
  });
  if (writes > 1) {
    lines.push({
      type: 'tool/call',
      seq: 7,
      time: NOW,
      data: { turn: 1, step: 1, callId: 'c2', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test' }) },
    });
  }
  lines.push({ type: 'step/start', seq: 8, time: NOW, data: { turn: 1, step: 2 } });
  lines.push({ type: 'turn/end', seq: 9, time: NOW + 5000, data: { turn: 1 } });
  return lines.map((line) => JSON.stringify(line)).join('\n');
}

test('zstd concatenated frames are read as one transcript', () => {
  if (typeof zlib.zstdCompressSync !== 'function') return;
  const first = JSON.stringify({ type: 'session', id: 's1', cwd: 'C:\\demo' });
  const second = JSON.stringify({ type: 'turn/start', time: NOW, data: { turn: 1 } });
  const frame1 = zlib.zstdCompressSync(Buffer.from(`${first}\n`));
  const frame2 = zlib.zstdCompressSync(Buffer.from(`${second}\n`));
  const file = tmpFile('session.v4.jsonl.zstd', Buffer.concat([frame1, frame2]));
  const text = capture.readTranscript(file);
  assert.ok(text.includes('"type":"session"'));
  assert.ok(text.includes('"type":"turn/start"'));
});

test('frameLength returns the exact frame size', () => {
  if (typeof zlib.zstdCompressSync !== 'function') return;
  const frame = zlib.zstdCompressSync(Buffer.from('hello world'));
  const len = capture.frameLength(frame, 0);
  assert.equal(len, frame.length);
  assert.equal(capture.frameLength(Buffer.from('not zstd'), 0), -1);
});

test('parseDsh builds a work turn from a real-shaped transcript', () => {
  const file = tmpFile('session.v4.jsonl', dshTranscript({ writes: 2 }));
  const { turns, session } = capture.parseDsh(fs.readFileSync(file, 'utf8'), file);
  assert.equal(session.cwd, 'C:\\work\\demo');
  assert.equal(turns.length, 1);
  const turn = turns[0];
  assert.match(turn.userText, /按钮颜色/);
  assert.equal(turn.writes, 1);
  assert.deepEqual(turn.files, ['C:\\work\\demo\\index.html']);
  assert.deepEqual(turn.commands, ['npm test']);
  assert.equal(turn.source, 'dsh');
  assert.equal(turn.cwd, 'C:\\work\\demo');
});

test('parseDsh ignores injected user messages and subagent sessions', () => {
  const injected = tmpFile('session.v4.jsonl', dshTranscript({ kind: 'time-context' }));
  const injectedParsed = capture.parseDsh(fs.readFileSync(injected, 'utf8'), injected);
  // only the injected message exists -> no turn with a human ask
  assert.equal(injectedParsed.turns.length, 0);

  const subagent = tmpFile('session.v4.jsonl', dshTranscript({ depth: 1 }));
  const subParsed = capture.parseDsh(fs.readFileSync(subagent, 'utf8'), subagent);
  assert.equal(subParsed.turns.length, 0);
});

test('parseCodex understands rollout shape and exec tool calls', () => {
  const lines = [
    { timestamp: new Date(NOW).toISOString(), type: 'session_meta', payload: { session_id: 'codex-1', cwd: 'E:\\project\\demo' } },
    { timestamp: new Date(NOW).toISOString(), type: 'turn_context', payload: { cwd: 'E:\\project\\demo' } },
    { timestamp: new Date(NOW).toISOString(), type: 'event_msg', payload: { type: 'task_started' } },
    {
      timestamp: new Date(NOW).toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '把桌面工具目录里的项目部署一下' }] },
    },
    {
      timestamp: new Date(NOW).toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context><cwd>x</cwd></environment_context>' }] },
    },
    {
      timestamp: new Date(NOW).toISOString(),
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        input: 'text(await tools.exec_command({cmd:"npm run build", workdir:"E:\\\\project\\\\demo"}));',
        call_id: 'call_1',
      },
    },
    { timestamp: new Date(NOW).toISOString(), type: 'event_msg', payload: { type: 'task_complete' } },
  ];
  const file = tmpFile('rollout-test.jsonl', lines.map((line) => JSON.stringify(line)).join('\n'));
  const parsed = capture.parseCodex(fs.readFileSync(file, 'utf8'), file);
  assert.equal(parsed.turns.length, 1);
  const turn = parsed.turns[0];
  assert.match(turn.userText, /部署/);
  assert.equal(turn.commands[0], 'npm run build');
  assert.equal(turn.source, 'codex');
  assert.equal(turn.cwd, 'E:\\project\\demo');
});

test('parseClaude understands user/assistant with tool_use', () => {
  const lines = [
    { type: 'user', timestamp: new Date(NOW).toISOString(), sessionId: 'claude-1', cwd: '/work/demo', message: { role: 'user', content: '帮我分析这个 Excel 表格' } },
    {
      type: 'assistant',
      timestamp: new Date(NOW).toISOString(),
      sessionId: 'claude-1',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'Write', input: { file_path: '/work/demo/analyze.py', content: 'import pandas' } }],
      },
    },
    {
      type: 'user',
      timestamp: new Date(NOW).toISOString(),
      sessionId: 'claude-1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
    },
  ];
  const file = tmpFile('claude.jsonl', lines.map((line) => JSON.stringify(line)).join('\n'));
  const parsed = capture.parseClaude(fs.readFileSync(file, 'utf8'), file);
  assert.equal(parsed.turns.length, 1);
  assert.match(parsed.turns[0].userText, /Excel/);
  assert.equal(parsed.turns[0].writes, 1);
});
