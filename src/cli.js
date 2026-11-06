'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const U = require('./util.js');
const storeLib = require('./store.js');
const capture = require('./capture.js');
const analyze = require('./analyze.js');
const lessonLib = require('./lesson.js');
const reportLib = require('./report.js');

const VERSION = require('../package.json').version;

const HELP = `
${U.color.bold('AI 错题本 · auto-cuotiben')}  v${VERSION}
把「AI 代做的活」自动变成你真正学会的原理课。数据全程留在本地。

${U.color.bold('用法')}
  cuotiben init                      在当前目录创建 .cuotiben/ 错题本
  cuotiben scan                      扫描本机 AI 会话记录，自动生成事件卡
  cuotiben list                      看所有错题卡片
  cuotiben show <卡片ID>             看卡片详情和匹配到的原理
  cuotiben lesson <卡片ID>           生成「备课单」（给 AI 写课程用的任务单）
  cuotiben lint <讲义.md>            按质量底线检查课程讲义
  cuotiben save <讲义.md> --card ID  课程入库并安排遗忘曲线复习
  cuotiben grade <卡片ID> <0-5>      记录一次复习自评（SM-2 调度）
  cuotiben review                    今天该复习的卡片
  cuotiben stats                     统计：黑盒指数、最该补的原理
  cuotiben report [--days 7]         生成周报
  cuotiben html [--out 路径]         生成单文件错题本看板（可打印成 PDF）
  cuotiben demo [--out 路径]         用示例数据生成看板（GitHub Pages 用）
  cuotiben install-skill [--target dsh|claude|both]
                                     把 SKILL.md 装进 DSH / Claude Code
  cuotiben hook                      读取 Claude Code Hook 的 stdin JSON 并记录
  cuotiben doctor                    自检：环境、会话目录、原理库、看板

${U.color.bold('常用参数')}
  --dir <目录>       错题本存放目录（默认 .cuotiben）
  --since 30d        只扫描最近一段时间（如 7d / 24h / 2026-11-01）
  --here             只采集当前目录的工作会话
  --sources dsh,codex,claude
  --rebuild          清空后重新采集与蒸馏
  --json             机器可读输出
`;

const DEMO_CARDS = [
  {
    title: '用 AI 十分钟搭了一个能上线的个人主页',
    userAsk: '帮我做个个人主页，要好看，能展示项目，明天就要用。',
    createdAt: '2026-11-02T20:10:00+08:00',
    domain: 'web',
    blackbox: 82,
    status: 'learning',
    principles: ['网页渲染与盒模型', '部署与静态托管', '提示词即规格'],
    aiDid: ['改写 5 个文件（index.html、style.css、main.js）', '执行 3 条命令（npm create vite、npm run build）', '联网检索 2 次'],
    lesson: 'https://github.com/RazorEdge-wyh/auto-cuotiben/blob/main/examples/lessons/2026-11-02-web-demo.md',
    due: '2026-11-06T20:10:00+08:00',
    lastGrade: 3,
  },
  {
    title: '让 AI 把 3000 行 Excel 做成透视表和图表',
    userAsk: '这个销售表帮我做个月度分析，要有图，下午开会用。',
    createdAt: '2026-11-03T09:40:00+08:00',
    domain: 'data',
    blackbox: 68,
    status: 'reviewing',
    principles: ['表格与向量化计算', '提示词即规格', 'AI 产出验收'],
    aiDid: ['写出 1 个 Python 脚本（analyze.py）', '执行 2 条命令（pip install pandas、python analyze.py）'],
    lesson: null,
    due: '2026-11-07T09:40:00+08:00',
    lastGrade: 4,
  },
  {
    title: 'AI 帮我把本地仓库推到 GitHub 并开了 Pages',
    userAsk: '把这个项目传到我的 GitHub，顺便开个网页预览。',
    createdAt: '2026-11-04T15:05:00+08:00',
    domain: 'git',
    blackbox: 55,
    status: 'mastered',
    principles: ['Git 提交与远端', '部署与静态托管', '命令行与副作用'],
    aiDid: ['执行 6 条命令（git init、git push 等）', '调用 GitHub API 3 次', '中途报错 2 次后自行修复'],
    lesson: null,
    due: '2026-11-25T15:05:00+08:00',
    lastGrade: 5,
  },
  {
    title: '让 AI 修一个只在 Windows 上出现的报错',
    userAsk: '这个命令在我电脑上报错，别的同事都能跑，帮我看看。',
    createdAt: '2026-11-05T11:20:00+08:00',
    domain: 'system',
    blackbox: 74,
    status: 'new',
    principles: ['依赖与环境', '命令行与副作用', 'AI 产出验收'],
    aiDid: ['读取 4 个文件', '执行 5 条命令（pip install、where 等）'],
    lesson: null,
    due: '2026-11-06T11:20:00+08:00',
    lastGrade: null,
  },
  {
    title: 'AI 自动整理了 12 篇论文的引用格式',
    userAsk: '这些参考文献按 GB/T 7714 排一下，别弄错。',
    createdAt: '2026-11-05T21:00:00+08:00',
    domain: 'docs',
    blackbox: 41,
    status: 'learning',
    principles: ['幻觉', 'AI 产出验收', '提示词即规格'],
    aiDid: ['改写 1 个文件（references.md）', '联网检索 1 次'],
    lesson: null,
    due: '2026-11-07T21:00:00+08:00',
    lastGrade: 2,
  },
];

