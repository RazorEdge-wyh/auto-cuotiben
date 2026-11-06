'use strict';

const path = require('node:path');
const U = require('./util.js');

let cachedPrinciples = null;
let cachedError = null;

function loadPrinciples() {
  if (cachedPrinciples) return cachedPrinciples;
  const file = path.join(__dirname, 'data', 'principles.json');
  const data = U.readJson(file, null);
  if (!data || !Array.isArray(data.principles)) {
    cachedError = `原理库读取失败：${U.homeShort(file)} 不存在或不是合法 JSON`;
    cachedPrinciples = { version: 0, layers: [], principles: [], byId: new Map() };
    return cachedPrinciples;
  }
  const byId = new Map(data.principles.map((item) => [item.id, item]));
  cachedPrinciples = { ...data, byId };
  return cachedPrinciples;
}

function principleName(id) {
  const { byId } = loadPrinciples();
  const item = byId.get(id);
  return item ? item.name : id;
}

function layerOf(id) {
  const { byId, layers } = loadPrinciples();
  const item = byId.get(id);
  if (!item) return null;
  return layers.find((layer) => layer.id === item.layer) || null;
}

const DOMAIN_LABELS = {
  web: '网页/前端',
  data: '数据/表格',
  docs: '文档/写作',
  git: '代码版本',
  deploy: '部署/上线',
  game: '游戏/媒体',
  system: '系统/脚本',
  ai: 'AI 应用',
  other: '其他',
};

function detectDomain(turn) {
  const files = (turn.files || []).join(' ').toLowerCase();
  const commands = (turn.commands || []).join(' ').toLowerCase();
  const prompt = String(turn.userText || '').toLowerCase();
  const all = `${files} ${commands} ${prompt}`;
  if (/\.(html|css|jsx?|tsx?|vue|svelte|astro)$/.test(files) || /网页|网站|前端|页面|html|css/.test(prompt)) return 'web';
  if (/\.(xlsx?|csv|ipynb|parquet)$/.test(files) || /excel|表格|数据|pandas|统计|图表/.test(prompt)) return 'data';
  if (/\.(md|docx|pptx|pdf|tex)$/.test(files) || /文档|论文|报告|ppt|word|排版|简历/.test(prompt)) return 'docs';
  if (/git |github|commit|push|仓库|分支/.test(all)) return 'git';
  if (/deploy|vercel|netlify|pages|docker|部署|上线|发布/.test(all)) return 'deploy';
  if (/\.(unity|cs|gd|shader|glsl|blend|fbx)$/.test(files) || /游戏|unity|godot|模型|贴图/.test(prompt)) return 'game';
  if (/\.(py|ps1|sh|bat|cmd)$/.test(files) || /脚本|自动化|批处理/.test(prompt)) return 'system';
  if (/prompt|模型|大模型|api key|智能体|agent|skill/.test(prompt)) return 'ai';
  return 'other';
}

function has(turn, re) {
  const hay = `${turn.userText || ''}\n${(turn.files || []).join('\n')}\n${(turn.commands || []).join('\n')}`.toLowerCase();
  return re.test(hay);
}

function promptRe(turn, re) {
  return re.test(String(turn.userText || '').toLowerCase());
}

function filesRe(turn, re) {
  return (turn.files || []).some((file) => re.test(String(file).toLowerCase()));
}

function cmdRe(turn, re) {
  return (turn.commands || []).some((command) => re.test(String(command).toLowerCase()));
}

/**
 * Keyword → principle rules. Each hit adds weight; the top hits become the
 * card's lesson backbone. Rules prefer concrete evidence (files / commands)
 * over words that merely appear in the prompt, to avoid false positives
 * (e.g. a prompt saying "do not run git" is not a git lesson).
 */
