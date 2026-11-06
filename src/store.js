'use strict';

const path = require('node:path');
const U = require('./util.js');

const DEFAULT_STORE = '.cuotiben';

function defaultConfig() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    dailyMinutes: 15,
    sources: ['dsh', 'codex', 'claude'],
    redact: false,
    note: 'AI 错题本配置文件。sources 控制扫描哪些工具的会话记录。',
  };
}

function storePaths(dir) {
  const root = path.resolve(dir || DEFAULT_STORE);
  return {
    root,
    config: path.join(root, 'config.json'),
    events: path.join(root, 'events.jsonl'),
    cards: path.join(root, 'cards.jsonl'),
    state: path.join(root, 'state.json'),
    lessons: path.join(root, 'lessons'),
    index: path.join(root, 'index.md'),
    hookEvents: path.join(root, 'hook-events.jsonl'),
  };
}

function ensureStore(dir) {
  const paths = storePaths(dir);
  U.ensureDir(paths.root);
  U.ensureDir(paths.lessons);
  if (!U.readJson(paths.config, null)) U.writeJson(paths.config, defaultConfig());
  return paths;
}

function loadStore(dir) {
  const paths = ensureStore(dir);
  return {
    paths,
    config: U.readJson(paths.config, defaultConfig()),
    events: U.readJsonl(paths.events),
    cards: U.readJsonl(paths.cards),
    state: U.readJson(paths.state, { version: 1, files: {} }),
  };
}

function saveEvents(store) {
  U.writeJsonl(store.paths.events, store.events);
}

function saveCards(store) {
  U.writeJsonl(store.paths.cards, store.cards);
}

function saveState(store) {
  U.writeJson(store.paths.state, store.state);
}

function findCard(store, id) {
  if (!id) return null;
  const needle = String(id).trim();
  return (
    store.cards.find((card) => card.id === needle) ||
    store.cards.find((card) => card.id.endsWith(needle)) ||
    store.cards.find((card) => needle.length >= 4 && card.id.includes(needle)) ||
    null
  );
}

function upsert(rows, nextRows, key = 'id') {
  const map = new Map(rows.map((row) => [row[key], row]));
  let added = 0;
  for (const row of nextRows) {
    if (!row || !row[key]) continue;
    if (!map.has(row[key])) added += 1;
    map.set(row[key], row);
  }
  return { rows: [...map.values()], added };
}

module.exports = {
  DEFAULT_STORE,
  defaultConfig,
  storePaths,
  ensureStore,
  loadStore,
  saveEvents,
  saveCards,
  saveState,
  findCard,
  upsert,
};