function print(line = '') {
  process.stdout.write(`${line}\n`);
}

function displayWidth(text) {
  const s = String(text == null ? '' : text);
  let width = 0;
  for (const char of s) {
    const code = char.codePointAt(0);
    if (code >= 0x1100 && (
      code <= 0x115f || code === 0x2329 || code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x20000 && code <= 0x3fffd)
    )) width += 2;
    else width += 1;
  }
  return width;
}

function padEnd(text, width) {
  const s = String(text == null ? '' : text);
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

function table(rows, headers) {
  const widths = headers.map((header, index) => Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index]))));
  const line = (row) => row.map((cell, index) => padEnd(cell, widths[index])).join('  ');
  print(U.color.dim(line(headers)));
  print(U.color.dim(widths.map((width) => '─'.repeat(width)).join('  ')));
  for (const row of rows) print(line(row));
}

function requireStore(dir) {
  const store = storeLib.loadStore(dir);
  if (!store.cards.length && !store.events.length) {
    print(U.color.yellow('错题本还是空的。先运行 `cuotiben scan` 采集本机 AI 会话（或 `cuotiben demo` 看示例）。'));
  }
  return store;
}

function relPath(store, file) {
  return path.relative(process.cwd(), file).split(path.sep).join('/') || file;
}

function cmdInit(args, dir) {
  const store = storeLib.loadStore(dir);
  storeLib.saveEvents(store);
  storeLib.saveCards(store);
  storeLib.saveState(store);
  print(U.color.green('✓') + ` 错题本已初始化：${U.homeShort(store.paths.root)}`);
  print('');
  print(U.color.bold('下一步'));
  print('  1. 采集本机已有的 AI 会话：');
  print('     ' + U.color.cyan('cuotiben scan --since 30d'));
  print('  2. 装进你的 AI 助手（这样它知道怎么帮你写课）：');
  print('     ' + U.color.cyan('cuotiben install-skill --target both'));
  print('  3. 或者先看示例：');
  print('     ' + U.color.cyan('cuotiben demo'));
  print('');
  print(U.color.dim(`数据目录：${U.homeShort(store.paths.root)}（events.jsonl / cards.jsonl / lessons/）`));
  print(U.color.dim('隐私：只在本机读写，不联网，不上传。'));
}