const RULES = [
  { id: 'filesystem', weight: 5, test: (t) => t.writes > 0 },
  { id: 'shell', weight: 5, test: (t) => (t.commands || []).length > 0 },
  { id: 'agent-loop', weight: 3, test: (t) => t.steps >= 3 || t.toolCount >= 4 },
  { id: 'html-css', weight: 5, test: (t) => filesRe(t, /\.(html?|css|scss|jsx|tsx|vue|svelte|astro)$/) || promptRe(t, /网页|网站|前端|页面|样式|布局|响应式/) },
  { id: 'deployment', weight: 5, test: (t) => cmdRe(t, /\b(deploy|vercel|netlify|gh-pages|docker( build| compose)?|npm run build|pnpm build|yarn build)\b/) || filesRe(t, /dockerfile|vercel\.json|netlify\.toml|\.github\/workflows/) || promptRe(t, /部署|上线|发布|托管|pages/) },
  { id: 'data-analysis', weight: 5, test: (t) => filesRe(t, /\.(csv|xlsx?|ipynb|parquet)$/) || promptRe(t, /excel|表格|数据|pandas|dataframe|透视|图表|统计/) },
  { id: 'git', weight: 5, test: (t) => cmdRe(t, /\bgit\b|\bgh\b|github\.com/) || filesRe(t, /\.gitignore$/) || promptRe(t, /提交|推送|分支|仓库|commit|push|pull request/) },
  { id: 'packaging', weight: 4, test: (t) => cmdRe(t, /npm (i|install)|pip install|yarn add|pnpm add|requirements\.txt/) || filesRe(t, /package\.json|requirements\.txt|pyproject\.toml|environment\.ya?ml/) || promptRe(t, /依赖|环境|安装|版本冲突|找不到模块/) },
  { id: 'testing', weight: 4, test: (t) => cmdRe(t, /test|pytest|jest|vitest|playwright/) || filesRe(t, /\.(test|spec)\.[a-z]+$/) || promptRe(t, /测试|回归|用例/) },
  { id: 'security', weight: 4, test: (t) => promptRe(t, /密码|密钥|api key|token|\.env|权限|登录|加密|隐私/) || filesRe(t, /\.env|secret|auth/) },
  { id: 'http-api', weight: 4, test: (t) => cmdRe(t, /curl|fetch|http/) || promptRe(t, /接口|api|http|请求|鉴权/) },
  { id: 'eval', weight: 4, test: (t) => promptRe(t, /对吗|检查|验证|可靠|幻觉|准确|引用|来源|复核|验收/) },
  { id: 'hallucination', weight: 3, test: (t) => t.web > 0 || promptRe(t, /查一下|搜索|资料|来源|真的吗/) },
  { id: 'function-calling', weight: 3, test: (t) => t.toolCount >= 2 },
  { id: 'sandbox', weight: 3, test: (t) => promptRe(t, /沙箱|权限|批准|denied|写入失败|只读/) },
  { id: 'memory', weight: 3, test: (t) => promptRe(t, /记住|记忆|上下文|会话|之前说过|刚才/) },
  { id: 'subagent', weight: 3, test: (t) => t.delegates > 0 },
  { id: 'tool-schema', weight: 2, test: (t) => t.errors > 0 || t.delegates > 0 },
  { id: 'rag', weight: 4, test: (t) => promptRe(t, /知识库|检索|rag|向量|相似度|embedding|召回/) },
  { id: 'embedding', weight: 3, test: (t) => promptRe(t, /相似|向量|语义|embedding/) },
  { id: 'reasoning', weight: 3, test: (t) => promptRe(t, /推理|思维链|思考|复杂|证明|分析一下/) },
  { id: 'temperature', weight: 3, test: (t) => promptRe(t, /随机|创造性|风格|每次不一样|温度/) },
  { id: 'attention', weight: 2, test: (t) => promptRe(t, /太长|上下文|忘了|前面|长文|窗口/) },
  { id: 'finetune-vs-rag', weight: 2, test: (t) => promptRe(t, /微调|fine.?tune|训练|知识更新/) },
  { id: 'context-window', weight: 2, test: (t) => t.steps >= 8 || t.toolCount >= 12 || (t.userText || '').length > 700 },
  { id: 'token-cost', weight: 2, test: (t) => t.steps >= 10 || promptRe(t, /token|费用|计费|成本/) },
  { id: 'next-token', weight: 1, test: (t) => promptRe(t, /为什么这么写|生成|续写|改写/) },
  { id: 'prompt-as-spec', weight: 1, test: () => true },
];

