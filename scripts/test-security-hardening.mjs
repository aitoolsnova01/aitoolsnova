/**
 * Security regression test for the Cloudflare Pages functions.
 * Exercises: _middleware.js (probe blocking, API rate limit, header hardening),
 * contact.js and subscribe.js (rate limit, origin check, payload sanitization).
 *
 * Run: node scripts/test-security-hardening.mjs
 */
import assert from 'node:assert/strict';
import { onRequest as middleware } from '../functions/_middleware.js';
import { onRequest as contact } from '../functions/api/contact.js';
import { onRequest as subscribe } from '../functions/api/subscribe.js';

let passed = 0;
function ok(name, cond) {
  if (!cond) { console.error(`❌ FAIL: ${name}`); process.exitCode = 1; }
  else { passed++; console.log(`✅ ${name}`); }
}

// ---- middleware helpers -------------------------------------------------
const mkReq = (path, { method = 'GET', origin = null, ip = '203.0.113.9' } = {}) => {
  const h = { 'CF-Connecting-IP': ip };
  if (origin) h['Origin'] = origin;
  return new Request(`https://aitoolsnova.com${path}`, { method, headers: h });
};
const mkCtx = (req, extra = {}) => ({
  request: req,
  env: {},
  ...extra,
});
const nextOk = async () => new Response('next-ok', { status: 200 });

// ---- 1. attack probes blocked -------------------------------------------
for (const p of ['/wp-login.php', '/.env', '/.env.local', '/.git/config', '/xmlrpc.php', '/wp-admin/setup.php', '/phpmyadmin/', '/admin/config.json', '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php', '/cgi-bin/test.cgi', '/backup.sql', '/package.json', '/scripts/cf-fix.sh', '/anything.php']) {
  const res = await middleware(mkCtx(mkReq(p), { next: nextOk }));
  ok(`probe blocked 403: ${p}`, res.status === 403);
}
// legit paths pass through
for (const p of ['/', '/tools/ai-chat.html', '/blog/some-post.html', '/.well-known/security.txt', '/api/gemini']) {
  const res = await middleware(mkCtx(mkReq(p), { next: nextOk }));
  ok(`legit path served: ${p}`, res.status === 200 && (await res.text()) === 'next-ok');
}

// ---- 2. global API rate limit (120/min) ---------------------------------
{
  let last;
  for (let i = 0; i <= 120; i++) {
    last = await middleware(mkCtx(mkReq('/api/gemini', { method: 'POST' }), { next: nextOk }));
  }
  ok('API: 121st request/min -> 429', last.status === 429);
  const other = await middleware(mkCtx(mkReq('/api/gemini', { method: 'POST', ip: '198.51.100.7' }), { next: nextOk }));
  ok('API: other IP unaffected', other.status === 200);
}

// ---- 3. API responses get security headers ------------------------------
{
  // fresh IP — the rate-limit test above exhausted the default IP
  const res = await middleware(mkCtx(mkReq('/api/gemini', { method: 'POST', origin: 'https://aitoolsnova.com', ip: '198.51.100.23' }), { next: nextOk }));
  ok('API: nosniff set', res.headers.get('X-Content-Type-Options') === 'nosniff');
  ok('API: frame denied', res.headers.get('X-Frame-Options') === 'DENY');
  ok('API: no-store', res.headers.get('Cache-Control') === 'no-store');
  ok('API: noindex', /noindex/.test(res.headers.get('X-Robots-Tag') || ''));
  ok('API: sandbox CSP', /sandbox/.test(res.headers.get('Content-Security-Policy') || ''));
  ok('API: ACAO echo for own origin', res.headers.get('Access-Control-Allow-Origin') === 'https://aitoolsnova.com');
  const evil = await middleware(mkCtx(mkReq('/api/gemini', { method: 'POST', origin: 'https://evil.example', ip: '198.51.100.23' }), { next: nextOk }));
  ok('API: foreign origin gets NO ACAO', evil.headers.get('Access-Control-Allow-Origin') === null);
}

// ---- 4. contact endpoint hardening --------------------------------------
const contactCtx = (body, origin, ip = '203.0.113.77') => {
  const h = { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' };
  if (origin) h.Origin = origin;
  return { request: new Request('https://aitoolsnova.com/api/contact', { method: 'POST', headers: h, body: JSON.stringify(body) }), env: { CONTACT: { put: async () => {} } } };
};
const goodMsg = { name: 'Asha', email: 'asha@example.com', subject: 'Hi', message: 'Please help me with the resume tool.', website: '' };

{
  let r = await contact(contactCtx(goodMsg));
  ok('contact: valid message accepted', r.status === 200);
  r = await contact(contactCtx({ ...goodMsg, website: 'http://spam.bot' }));
  ok('contact: honeypot silently swallowed', r.status === 200);
  r = await contact(contactCtx({ ...goodMsg, message: 'short' }));
  ok('contact: short message rejected', r.status === 400);
  r = await contact(contactCtx(goodMsg, 'https://evil.example'));
  ok('contact: foreign origin rejected 403', r.status === 403);
  // rate limit: 5 per 10 min. Fresh IP: 5 pass, the 6th is blocked.
  let codes = [];
  for (let i = 0; i < 5; i++) codes.push((await contact(contactCtx(goodMsg, null, '192.0.2.50'))).status);
  ok('contact: fresh IP within limit', codes.every((c) => c === 200));
  const over = await contact(contactCtx(goodMsg, null, '192.0.2.50'));
  ok('contact: 6th submission in 10min -> 429', over.status === 429);
}

// ---- 5. subscribe endpoint hardening ------------------------------------
const subCtx = (body, origin, ip = '203.0.113.88') => {
  const h = { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' };
  if (origin) h.Origin = origin;
  return { request: new Request('https://aitoolsnova.com/api/subscribe', { method: 'POST', headers: h, body: JSON.stringify(body) }), env: { SUBSCRIBERS: { put: async (k, v) => { subCtx.last = v; } } } };
};
{
  let r = await subscribe(subCtx({ email: 'reader@example.com', source: '/blog/ai-tips.html' }));
  ok('subscribe: valid email accepted', r.status === 200);
  r = await subscribe(subCtx({ email: 'nope', source: '/' }));
  ok('subscribe: bad email rejected', r.status === 400);
  r = await subscribe(subCtx({ email: 'bot@spam.example', source: '/', website: 'x' }));
  ok('subscribe: honeypot silently accepted', r.status === 200);
  r = await subscribe(subCtx({ email: 'a@b.co', source: '/x' }, 'https://evil.example'));
  ok('subscribe: foreign origin rejected 403', r.status === 403);
  // data-dump attempt via source field
  const ctx = subCtx({ email: 'dump@dump.example', source: 'A'.repeat(9000) });
  await subscribe(ctx);
  const stored = JSON.parse(subCtx.last || '{}');
  ok('subscribe: source clamped to 120 chars', String(stored.source).length <= 120);
  ok('subscribe: PII minimized — no IP stored', !('ip' in stored));
  // rate limit
  let last;
  for (let i = 0; i < 6; i++) last = await subscribe(subCtx({ email: 'flood@example.com' }, null, '198.51.100.99'));
  ok('subscribe: 6th signup/min -> 429', last.status === 429);
}

console.log(`\n${process.exitCode ? '❌ SOME CHECKS FAILED' : '🎉 All'} ${passed} security checks ${process.exitCode ? '' : 'passed'}.`);