function cmdScan(args, dir) {
  const store = storeLib.loadStore(dir);
  const rebuild = U.flag(args, 'rebuild');
  if (rebuild) {
    store.events = [];
    store.cards = [];
    store.state = { version: 1, files: {} };
  }
  const sinceMs = U.parseSince(U.option(args, ['since'], '30d'));
  const here = U.flag(args, 'here') ? process.cwd() : '';
  const sourceList = String(U.option(args, ['sources'], (store.config.sources || ['dsh', 'codex', 'claude']).join(',')))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  print(U.color.dim(`扫描会话记录：${sourceList.join('、')} · ${here ? '仅当前目录' : '全部目录'} · 最近 ${U.option(args, ['since'], '30d')}`));
  const { turns, stats } = capture.scanSessions({
    sinceMs,
    here,
    sources: sourceList,
    cache: store.state.files || {},
    limitPerSource: Number(U.option(args, ['limit'], 200)),
    maxFiles: Number(U.option(args, ['max-files'], 400)),
  });
  const hookTurns = capture.turnsFromHookEvents(store.paths.root);
  const allTurns = [...turns, ...hookTurns];
  const eventMap = new Map(store.events.map((event) => [event.id, event]));
  let newEvents = 0;
  for (const turn of allTurns) {
    if (!eventMap.has(turn.id)) {
      eventMap.set(turn.id, turn);
      newEvents += 1;
    }
  }
  store.events = [...eventMap.values()].sort((a, b) => U.toMs(b.startedAt) - U.toMs(a.startedAt));
  const cardMap = new Map(store.cards.map((card) => [card.id, card]));
  let newCards = 0;
  const created = [];
  for (const event of store.events) {
    const card = analyze.distillTurn(event);
    if (!card || cardMap.has(card.id)) continue;
    cardMap.set(card.id, card);
    created.push(card);
    newCards += 1;
  }
  store.cards = [...cardMap.values()].sort((a, b) => U.toMs(b.createdAt) - U.toMs(a.createdAt));
  const dryRun = U.flag(args, 'dry-run');
  if (!dryRun) {
    storeLib.saveEvents(store);
    storeLib.saveCards(store);
    storeLib.saveState(store);
  }
  if (U.flag(args, 'json')) {
    print(JSON.stringify({ newEvents, newCards, totalEvents: store.events.length, totalCards: store.cards.length, stats, created: created.map(analyze.cardSummary) }, null, 2));
    return;
  }
  print('');
  for (const [source, value] of Object.entries(stats.sources)) {
    print(`  ${source.padEnd(8)} 文件 ${String(value.files).padStart(3)} · 有效回合 ${value.turns}`);
  }
  print('');
  print(`${U.color.green('✓')} 新增事件 ${U.color.bold(String(newEvents))} 个，新增错题卡片 ${U.color.bold(String(newCards))} 张（共 ${store.cards.length} 张）${dryRun ? U.color.yellow(' [dry-run]') : ''}`);
  if (stats.errors.length) {
    print('');
    print(U.color.yellow('跳过 / 错误：'));
    for (const error of stats.errors.slice(0, 8)) print(`  - ${error}`);
  }
  if (created.length) {
    print('');
    print(U.color.bold('这次新记下的「AI 代做」：'));
    for (const card of created.slice(0, 6)) {
      print(`  ${U.color.magenta(card.id.slice(-8))}  [黑盒 ${String(card.blackbox).padStart(3)}]  ${U.shorten(card.title, 46)}`);
      print(U.color.dim(`            ${card.domainLabel} · ${card.principles.map((item) => item.name).join(' / ')}`));
    }
    if (created.length > 6) print(U.color.dim(`  …还有 ${created.length - 6} 张，用 cuotiben list 查看`));
    print('');
    print(`下一步：${U.color.cyan('cuotiben lesson ' + created[0].id.slice(-8))} 生成备课单`);
  } else {
    print(U.color.dim('没有新的工作回合。换个 --since / --sources，或到别的项目目录用 --here 再扫。'));
  }
}

function cmdList(args, dir) {
  const store = requireStore(dir);
  const status = String(U.option(args, ['status'], 'all'));
  const domain = String(U.option(args, ['domain'], 'all'));
  const limit = Number(U.option(args, ['limit'], 30));
  let cards = store.cards;
  if (status === 'due') cards = lessonLib.dueCards(cards);
  else if (status !== 'all') cards = cards.filter((card) => card.status === status);
  if (domain !== 'all') cards = cards.filter((card) => card.domain === domain);
  cards = cards.slice(0, limit);
  if (U.flag(args, 'json')) {
    print(JSON.stringify(cards.map(analyze.cardSummary), null, 2));
    return;
  }
  if (!cards.length) {
    print(U.color.dim('没有符合条件的卡片。'));
    return;
  }
  print(U.color.bold(`错题卡片（${cards.length}）`));
  print('');
  table(
    cards.map((card) => [
      card.id.slice(-8),
      U.localDay(new Date(card.createdAt)),
      card.domainLabel,
      String(card.blackbox),
      analyze.STATUS_LABELS[card.status] || card.status,
      U.shorten(card.title, 40),
    ]),
    ['ID', '日期', '领域', '黑盒', '状态', '事件'],
  );
  print('');
  print(U.color.dim('提示：ID 只写后 8 位也能识别，例如 cuotiben show ' + cards[0].id.slice(-8)));
}