function classify(turn) {
  const hits = [];
  for (const rule of RULES) {
    let matched = false;
    try {
      matched = rule.test(turn);
    } catch {
      matched = false;
    }
    if (matched) hits.push({ id: rule.id, weight: rule.weight });
  }
  hits.sort((a, b) => b.weight - a.weight);
  const picked = [];
  for (const hit of hits) {
    if (picked.length >= 4) break;
    picked.push(hit);
  }
  if (picked.length < 2) {
    for (const fallback of ['prompt-as-spec', 'agent-loop', 'eval']) {
      if (picked.length >= 2) break;
      if (!picked.some((item) => item.id === fallback)) picked.push({ id: fallback, weight: 1 });
    }
  }
  const { byId } = loadPrinciples();
  return picked.map((item) => ({
    id: item.id,
    name: principleName(item.id),
    why: byId.get(item.id) ? byId.get(item.id).oneLiner : '',
    weight: item.weight,
  }));
}

function blackboxScore(turn) {
  let score = 0;
  const signals = [];
  const writeScore = Math.min(40, turn.writes * 9);
  if (writeScore) {
    score += writeScore;
    signals.push(`AI 直接改写了 ${turn.writes} 个文件（+${writeScore}）`);
  }
  const stepScore = Math.min(20, Math.round(turn.steps * 1.5));
  if (stepScore) {
    score += stepScore;
    signals.push(`自动执行了 ${turn.steps} 步（+${stepScore}）`);
  }
  const fileScore = Math.min(12, (turn.files || []).length * 3);
  if (fileScore) {
    score += fileScore;
    signals.push(`产出分布在 ${turn.files.length} 个文件（+${fileScore}）`);
  }
  if (!/为什么|解释|原理|怎么实现|讲讲|教我|why|explain/.test(turn.userText || '')) {
    score += 10;
    signals.push('你没有要求解释过程（+10）');
  }
  const verified =
    /测试|运行|预览|检查|验证|test|npm|打开|对比/.test(turn.userText || '') ||
    (turn.commands || []).some((cmd) => /test|build|run|check/i.test(cmd));
  if (!verified) {
    score += 10;
    signals.push('没有看到你亲自验收（+10）');
  }
  if (turn.errors > 0) {
    const extra = Math.min(10, turn.errors * 3);
    score += extra;
    signals.push(`AI 试错 ${turn.errors} 次才做对，过程你没参与（+${extra}）`);
  }
  const value = U.clamp(Math.round(score), 0, 100);
  let level = '低';
  if (value >= 70) level = '高';
  else if (value >= 40) level = '中';
  return { score: value, level, signals };
}

const STATUS_LABELS = {
  new: '未开课',
  learning: '学习中',
  reviewing: '复习中',
  mastered: '已掌握',
};

function summarizeAiDid(turn) {
  const parts = [];
  if (turn.writes > 0) {
    const names = (turn.files || []).slice(0, 3).map((f) => path.basename(String(f).replace(/[\\/]+$/, ''))).filter(Boolean);
    parts.push(`改写 ${turn.writes} 个文件${names.length ? `（${names.join('、')}${turn.files.length > 3 ? ' 等' : ''}）` : ''}`);
  }
  if ((turn.commands || []).length > 0) {
    parts.push(`执行 ${turn.commands.length} 条命令（${U.shorten(turn.commands[0], 40).trim()}）`);
  }
  if (turn.web > 0) parts.push(`联网检索 ${turn.web} 次`);
  if (turn.delegates > 0) parts.push(`调度 ${turn.delegates} 个子代理`);
  if (turn.reads > 0) parts.push(`读了 ${turn.reads} 个文件`);
  if (turn.errors > 0) parts.push(`中途报错 ${turn.errors} 次后自行修复`);
  return parts.length ? parts : ['调用 AI 完成了这项任务'];
}

