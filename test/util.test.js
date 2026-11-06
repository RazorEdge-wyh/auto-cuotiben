'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../src/util.js');

test('redact removes common credential shapes', () => {
  const input = [
    'token=ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz',
    'sk-proj-abcdefghijklmnopqrstuvwxyz',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'api_key: "supersecretvalue"',
    'mail me at someone@example.com',
    'https://user:password123@example.com/path',
  ].join('\n');
  const out = U.redact(input);
  assert.ok(!out.includes('ghp_abcdefghijklmnopqrstuvwxyz1234567890'));
  assert.ok(!out.includes('github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!out.includes('sk-proj-abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!out.includes('supersecretvalue'));
  assert.ok(!out.includes('someone@example.com'));
  assert.ok(!out.includes('password123'));
  assert.ok(out.includes('REDACTED'));
});

test('redact leaves normal text alone', () => {
  const text = '用 pandas 按月份 groupby 后画图，再跑 npm test 验证。';
  assert.equal(U.redact(text), text);
});

test('parseSince understands relative and absolute forms', () => {
  assert.ok(U.parseSince('7d') < Date.now());
  assert.ok(U.parseSince('7d') > Date.now() - 8 * 86400e3);
  assert.ok(U.parseSince('24h') > Date.now() - 25 * 3600e3);
  assert.equal(U.parseSince(''), 0);
  const absolute = U.parseSince('2026-01-01');
  assert.ok(absolute > 0 && absolute < Date.now());
});

test('shortId is stable and compact', () => {
  const a = U.shortId('turn', 'dsh', 'session-1', 3);
  const b = U.shortId('turn', 'dsh', 'session-1', 3);
  const c = U.shortId('turn', 'dsh', 'session-1', 4);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^turn_[a-f0-9]{10}$/);
});

test('slugify produces filesystem-safe ascii', () => {
  assert.equal(U.slugify('Hello World! 你好'), 'hello-world');
  assert.equal(U.slugify('你好'), 'lesson');
  assert.equal(U.slugify('a/b\\c:d*e?f'), 'a-b-c-d-e-f');
});

test('parseArgs handles flags, values and positionals', () => {
  const args = U.parseArgs(['scan', '--since', '7d', '--here', '--sources=dsh,codex', 'extra']);
  assert.equal(args._[0], 'scan');
  assert.equal(args._[1], 'extra');
  assert.equal(args.since, '7d');
  assert.equal(args.here, true);
  assert.equal(args.sources, 'dsh,codex');
});