function cmdShow(args, dir) {
  const store = requireStore(dir);
  const card = storeLib.findCard(store, args._[1]);
  if (!card) throw new Error(`找不到卡片：${args._[1] || '（未提供 ID）'}`);
  if (U.flag(args, 'json')) {
    print(JSON.stringify(card, null, 2));
    return;
  }
  print(U.color.bold(card.title));
  print('');
  print(`  ID        ${card.id}`);
  print(`  时间      ${U.localTime(new Date(card.createdAt))}`);
  print(`  来源      ${card.source}${card.cwd ? ` · ${U.homeShort(card.cwd)}` : ''}`);
  print(`  领域      ${card.domainLabel}`);
  print(`  黑盒指数  ${card.blackbox}/100（${card.blackboxLevel}）`);
  print(`  状态      ${analyze.STATUS_LABELS[card.status] || card.status}`);
  if (card.review && card.review.due) print(`  下次复习  ${U.localTime(new Date(card.review.due))}`);
  print('');
  print(U.color.bold('你当时说'));
  print(`  ${card.userAsk}`);
  print('');
  print(U.color.bold('AI 做了什么'));
  for (const item of card.aiDid) print(`  - ${item}`);
  if (card.files && card.files.length) {
    print('');
    print(U.color.bold('涉及文件'));
    for (const file of card.files.slice(0, 10)) print(`  - ${file}`);
  }
  if (card.commands && card.commands.length) {
    print('');
    print(U.color.bold('运行过的命令'));
    for (const command of card.commands.slice(0, 6)) print(`  - ${U.shorten(command, 120)}`);
  }
  print('');
  print(U.color.bold('为什么它是错题'));
  for (const signal of card.signals || []) print(`  · ${signal}`);
  print('');
  print(U.color.bold('该补的原理'));
  for (const ref of card.principles) print(`  · ${ref.name}${ref.why ? U.color.dim(` — ${ref.why}`) : ''}`);
  print('');
  print(`建议验收：${card.verifyHint}`);
  if (card.lesson) print(`已有课程：${card.lesson}`);
  else print(`下一步：${U.color.cyan('cuotiben lesson ' + card.id.slice(-8))} 生成备课单`);
}

function cmdLesson(args, dir) {
  const store = requireStore(dir);
  const card = storeLib.findCard(store, args._[1]);
  if (!card) throw new Error(`找不到卡片：${args._[1] || '（未提供 ID）'}`);
  const brief = lessonLib.buildBrief(card);
  const out = U.option(args, ['out']);
  const defaultName = `${U.localDay(new Date(card.createdAt))}-${card.domain}-${card.id.slice(-6)}.brief.md`;
  const file = out ? path.resolve(out) : path.join(store.paths.lessons, defaultName);
  U.writeText(file, brief);
  if (U.flag(args, 'json')) {
    print(JSON.stringify({ card: analyze.cardSummary(card), brief: file }, null, 2));
    return;
  }
  print(U.color.green('✓') + ` 备课单已生成：${relPath(store, file)}`);
  print('');
  print(U.color.bold('这张卡要补的原理'));
  for (const ref of card.principles) print(`  · ${ref.name}`);
  print('');
  print(U.color.bold('接下来（给 AI 的指令示例）'));
  print(`  读 ${relPath(store, file)}，按任务单写出一份中文课程讲义，`);
  print(`  保存为 ${lessonLib.suggestFilename(card)}，然后运行：`);
  print(`  ${U.color.cyan(`cuotiben save <讲义路径> --card ${card.id.slice(-8)}`)}`);
  print('');
  print(U.color.dim('讲义质量由 cuotiben lint 检查：7 个部分、可执行实验、≥3 道自测题。'));
}