function suggestVerify(turn) {
  const files = turn.files || [];
  const html = files.find((f) => /\.html?$/i.test(f));
  if (html) return `用浏览器打开 ${path.basename(html)}，亲手改一处文案再刷新，看是否按预期变化`;
  if (files.some((f) => /package\.json$/.test(f))) return '运行 npm test / npm run build，确认你能看懂失败信息在说什么';
  if (files.some((f) => /\.py$/i.test(f))) return `运行 python ${path.basename(files.find((f) => /\.py$/i.test(f)))}，然后故意改坏一个参数看它怎么报错`;
  if ((turn.commands || []).length) return '把 AI 跑过的那条命令自己再跑一遍，逐段读懂每个参数的作用';
  return '合上电脑，用 3 句话向朋友复述 AI 替你做了哪 3 个决定';
}

const STOP_ASKS = /^(停止|停|暂停|继续|继续吧|好|好的|可以|行|嗯|对|是的|ok|okay|yes|no|不用了|算了|取消|退出|结束|谢谢|收到)[。！!.\s]*$/i;

function isWorkTurn(turn) {
  if (!turn) return false;
  const ask = String(turn.userText || '').trim();
  if (!ask) return false;
  if (STOP_ASKS.test(ask)) return false;
  const artifact = turn.writes > 0 || (turn.commands || []).length > 0 || turn.delegates > 0;
  const meaningfulWeb = turn.web > 0 && turn.toolCount >= 2;
  if (!artifact && !meaningfulWeb) return false;
  if (turn.delegationDepth > 0) return false;
  return true;
}

function distillTurn(turn) {
  if (!isWorkTurn(turn)) return null;
  const { principles, blackbox } = buildCardParts(turn);
  const domain = detectDomain(turn);
  const title = U.shorten(turn.userText, 48) || `AI 帮我做了一次${DOMAIN_LABELS[domain] || '任务'}`;
  const createdAt = turn.endedAt || turn.startedAt || new Date().toISOString();
  const card = {
    id: U.shortId('card', turn.id),
    eventId: turn.id,
    title,
    userAsk: U.shorten(turn.userText, 320),
    aiDid: summarizeAiDid(turn),
    verifyHint: suggestVerify(turn),
    domain,
    domainLabel: DOMAIN_LABELS[domain] || DOMAIN_LABELS.other,
    source: turn.source,
    sessionId: turn.sessionId,
    cwd: turn.cwd,
    createdAt,
    durationMs: turn.durationMs,
    files: turn.files,
    commands: turn.commands,
    principles,
    blackbox: blackbox.score,
    blackboxLevel: blackbox.level,
    signals: blackbox.signals,
    status: 'new',
    review: { reps: 0, ease: 2.5, interval: 0, due: tomorrow(createdAt) },
    lesson: null,
    grades: [],
  };
  return card;
}

function buildCardParts(turn) {
  return { principles: classify(turn), blackbox: blackboxScore(turn) };
}

function tomorrow(iso) {
  const base = new Date(iso);
  const next = new Date(base.getTime() + 24 * 3600 * 1000);
  return U.iso(next);
}

function cardSummary(card) {
  return {
    id: card.id,
    title: card.title,
    domain: card.domain,
    domainLabel: card.domainLabel,
    blackbox: card.blackbox,
    blackboxLevel: card.blackboxLevel,
    principles: card.principles.map((p) => p.name || p.id),
    status: card.status,
    statusLabel: STATUS_LABELS[card.status] || card.status,
    createdAt: card.createdAt,
    due: card.review ? card.review.due : null,
  };
}

module.exports = {
  DOMAIN_LABELS,
  STATUS_LABELS,
  loadPrinciples,
  principleName,
  layerOf,
  detectDomain,
  classify,
  blackboxScore,
  distillTurn,
  isWorkTurn,
  cardSummary,
  tomorrow,
  cachedError: () => cachedError,
};
