'use strict';

const path = require('node:path');
const U = require('./util.js');
const analyze = require('./analyze.js');

const SECTIONS = [
  { id: 'event', label: '这件事你让 AI 做了什么', tests: [/做了什么/, /事件回顾|这件事/] },
  { id: 'decisions', label: 'AI 替你做的决定', tests: [/替你做的决定|被省略的决策|AI 替你/] },
  { id: 'principle', label: '底层原理拆解', tests: [/底层原理|原理拆解|原理是什么/] },
  { id: 'experiment', label: '5 分钟亲手验证', tests: [/亲手验证|动手验证|5\s*分钟|实验/] },
  { id: 'quiz', label: '自测', tests: [/自测|小测|检验一下/] },
  { id: 'transfer', label: '换场景迁移', tests: [/换场景|迁移|换个场景|什么时候会翻车/] },
  { id: 'feynman', label: '费曼输出', tests: [/费曼|讲给|讲给外行|用三句话/] },
];

const BANNED_PHRASES = ['总而言之', '综上所述', '不可否认', '让我们一起', '在当今', '众所周知', '值得一提的是'];

function principleBlock(item, index) {
  const lines = [];
  lines.push(`### ${index + 1}. ${item.name}（${item.layer}）`);
  lines.push('');
  lines.push(`- **一句话**：${item.oneLiner}`);
  lines.push(`- **为什么与你有关**：${item.why}`);
  lines.push(`- **AI 替你做了什么**：${item.aiDecision}`);
  lines.push(`- **底层机制**：`);
  for (const bullet of item.whitebox || []) lines.push(`  - ${bullet}`);
  lines.push(`- **常见误解**：${item.misconception}`);
  if (item.experiment) {
    lines.push(`- **可以带进讲义的动手实验**：${item.experiment.title}`);
    for (const step of item.experiment.steps || []) lines.push(`  1. ${step}`);
    lines.push(`  - 预期观察：${item.experiment.expect}`);
  }
  if (item.terms && item.terms.length) lines.push(`- **术语**：${item.terms.join('、')}`);
  if (item.quiz) {
    lines.push(`- **可改造的自测题**：${item.quiz.q}`);
    for (const opt of item.quiz.options || []) lines.push(`  - ${opt}`);
    lines.push(`  - 答案：${item.quiz.options[item.quiz.answer]}｜解析：${item.quiz.why}`);
  }
  return lines.join('\n');
}

