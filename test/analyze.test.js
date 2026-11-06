'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const analyze = require('../src/analyze.js');

const NOW = new Date().toISOString();

function workTurn(overrides = {}) {
  return {
    id: 'turn_test01',
    source: 'dsh',
    sessionId: 'session-1',
    turnIndex: 1,
    cwd: 'C:\\work\\demo',
    userText: '帮我做个个人主页，要能展示项目，用 HTML 和 CSS 写',
    files: ['C:\\work\\demo\\index.html'],
    commands: ['npm run build'],
    writes: 3,
    reads: 2,
    web: 0,
    delegates: 0,
    errors: 0,
    toolCount: 5,
    steps: 8,
    startedAt: NOW,
    endedAt: NOW,
    ...overrides,
  };
}

test('principles library loads at least 20 entries with layers', () => {
  const data = analyze.loadPrinciples();
  assert.ok(data.principles.length >= 20);
  assert.ok(data.layers.length >= 5);
  for (const principle of data.principles) {
    assert.ok(principle.id);
    assert.ok(principle.name);
    assert.ok(principle.whitebox.length >= 2);
    assert.ok(principle.experiment.steps.length >= 2);
    assert.ok(principle.quiz.options.length >= 3);
  }
});

test('distillTurn creates a card for a work turn', () => {
  const card = analyze.distillTurn(workTurn());
  assert.ok(card);
  assert.match(card.id, /^card_[a-f0-9]{10}$/);
  assert.match(card.title, /个人主页/);
  assert.equal(card.domain, 'web');
  assert.ok(card.aiDid.length >= 1);
  assert.ok(card.principles.some((item) => item.id === 'html-css'));
  assert.ok(card.blackbox >= 40);
  assert.equal(card.status, 'new');
  assert.ok(card.review.due);
});

test('distillTurn skips chat-only turns and stop words', () => {
  assert.equal(analyze.distillTurn(workTurn({ writes: 0, commands: [], delegates: 0, toolCount: 1, steps: 1, files: [] })), null);
  assert.equal(analyze.distillTurn(workTurn({ userText: '停止' })), null);
});

test('blackbox index grows with AI autonomy and shrinks when user asks to verify', () => {
  const big = analyze.distillTurn(workTurn({ writes: 10, files: Array.from({ length: 10 }, (_, i) => `f${i}.html`), steps: 30 }));
  const small = analyze.distillTurn(workTurn({ writes: 1, files: ['a.md'], steps: 1, userText: '帮我改一行，然后解释一下原理，我要自己验证' }));
  assert.ok(big.blackbox > small.blackbox);
  assert.ok(big.blackbox >= 70);
  assert.ok(small.blackbox < 70);
});

test('domain detection distinguishes web, data and git', () => {
  assert.equal(analyze.detectDomain(workTurn()), 'web');
  assert.equal(analyze.detectDomain(workTurn({ files: ['sales.xlsx'], userText: '帮我用 pandas 分析这个表格' })), 'data');
  assert.equal(analyze.detectDomain(workTurn({ files: [], commands: ['git push origin main'], userText: '把代码提交并推送' })), 'git');
});

test('principle mapping prefers concrete evidence over prompt words', () => {
  const gitCard = analyze.distillTurn(workTurn({ files: [], commands: ['git commit -m "x"'], userText: '提交一下' }));
  assert.ok(gitCard.principles.some((item) => item.id === 'git'));
  const noGit = analyze.distillTurn(workTurn({ userText: '不要用 git，直接改文件', commands: [], writes: 2 }));
  assert.ok(!noGit.principles.some((item) => item.id === 'git'));
});
