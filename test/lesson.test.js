'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lesson = require('../src/lesson.js');
const storeLib = require('../src/store.js');
const analyze = require('../src/analyze.js');

const FILLER = '这一段是课程正文，用来说明原理、给出证据，并保证长度足够。'.repeat(30);

function goodLesson() {
  return `# 从一次网页改动看懂浏览器渲染

## 1. 这件事你让 AI 做了什么
${FILLER}

## 2. AI 替你做的决定
${FILLER}

## 3. 底层原理拆解
${FILLER}

## 4. 5 分钟亲手验证
打开 index.html，按 F12 改一处 CSS：

\`\`\`css
body { background: red; }
\`\`\`

预期：页面背景立刻变红，说明样式和 DOM 是两套东西。

## 5. 自测（先别翻答案）
1. 为什么改了 CSS 不用重新加载 HTML？
2. 如果打开的是手机模拟器，盒模型会怎么变？
3. AI 这次把布局写成 flex，是唯一选择吗？

答案：
答案：CSS 由渲染引擎解析，和 HTML 解析分离。
答案：viewport 变化会触发媒体查询和重排。
答案：不是，grid 也能实现，AI 替你选了更熟悉的方案。

## 6. 换场景会怎样
${FILLER}

## 7. 费曼输出
${FILLER}
`;
}

test('lint accepts a complete lesson', () => {
  const result = lesson.lint(goodLesson());
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.ok(result.score >= 70);
  assert.equal(result.issues.length, 0);
  assert.ok(result.chineseChars > 900);
});

test('lint rejects thin or incomplete lessons', () => {
  const result = lesson.lint('# 空课\n\n太短了。');
  assert.equal(result.ok, false);
  assert.ok(result.issues.length >= 3);
  assert.ok(result.issues.some((issue) => issue.includes('缺少部分')));
});

test('lint flags secrets', () => {
  const text = goodLesson().replace('## 7. 费曼输出', 'token: ghp_abcdefghijklmnopqrstuvwxyz123456\n\n## 7. 费曼输出');
  const result = lesson.lint(text);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('密钥')));
});

test('spaced repetition schedule expands intervals on good grades', () => {
  let review = lesson.schedule(null, 5);
  assert.equal(review.interval, 1);
  assert.equal(review.reps, 1);
  review = lesson.schedule(review, 5);
  assert.equal(review.interval, 3);
  review = lesson.schedule(review, 5);
  assert.ok(review.interval >= 7);
  const nextDue = new Date(review.due).getTime();
  assert.ok(nextDue > Date.now() + 6 * 86400 * 1000);
});

test('grading a card downgrades on failure and masters on success', () => {
  const store = storeLib.loadStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cuotiben-lesson-')));
  const card = analyze.distillTurn({
    id: 'turn_x',
    source: 'dsh',
    sessionId: 's',
    turnIndex: 1,
    cwd: 'C:\\demo',
    userText: '帮我改这个网页的布局',
    files: ['index.html'],
    commands: [],
    writes: 2,
    reads: 0,
    web: 0,
    delegates: 0,
    errors: 0,
    toolCount: 3,
    steps: 4,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  });
  lesson.gradeCard(card, 2);
  assert.equal(card.status, 'learning');
  let current = card;
  for (let i = 0; i < 4; i += 1) current = lesson.gradeCard(current, 5);
  assert.equal(current.status, 'mastered');
  assert.ok(current.review.interval >= 14);
});

test('saveLesson copies the lesson into the store and links the card', () => {
  const store = storeLib.loadStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cuotiben-save-')));
  const card = analyze.distillTurn({
    id: 'turn_y',
    source: 'dsh',
    sessionId: 's',
    turnIndex: 1,
    cwd: 'C:\\demo',
    userText: '用 AI 写一个静态网页',
    files: ['index.html'],
    commands: ['npm run build'],
    writes: 2,
    reads: 0,
    web: 0,
    delegates: 0,
    errors: 0,
    toolCount: 4,
    steps: 5,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  });
  const source = path.join(store.paths.root, 'draft.md');
  fs.writeFileSync(source, goodLesson(), 'utf8');
  const result = lesson.saveLesson(store, source, card);
  assert.ok(fs.existsSync(result.path));
  assert.equal(card.status, 'learning');
  assert.match(card.lesson, /^lessons\//);
  assert.ok(card.review.due);
});

test('buildBrief includes card evidence and mapped principles', () => {
  const card = analyze.distillTurn({
    id: 'turn_z',
    source: 'dsh',
    sessionId: 's',
    turnIndex: 1,
    cwd: 'C:\\demo',
    userText: '用 pandas 分析这个销售表格',
    files: ['C:\\demo\\sales.xlsx'],
    commands: ['python analyze.py'],
    writes: 1,
    reads: 1,
    web: 0,
    delegates: 0,
    errors: 1,
    toolCount: 4,
    steps: 6,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  });
  const brief = lesson.buildBrief(card);
  assert.match(brief, /课程任务单/);
  assert.match(brief, /事件档案/);
  assert.match(brief, /讲义必须包含的 7 个部分/);
  assert.match(brief, /销售表格/);
  assert.match(brief, new RegExp(card.id));
});