function buildBrief(card) {
  const data = analyze.loadPrinciples();
  const layers = new Map(data.layers.map((layer) => [layer.id, layer]));
  const picked = card.principles
    .map((ref) => data.byId.get(ref.id))
    .filter(Boolean);
  const missing = card.principles.filter((ref) => !data.byId.get(ref.id)).map((ref) => ref.id);

  const lines = [];
  lines.push(`# 课程任务单 · ${card.title}`);
  lines.push('');
  lines.push('> 这是 auto-cuotiben 生成的备课单。按它写出一份 15 分钟能读完的课程讲义，');
  lines.push('> 然后运行 `cuotiben save <讲义路径> --card ' + card.id + '` 入库并安排复习。');
  lines.push('');
  lines.push('## 1. 事件档案');
  lines.push('');
  lines.push(`- 课程卡片：\`${card.id}\``);
  lines.push(`- 时间：${U.localTime(new Date(card.createdAt))}`);
  lines.push(`- 来源：${card.source}${card.cwd ? ` · 目录 ${U.homeShort(card.cwd)}` : ''}`);
  lines.push(`- 领域：${card.domainLabel}`);
  lines.push(`- 黑盒指数：**${card.blackbox}/100（${card.blackboxLevel}）**`);
  lines.push(`- 你当时说：${card.userAsk || '（无）'}`);
  lines.push('- AI 实际做了什么：');
  for (const item of card.aiDid) lines.push(`  - ${item}`);
  if (card.files && card.files.length) {
    lines.push(`- 涉及文件（最多列 10 个）：`);
    for (const file of card.files.slice(0, 10)) lines.push(`  - \`${file}\``);
  }
  if (card.commands && card.commands.length) {
    lines.push('- 运行过的命令：');
    for (const cmd of card.commands.slice(0, 6)) lines.push(`  - \`${U.shorten(cmd, 120)}\``);
  }
  lines.push(`- 建议的验收动作：${card.verifyHint}`);
  lines.push('');
  lines.push('**黑盒指数信号**：');
  for (const signal of card.signals || []) lines.push(`- ${signal}`);
  lines.push('');
  lines.push('## 2. 这节课要讲透的原理（按优先级）');
  lines.push('');
  if (missing.length) {
    lines.push(`> 注意：原理库中找不到这些 id：${missing.join(', ')}。请改用下面的条目，或在讲义中自行补写。`);
    lines.push('');
  }
  if (!picked.length) {
    lines.push('> 原理库为空或未匹配成功。请先检查 `src/data/principles.json`，再基于事件本身讲透 2-3 个原理。');
  }
  picked.forEach((item, index) => {
    const layer = layers.get(item.layer);
    lines.push(principleBlock({ ...item, layer: layer ? layer.name : item.layer }, index));
    lines.push('');
  });
  lines.push('## 3. 讲义必须包含的 7 个部分');
  lines.push('');
  lines.push('```markdown');
  lines.push('# <课程标题：从这次事件出发，别写成教科书>');
  lines.push('');
  lines.push('## 1. 这件事你让 AI 做了什么');
  lines.push('<用 3-5 句话还原现场：你要什么、AI 动了哪些文件/命令、最后产出是什么。只写事实。>');
  lines.push('');
  lines.push('## 2. AI 替你做的决定');
  lines.push('<列出 3 个关键决定：它选了哪种方案、为什么、你当时有没有意识到。>');
  lines.push('');
  lines.push('## 3. 底层原理拆解');
  lines.push('<按上面的原理逐条讲透。每个原理都要落到这次事件的具体文件/命令上，给出“为什么会这样”。>');
  lines.push('');
  lines.push('## 4. 5 分钟亲手验证');
  lines.push('<给一个用户能立刻照做的实验：确切命令/操作 + 预期现象 + 它证明了什么。>');
  lines.push('');
  lines.push('## 5. 自测（先别翻答案）');
  lines.push('<3 道题：一题概念辨析、一题换场景迁移、一题判断 AI 这次做得对不对。答案写在最后。>');
  lines.push('');
  lines.push('## 6. 换场景会怎样');
  lines.push('<这套原理在什么情况下会失效/翻车？举一个反例，说明边界条件。>');
  lines.push('');
  lines.push('## 7. 费曼输出');
  lines.push('<要求用户用自己的话，三句话讲给一个完全不懂技术的朋友听。给出一个示范。>');
  lines.push('```');
  lines.push('');
  lines.push('## 4. 写作规则（质量底线，`cuotiben lint` 会检查）');
  lines.push('');
  lines.push('- 中文写作，面向“会用 AI 但不懂原理”的读者；不要写成 Wikipedia。');
  lines.push('- 每个抽象原理都必须落到本次事件的具体文件、命令或输出上。');
  lines.push('- 必须包含一个 5 分钟内可亲手完成的验证，给出确切命令/操作和预期结果。');
  lines.push('- 必须指出至少 1 个“AI 这次替你做的决定”，以及它可能出错的地方。');
  lines.push('- 自测题 ≥ 3 道，答案与解析放在文末。');
  lines.push('- 不确定的事实标注「需核实」，禁止编造数字、版本号或链接。');
  lines.push('- 不要出现密钥、Cookie、完整路径中的用户名等隐私信息。');
  lines.push('- 禁用套话：' + BANNED_PHRASES.join('、') + '。');
  lines.push('');
  lines.push('## 5. 建议的文件名');
  lines.push('');
  lines.push('```text');
  lines.push(suggestFilename(card));
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function suggestFilename(card) {
  const day = U.localDay(new Date(card.createdAt));
  return `lessons/${day}-${card.domain}-${card.id.slice(-6)}.md`;
}

function countChinese(text) {
  const matches = String(text).match(/[\u4e00-\u9fff]/g);
  return matches ? matches.length : 0;
}

function sectionText(text, section, nextSections) {
  const start = text.search(section.tests[0]);
  if (start < 0) return '';
  let end = text.length;
  for (const next of nextSections) {
    const idx = text.indexOf(next, start + 1);
    if (idx > 0 && idx < end) end = idx;
  }
  return text.slice(start, end);
}

function lint(text) {
  const issues = [];
  const warnings = [];
  if (!text || !text.trim()) {
    return { ok: false, score: 0, issues: ['讲义为空'], warnings: [], chineseChars: 0, sections: [] };
  }
  const headingRegex = /^#{1,3}\s+.*$/gm;
  const headings = text.match(headingRegex) || [];
  const found = [];
  for (const section of SECTIONS) {
    const hit = headings.find((heading) => section.tests.some((re) => re.test(heading)));
    found.push({ ...section, found: Boolean(hit) });
    if (!hit) issues.push(`缺少部分：${section.label}`);
  }
  const chinese = countChinese(text);
  if (chinese < 900) issues.push(`正文太短：${chinese} 个汉字（建议 ≥ 900）`);
  if (chinese > 8000) warnings.push(`正文偏长：${chinese} 个汉字（建议 ≤ 6000）`);

  const hasExperiment = /```[\s\S]{20,}?```/.test(text) || /(?:^|\n)\s{4,}\S/.test(text) || /运行|执行|打开|粘贴/.test(text);
  if (!hasExperiment) issues.push('没有找到可执行的验证步骤（代码块/命令/具体操作）');
  if (!/预期|应该看到|观察|会看到|输出/.test(text)) warnings.push('验证部分缺少“预期现象”描述');

  const quizSection = sectionText(text, SECTIONS.find((s) => s.id === 'quiz'), headings.slice(-1));
  const quizMarks = (quizSection.match(/[?？]/g) || []).length;
  const answerMarks = (text.match(/(?:答案|解析)\s*[:：]/g) || []).length;
  if (quizMarks < 3 && answerMarks < 3) issues.push(`自测题偏少：${quizMarks} 个问句 / ${answerMarks} 处答案解析（建议 ≥ 3 道）`);
  if (answerMarks === 0) issues.push('没有写答案与解析');

  for (const phrase of BANNED_PHRASES) {
    if (text.includes(phrase)) warnings.push(`出现套话「${phrase}」，建议删掉`);
  }
  if (/(?:sk-|ghp_|github_pat_|api[_-]?key\s*[:=]\s*\S{10,})/i.test(text)) {
    issues.push('疑似包含密钥，请删除后重新保存');
  }

  let score = 100;
  score -= (SECTIONS.length - found.filter((item) => item.found).length) * 12;
  if (!hasExperiment) score -= 18;
  if (quizMarks < 3 && answerMarks < 3) score -= 12;
  if (answerMarks === 0) score -= 8;
  if (chinese < 900) score -= 15;
  score -= Math.min(10, warnings.filter((w) => w.includes('套话')).length * 3);
  score = U.clamp(Math.round(score), 0, 100);
  return {
    ok: issues.length === 0 && score >= 70,
    score,
    issues,
    warnings,
    chineseChars: chinese,
    sections: found,
  };
}

function saveLesson(store, file, card, options = {}) {
  const text = U.readText(file);
  const result = lint(text);
  if (!result.ok && !options.force) {
    const error = new Error(`讲义未通过验收（${result.score} 分）`);
    error.lint = result;
    throw error;
  }
  const name = `${U.localDay(new Date(card.createdAt))}-${card.domain}-${card.id.slice(-6)}.md`;
  const dest = path.join(store.paths.lessons, name);
  U.writeText(dest, text);
  card.lesson = path.relative(store.paths.root, dest).split(path.sep).join('/');
  card.status = 'learning';
  card.lessonSavedAt = new Date().toISOString();
  card.lintScore = result.score;
  card.review = schedule(card.review, 4);
  return { card, lint: result, path: dest };
}

function schedule(review, quality) {
  const current = review || { reps: 0, ease: 2.5, interval: 0, due: null };
  let { reps, ease, interval } = current;
  if (quality < 3) {
    reps = 0;
    interval = 1;
  } else {
    if (reps === 0) interval = 1;
    else if (reps === 1) interval = 3;
    else interval = Math.max(1, Math.round(interval * ease));
    reps += 1;
  }
  ease = Math.max(1.3, ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
  ease = Math.round(ease * 100) / 100;
  const due = new Date(Date.now() + interval * 86400 * 1000).toISOString();
  return {
    reps,
    ease,
    interval,
    due,
    lastGrade: quality,
    lastReviewedAt: new Date().toISOString(),
  };
}

function gradeCard(card, quality, note = '') {
  const q = U.clamp(Number(quality), 0, 5);
  card.review = schedule(card.review, q);
  card.grades = Array.isArray(card.grades) ? card.grades : [];
  card.grades.push({ quality: q, at: new Date().toISOString(), note: U.shorten(note, 200) });
  if (q < 3) card.status = 'learning';
  else if (card.review.interval >= 14 && card.review.reps >= 4) card.status = 'mastered';
  else card.status = 'reviewing';
  return card;
}

function dueCards(cards, now = Date.now()) {
  return cards
    .filter((card) => card.review && card.review.due && U.toMs(card.review.due) <= now)
    .sort((a, b) => U.toMs(a.review.due) - U.toMs(b.review.due));
}

function renderIndex(store) {
  const cards = [...store.cards].sort((a, b) => U.toMs(b.createdAt) - U.toMs(a.createdAt));
  const lines = [];
  lines.push('# AI 错题本');
  lines.push('');
  lines.push(`> 由 auto-cuotiben 自动生成于 ${U.localTime(new Date())}。共 ${cards.length} 张卡片。`);
  lines.push('');
  lines.push('| 日期 | 事件 | 领域 | 黑盒指数 | 状态 | 下次复习 | 课程 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const card of cards) {
    const lesson = card.lesson ? `[打开](${card.lesson})` : '—';
    lines.push(
      `| ${U.localDay(new Date(card.createdAt))} | ${U.shorten(card.title, 40).replace(/\|/g, '\\|')} | ${card.domainLabel} | ${card.blackbox} | ${analyze.STATUS_LABELS[card.status] || card.status} | ${card.review && card.review.due ? U.localDay(new Date(card.review.due)) : '—'} | ${lesson} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  SECTIONS,
  BANNED_PHRASES,
  buildBrief,
  suggestFilename,
  lint,
  saveLesson,
  schedule,
  gradeCard,
  dueCards,
  renderIndex,
  countChinese,
};
