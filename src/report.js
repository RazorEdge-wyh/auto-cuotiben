'use strict';

const path = require('node:path');
const U = require('./util.js');
const analyze = require('./analyze.js');
const lesson = require('./lesson.js');

function buildPayload(store) {
  const cards = [...store.cards].sort((a, b) => U.toMs(b.createdAt) - U.toMs(a.createdAt));
  const now = Date.now();
  const due = lesson.dueCards(store.cards, now);
  const domains = new Map();
  for (const card of cards) domains.set(card.domain, card.domainLabel);
  const principleCount = new Map();
  for (const card of cards) {
    for (const ref of card.principles || []) {
      const key = ref.name || analyze.principleName(ref.id);
      const weight = card.status === 'mastered' ? 1 : 2;
      principleCount.set(key, (principleCount.get(key) || 0) + weight);
    }
  }
  const principleRank = [...principleCount.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  const days = new Set(cards.map((card) => U.localDay(new Date(card.createdAt))));
  const avgBlackbox = cards.length
    ? Math.round(cards.reduce((acc, card) => acc + (Number(card.blackbox) || 0), 0) / cards.length)
    : 0;
  const viewCards = cards.map((card) => {
    const view = analyze.cardSummary(card);
    return {
      ...view,
      userAsk: card.userAsk || '',
      source: card.source,
      aiDid: card.aiDid || [],
      lesson: card.lesson || null,
      lastGrade: card.review && card.review.lastGrade != null ? card.review.lastGrade : null,
      due: card.review && card.review.due ? card.review.due : null,
    };
  });
  return {
    generatedAt: U.localTime(new Date()),
    stats: {
      events: store.events.length,
      cards: cards.length,
      lessons: cards.filter((card) => card.lesson).length,
      mastered: cards.filter((card) => card.status === 'mastered').length,
      due: due.length,
      avgBlackbox,
      highBlackbox: cards.filter((card) => card.blackbox >= 70).length,
      days: days.size,
    },
    domains: [...domains.entries()].map(([id, label]) => ({ id, label })),
    principleRank,
    cards: viewCards,
    due: due.map((card) => analyze.cardSummary(card)),
  };
}

function renderHtml(payload, title = 'AI 错题本') {
  const templatePath = path.join(__dirname, 'dashboard.template.html');
  const template = U.readText(templatePath);
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return template.replace(/__CUOTIBEN_TITLE__/g, U.escapeHtml(title)).replace('/*__CUOTIBEN_DATA__*/', json);
}

function printStats(store) {
  const payload = buildPayload(store);
  const { stats } = payload;
  const lines = [];
  lines.push(U.color.bold('AI 错题本 · 统计'));
  lines.push('');
  lines.push(`  采集事件      ${stats.events}`);
  lines.push(`  错题卡片      ${stats.cards}`);
  lines.push(`  已生成课程    ${stats.lessons}`);
  lines.push(`  已掌握        ${stats.mastered}`);
  lines.push(`  今天要复习    ${U.color.yellow(String(stats.due))}`);
  lines.push(`  平均黑盒指数  ${stats.avgBlackbox}/100（≥70 的高黑盒卡片 ${stats.highBlackbox} 张）`);
  lines.push(`  活跃天数      ${stats.days}`);
  lines.push('');
  if (payload.principleRank.length) {
    lines.push(U.color.bold('最该补的原理（按出现次数 × 未掌握度）'));
    for (const row of payload.principleRank.slice(0, 6)) {
      lines.push(`  ${U.bar(row.count, payload.principleRank[0].count, 14)} ${row.name} ×${row.count}`);
    }
    lines.push('');
  }
  const bySource = new Map();
  for (const card of store.cards) bySource.set(card.source, (bySource.get(card.source) || 0) + 1);
  if (bySource.size) {
    lines.push(`来源分布：${[...bySource.entries()].map(([source, count]) => `${source} ${count}`).join(' · ')}`);
  }
  return lines.join('\n');
}

function weeklyReport(store, days = 7) {
  const since = Date.now() - days * 86400 * 1000;
  const cards = store.cards.filter((card) => U.toMs(card.createdAt) >= since);
  const all = store.cards;
  const due = lesson.dueCards(store.cards);
  const lessons = cards.filter((card) => card.lesson);
  const mastered = cards.filter((card) => card.status === 'mastered');
  const avg = cards.length ? Math.round(cards.reduce((acc, card) => acc + card.blackbox, 0) / cards.length) : 0;
  const openDebt = all.filter((card) => card.status !== 'mastered');
  const debtIndex = openDebt.length
    ? Math.round(openDebt.reduce((acc, card) => acc + card.blackbox, 0) / openDebt.length)
    : 0;
  const principleCount = new Map();
  for (const card of openDebt) {
    for (const ref of card.principles || []) {
      const key = ref.name || analyze.principleName(ref.id);
      principleCount.set(key, (principleCount.get(key) || 0) + 1);
    }
  }
  const top = [...principleCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  const lines = [];
  const from = U.localDay(new Date(since));
  const to = U.localDay(new Date());
  lines.push(`# AI 使用周报 · ${from} ~ ${to}`);
  lines.push('');
  lines.push('## 一句话总结');
  lines.push('');
  if (!cards.length) {
    lines.push(`这 ${days} 天没有采集到新的 AI 协作事件。要么你最近没让 AI 干活，要么忘了运行 \`cuotiben scan\`。`);
  } else {
    lines.push(
      `这 ${days} 天你让 AI 接手了 **${cards.length}** 件事，其中 **${lessons.length}** 件已经整理成课程、**${mastered.length}** 件通过复习；这批事的平均黑盒指数 **${avg}/100**。`,
    );
  }
  lines.push('');
  lines.push('## 你让 AI 做了什么');
  lines.push('');
  if (!cards.length) {
    lines.push('（无）');
  } else {
    lines.push('| 日期 | 事件 | 领域 | 黑盒指数 | 状态 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const card of cards.slice(0, 15)) {
      const title = U.shorten(card.title, 36).replace(/\|/g, '\\|');
      lines.push(
        `| ${U.localDay(new Date(card.createdAt))} | ${title} | ${card.domainLabel} | ${card.blackbox} | ${analyze.STATUS_LABELS[card.status] || card.status} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 最该补的三块原理');
  lines.push('');
  if (!top.length) {
    lines.push('（暂无数据）');
  } else {
    top.forEach(([name, count], index) => lines.push(`${index + 1}. **${name}** —— 出现在 ${count} 张未掌握的卡片里`));
  }
  lines.push('');
  lines.push('## 认知负债');
  lines.push('');
  lines.push(`未掌握卡片 ${openDebt.length} 张，平均黑盒指数 **${debtIndex}/100**。`);
  lines.push('');
  lines.push(debtIndex >= 70
    ? '> 警告：你最近让 AI 代做的多数事情都处于「只看到结果、没看懂过程」的状态。这不是效率问题，是能力迁移问题。'
    : debtIndex >= 40
      ? '> 提醒：认知债在累积。建议每天只补 1 张卡，但要真的做完验证实验。'
      : '> 状态健康：你在用 AI 提效的同时，还在把原理收进自己的脑子。');
  lines.push('');
  lines.push('## 下周建议');
  lines.push('');
  const next = due[0];
  lines.push(`- 今天先复习到期卡片 ${due.length} 张${next ? `（下一张：${U.shorten(next.title, 30)}）` : ''}。`);
  if (top.length) lines.push(`- 优先给「${top[0][0]}」补一节 15 分钟的课。`);
  lines.push('- 每张卡只要求一个「5 分钟亲手验证」，不要贪多；做完就给自己打分。');
  lines.push('- 下次让 AI 干活时，在需求里补一句「做完解释一下你为什么这么选」，黑盒指数会立刻下降。');
  lines.push('');
  return lines.join('\n');
}

function buildDemoPayload(demoCards) {
  const cards = demoCards.map((card, index) => ({
    id: `card_demo${String(index + 1).padStart(3, '0')}`,
    title: card.title,
    userAsk: card.userAsk,
    createdAt: card.createdAt,
    domain: card.domain,
    domainLabel: analyze.DOMAIN_LABELS[card.domain] || card.domain,
    source: card.source || 'dsh',
    blackbox: card.blackbox,
    blackboxLevel: card.blackbox >= 70 ? '高' : card.blackbox >= 40 ? '中' : '低',
    principles: card.principles,
    status: card.status || 'new',
    statusLabel: analyze.STATUS_LABELS[card.status || 'new'] || '未开课',
    aiDid: card.aiDid || [],
    lesson: card.lesson || null,
    due: card.due || null,
    lastGrade: card.lastGrade == null ? null : card.lastGrade,
  }));
  const principleCount = new Map();
  for (const card of cards) {
    for (const name of card.principles) {
      const weight = card.status === 'mastered' ? 1 : 2;
      principleCount.set(name, (principleCount.get(name) || 0) + weight);
    }
  }
  const domains = new Map();
  for (const card of cards) domains.set(card.domain, card.domainLabel);
  return {
    generatedAt: U.localTime(new Date()),
    demo: true,
    stats: {
      events: 26,
      cards: cards.length,
      lessons: cards.filter((card) => card.lesson).length,
      mastered: cards.filter((card) => card.status === 'mastered').length,
      due: cards.filter((card) => card.status !== 'new' && card.due && U.toMs(card.due) <= Date.now()).length,
      avgBlackbox: Math.round(cards.reduce((acc, card) => acc + card.blackbox, 0) / (cards.length || 1)),
      highBlackbox: cards.filter((card) => card.blackbox >= 70).length,
      days: new Set(cards.map((card) => U.localDay(new Date(card.createdAt)))).size,
    },
    domains: [...domains.entries()].map(([id, label]) => ({ id, label })),
    principleRank: [...principleCount.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    cards,
    due: [],
  };
}

module.exports = {
  buildPayload,
  renderHtml,
  printStats,
  weeklyReport,
  buildDemoPayload,
};
