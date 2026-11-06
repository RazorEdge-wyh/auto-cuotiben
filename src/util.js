'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const HOME = os.homedir();
const TTY = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function paint(code, text) {
  return TTY ? `\u001b[${code}m${text}\u001b[0m` : String(text);
}

const color = {
  dim: (s) => paint('2', s),
  bold: (s) => paint('1', s),
  red: (s) => paint('31', s),
  green: (s) => paint('32', s),
  yellow: (s) => paint('33', s),
  blue: (s) => paint('34', s),
  magenta: (s) => paint('35', s),
  cyan: (s) => paint('36', s),
};

function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function shortId(prefix, ...parts) {
  return `${prefix}_${sha1(parts.join('\u0000')).slice(0, 10)}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, 'utf8');
}

function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* ignore malformed line */
    }
  }
  return rows;
}

function writeJsonl(file, rows) {
  writeText(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
}

function appendJsonl(file, row) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

function listFiles(root, predicate) {
  let entries;
  try {
    entries = fs.readdirSync(root, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath || entry.path || root, entry.name);
    if (predicate(full)) out.push(full);
  }
  return out;
}

function localDay(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${localDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toMs(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  const n = Number(value);
  if (Number.isFinite(n) && !String(value).includes('-')) return n;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function parseSince(input) {
  if (!input) return 0;
  const text = String(input).trim();
  const m = /^(\d+(?:\.\d+)?)\s*(m|h|d|w)$/i.exec(text);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const factor = { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[unit];
    return Date.now() - n * factor;
  }
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : 0;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const min = Math.round(total / 60);
  if (min < 60) return `${min} 分钟`;
  return `${(min / 60).toFixed(1)} 小时`;
}

function shorten(text, max = 120) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function homeShort(p) {
  if (!p) return '';
  const s = String(p);
  return s.startsWith(HOME) ? `~${s.slice(HOME.length)}` : s;
}

function slugify(text, max = 28) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s || 'lesson').slice(0, max).replace(/-+$/g, '');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 2) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          out[arg.slice(2)] = next;
          i += 1;
        } else {
          out[arg.slice(2)] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      out[arg.slice(1)] = true;
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function flag(args, ...names) {
  return names.some((name) => Boolean(args[name]));
}

function option(args, names, fallback) {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== true) return args[name];
  }
  return fallback;
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SECRET_PATTERNS = [
  [/(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, '$1***REDACTED***'],
  [/\bsk-[A-Za-z0-9_-]{10,}/g, 'sk-***REDACTED***'],
  [/\b(AKIA|ASIA)[A-Z0-9]{12,}/g, '$1***REDACTED***'],
  [/\bAKID[A-Za-z0-9]{10,}/g, 'AKID***REDACTED***'],
  [/\bLTAI[A-Za-z0-9]{10,}/g, 'LTAI***REDACTED***'],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, 'AIza***REDACTED***'],
  [/\b(xox[baprs]-)[A-Za-z0-9-]{10,}/g, '$1***REDACTED***'],
  [/\b(hf_)[A-Za-z0-9]{20,}/g, '$1***REDACTED***'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{10,}=*/gi, '$1***REDACTED***'],
  [/((?:api[_-]?key|access[_-]?token|secret[_-]?(?:id|key)|token|password|passwd|pwd)\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1***REDACTED***'],
  [/(https?:\/\/[^/\s:@]+:)[^@\s]+@/g, '$1***@'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9._-]+\.[A-Za-z]{2,}/g, '***@***'],
];

/** Remove credentials and e-mail addresses before anything is stored or shown. */
function redact(text) {
  if (text == null) return text;
  let out = String(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function sum(rows, pick) {
  return rows.reduce((acc, row) => acc + (Number(pick(row)) || 0), 0);
}

function groupBy(rows, pick) {
  const map = new Map();
  for (const row of rows) {
    const key = pick(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function bar(value, max, width = 18) {
  const ratio = max > 0 ? clamp(value / max, 0, 1) : 0;
  const filled = Math.round(ratio * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

module.exports = {
  HOME,
  TTY,
  color,
  sha1,
  shortId,
  ensureDir,
  readText,
  readJson,
  writeText,
  writeJson,
  readJsonl,
  writeJsonl,
  appendJsonl,
  listFiles,
  localDay,
  localTime,
  toMs,
  iso,
  parseSince,
  formatDuration,
  shorten,
  homeShort,
  slugify,
  parseArgs,
  flag,
  option,
  escapeHtml,
  redact,
  clamp,
  sum,
  groupBy,
  bar,
};