function cmdLint(args) {
  const file = args._[1];
  if (!file) throw new Error('用法：cuotiben lint <讲义.md>');
  const full = path.resolve(file);
  const text = U.readText(full);
  const result = lessonLib.lint(text);
  if (U.flag(args, 'json')) {
    print(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  print(U.color.bold(`课程验收：${result.ok ? U.color.green('通过') : U.color.red('未通过')}  ${result.score}/100`));
  print('');
  print(`  汉字数：${result.chineseChars}`);
  print(`  结构：${result.sections.map((section) => `${section.found ? U.color.green('✓') : U.color.red('✗')} ${section.label}`).join('  ')}`);
  print('');
  if (result.issues.length) {
    print(U.color.red('必须修的问题'));
    for (const issue of result.issues) print(`  - ${issue}`);
    print('');
  }
  if (result.warnings.length) {
    print(U.color.yellow('建议改进'));
    for (const warning of result.warnings) print(`  - ${warning}`);
    print('');
  }
  if (!result.ok) {
    print(U.color.dim('确认是有意为之，可以加 --force 强制入库。'));
    process.exitCode = 1;
  }
}

function cmdSave(args, dir) {
  const store = requireStore(dir);
  const file = args._[1];
  if (!file) throw new Error('用法：cuotiben save <讲义.md> --card <卡片ID>');
  const card = storeLib.findCard(store, U.option(args, ['card']));
  if (!card) throw new Error(`找不到卡片：${U.option(args, ['card'], '（用 --card 指定）')}`);
  try {
    const result = lessonLib.saveLesson(store, path.resolve(file), card, { force: U.flag(args, 'force') });
    storeLib.saveCards(store);
    U.writeText(store.paths.index, lessonLib.renderIndex(store));
    print(U.color.green('✓') + ` 课程已入库：${result.card.lesson}（验收 ${result.lint.score} 分）`);
    print(`  卡片状态：${analyze.STATUS_LABELS[result.card.status] || result.card.status}`);
    print(`  下次复习：${U.localTime(new Date(result.card.review.due))}（第 ${result.card.review.interval} 天）`);
    if (result.lint.warnings.length) {
      print('');
      print(U.color.yellow('小提醒'));
      for (const warning of result.lint.warnings) print(`  - ${warning}`);
    }
  } catch (error) {
    if (error.lint) {
      print(U.color.red(`✗ 讲义没有通过验收（${error.lint.score} 分），先修这些问题：`));
      for (const issue of error.lint.issues) print(`  - ${issue}`);
      print('');
      print(U.color.dim('修改后重新 save；确认可以接受时加 --force。'));
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

function cmdGrade(args, dir) {
  const store = requireStore(dir);
  const card = storeLib.findCard(store, args._[1]);
  if (!card) throw new Error(`找不到卡片：${args._[1] || '（未提供 ID）'}`);
  const quality = Number(args._[2]);
  if (!Number.isFinite(quality) || quality < 0 || quality > 5) {
    throw new Error('评分是 0-5：0-2 完全忘了，3 勉强想起，4 基本记得，5 能讲给别人');
  }
  const note = U.option(args, ['note'], '');
  analyze.cardSummary(card);
  lessonLib.gradeCard(card, quality, note);
  storeLib.saveCards(store);
  U.writeText(store.paths.index, lessonLib.renderIndex(store));
  print(`${U.color.green('✓')} 已记录评分 ${quality}/5`);
  print(`  下次复习：${U.localTime(new Date(card.review.due))}（间隔 ${card.review.interval} 天，难度系数 ${card.review.ease}）`);
  print(`  卡片状态：${analyze.STATUS_LABELS[card.status] || card.status}`);
}

function cmdReview(args, dir) {
  const store = requireStore(dir);
  const due = lessonLib.dueCards(store.cards);
  const limit = Number(U.option(args, ['limit'], 20));
  const list = due.slice(0, limit);
  if (U.flag(args, 'json')) {
    print(JSON.stringify(list.map(analyze.cardSummary), null, 2));
    return;
  }
  if (!due.length) {
    print(U.color.green('✓ 今天没有到期卡片。'));
    const newCards = store.cards.filter((card) => card.status === 'new');
    if (newCards.length) print(U.color.dim(`还有 ${newCards.length} 张没开课：cuotiben list --status new`));
    return;
  }
  print(U.color.bold(`今天该复习 ${due.length} 张（显示 ${list.length} 张）`));
  print('');
  for (const card of list) {
    print(`  ${U.color.magenta(card.id.slice(-8))}  ${U.shorten(card.title, 44)}`);
    print(U.color.dim(`            ${card.domainLabel} · 黑盒 ${card.blackbox} · 上次评分 ${card.review.lastGrade == null ? '—' : card.review.lastGrade}`));
    if (card.lesson) print(`            课程：${card.lesson}`);
    else print(U.color.yellow('            还没有课程，先 cuotiben lesson ' + card.id.slice(-8)));
  }
  print('');
  print(U.color.bold('复习完这样记录'));
  print(`  cuotiben grade ${list[0].id.slice(-8)} 4`);
  print(U.color.dim('评分标准：0-2 完全忘了 / 3 勉强想起 / 4 基本记得 / 5 能讲给别人'));
}

function cmdStats(args, dir) {
  const store = requireStore(dir);
  if (U.flag(args, 'json')) {
    print(JSON.stringify(reportLib.buildPayload(store).stats, null, 2));
    return;
  }
  print(reportLib.printStats(store));
}

function cmdReport(args, dir) {
  const store = requireStore(dir);
  const days = Number(U.option(args, ['days'], 7));
  const text = reportLib.weeklyReport(store, days);
  const out = U.option(args, ['out']);
  if (out) {
    const file = path.resolve(out);
    U.writeText(file, text);
    print(U.color.green('✓') + ` 周报已生成：${U.homeShort(file)}`);
    return;
  }
  print(text);
}

function cmdHtml(args, dir) {
  const store = requireStore(dir);
  const payload = reportLib.buildPayload(store);
  const out = path.resolve(U.option(args, ['out'], path.join(store.paths.root, 'index.html')));
  U.writeText(out, reportLib.renderHtml(payload, 'AI 错题本'));
  print(U.color.green('✓') + ` 看板已生成：${U.homeShort(out)}`);
  print(U.color.dim('用浏览器打开即可；可以打印成 PDF，也可以把 .cuotiben/ 整个提交进项目。'));
}

function cmdDemo(args) {
  const out = path.resolve(U.option(args, ['out'], path.join('docs', 'index.html')));
  const payload = reportLib.buildDemoPayload(DEMO_CARDS);
  U.writeText(out, reportLib.renderHtml(payload, 'AI 错题本 · 示例看板'));
  print(U.color.green('✓') + ` 示例看板已生成：${U.homeShort(out)}`);
  print(U.color.dim('这是用示例事件生成的静态页，可直接放 GitHub Pages。'));
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function cmdHook(args, dir) {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    throw new Error('Hook 输入不是合法 JSON');
  }
  const store = storeLib.loadStore(dir);
  const row = capture.appendHookEvent(store.paths.root, payload);
  print(`cuotiben: 已记录 ${row.hook}${row.tool ? ` · ${row.tool}` : ''}`);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function cmdInstallSkill(args) {
  const target = String(U.option(args, ['target'], 'both'));
  const skillSrc = path.join(__dirname, '..', 'skills', 'auto-cuotiben');
  if (!fs.existsSync(skillSrc)) throw new Error(`找不到内置 skill 目录：${skillSrc}`);
  const targets = [];
  if (target === 'dsh' || target === 'both') {
    targets.push({ name: 'DSH', dest: path.join(os.homedir(), '.dsh', 'skills', 'auto-cuotiben') });
  }
  if (target === 'claude' || target === 'both') {
    const base = U.option(args, ['project']) || process.cwd();
    targets.push({ name: 'Claude Code', dest: path.join(base, '.claude', 'skills', 'auto-cuotiben') });
  }
  if (!targets.length) throw new Error('--target 只能是 dsh / claude / both');
  for (const item of targets) {
    copyDir(skillSrc, item.dest);
    const principles = path.join(__dirname, 'data', 'principles.json');
    if (fs.existsSync(principles)) {
      fs.mkdirSync(path.join(item.dest, 'references'), { recursive: true });
      fs.copyFileSync(principles, path.join(item.dest, 'references', 'principles.json'));
    }
    print(U.color.green('✓') + ` 已安装到 ${item.name}：${U.homeShort(item.dest)}`);
  }
  print('');
  print(U.color.dim('重启 AI 助手后，技能目录里就会出现 auto-cuotiben。'));
}

function cmdDoctor(args) {
  const store = storeLib.loadStore(U.option(args, ['dir'], storeLib.DEFAULT_STORE));
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeMinor = Number(process.versions.node.split('.')[1]);
  const zstdOk = typeof require('node:zlib').zstdDecompressSync === 'function';
  checks.push({
    ok: zstdOk,
    label: `Node ${process.version} 内置 zstd`,
    hint: zstdOk ? '' : '需要 Node >= 22.15（nvm install 22 或用新版 Node）',
  });
  const dsh = capture.dshRoots().filter((root) => fs.existsSync(root));
  checks.push({ ok: dsh.length > 0, label: `DSH 会话目录 ${dsh.length ? dsh.map(U.homeShort).join(', ') : '未找到'}`, hint: dsh.length ? '' : '没装 DSH 也没关系，可用 Claude Code 或 Codex' });
  const codex = capture.codexRoots().filter((root) => fs.existsSync(root));
  checks.push({ ok: codex.length > 0, label: `Codex 会话目录 ${codex.length ? codex.map(U.homeShort).join(', ') : '未找到'}`, hint: '' });
  const claude = capture.claudeRoots().filter((root) => fs.existsSync(root));
  checks.push({ ok: claude.length > 0, label: `Claude Code 会话目录 ${claude.length ? claude.map(U.homeShort).join(', ') : '未找到'}`, hint: '' });
  const data = analyze.loadPrinciples();
  checks.push({
    ok: data.principles.length >= 20,
    label: `原理库 ${data.principles.length} 条`,
    hint: data.principles.length >= 20 ? '' : 'src/data/principles.json 可能缺失',
  });
  checks.push({
    ok: store.cards.length >= 0,
    label: `错题本 ${U.homeShort(store.paths.root)} · ${store.cards.length} 张卡片 / ${store.events.length} 个事件`,
    hint: '',
  });
  checks.push({
    ok: (nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 15)),
    label: `版本检查（需要 >= 22.15）`,
    hint: '',
  });
  print(U.color.bold('auto-cuotiben 自检'));
  print('');
  for (const check of checks) {
    print(`  ${check.ok ? U.color.green('✓') : U.color.red('✗')} ${check.label}${check.hint ? U.color.dim(' — ' + check.hint) : ''}`);
  }
  print('');
  const bad = checks.filter((check) => !check.ok);
  if (bad.length) print(U.color.yellow(`有 ${bad.length} 项需要处理。`));
  else print(U.color.green('一切正常。'));
}

async function main(argv) {
  const args = U.parseArgs(argv);
  const command = args._[0] || 'help';
  const dir = U.option(args, ['dir', 'store'], storeLib.DEFAULT_STORE);
  if (U.flag(args, 'help', 'h') && command !== 'help') {
    print(HELP);
    return;
  }
  switch (command) {
    case 'help':
    case undefined:
      print(HELP);
      return;
    case 'version':
    case '-v':
      print(VERSION);
      return;
    case 'init':
      cmdInit(args, dir);
      return;
    case 'scan':
      cmdScan(args, dir);
      return;
    case 'list':
      cmdList(args, dir);
      return;
    case 'show':
      cmdShow(args, dir);
      return;
    case 'lesson':
      cmdLesson(args, dir);
      return;
    case 'lint':
      cmdLint(args);
      return;
    case 'save':
      cmdSave(args, dir);
      return;
    case 'grade':
      cmdGrade(args, dir);
      return;
    case 'review':
      cmdReview(args, dir);
      return;
    case 'stats':
      cmdStats(args, dir);
      return;
    case 'report':
      cmdReport(args, dir);
      return;
    case 'html':
      cmdHtml(args, dir);
      return;
    case 'demo':
      cmdDemo(args);
      return;
    case 'hook':
      await cmdHook(args, dir);
      return;
    case 'install-skill':
    case 'install':
      cmdInstallSkill(args);
      return;
    case 'doctor':
      cmdDoctor(args);
      return;
    default:
      print(U.color.red(`未知命令：${command}`));
      print(HELP);
      process.exitCode = 1;
  }
}

module.exports = { main, DEMO_CARDS };
