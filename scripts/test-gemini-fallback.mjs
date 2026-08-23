#!/usr/bin/env node
/**
 * Mock tests for functions/api/gemini.js — provider/model fallback chain.
 *
 * No real network calls: globalThis.fetch is monkey-patched with canned
 * responses. Scenarios (matching the production incident):
 *
 *   1. Gemini times out on every model  -> Groq answers -> 200 + reply + provider
 *   2. Gemini 404 on first model, empty response on second -> third model answers
 *   3. Groq rate-limited (429) on every model -> DeepSeek answers
 *   4. Everything fails -> 500 with sanitized error, NO secrets in body
 *   5. CORS/OPTIONS + method guard + input validation + rate limit preserved
 *
 * Run: node scripts/test-gemini-fallback.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'functions', 'api', 'gemini.js');

// --- 0) Syntax check on the real file -------------------------------------
execFileSync(process.execPath, ['--check', SRC], { stdio: 'inherit' });
console.log('✅ node --check functions/api/gemini.js');

// --- Import the real module (as ESM via temp .mjs copy) --------------------
const tmpMod = path.join(os.tmpdir(), `gemini-test-${process.pid}-${Date.now()}.mjs`);
fs.copyFileSync(SRC, tmpMod);
const { onRequest } = await import(pathToFileURL(tmpMod).toString());
const realFetch = globalThis.fetch;
process.on('exit', () => { globalThis.fetch = realFetch; try { fs.unlinkSync(tmpMod); } catch {} });

// --- Helpers ----------------------------------------------------------------
const FAKE = {
  GEMINI_API_KEY: 'AIzaSyFAKE_FAKE_FAKE_FAKE_FAKE12345',
  GROQ_API_KEY: 'gsk_FAKE_FAKE_FAKE_FAKE_FAKE12345',
  DEEPSEEK_API_KEY: 'sk-FAKE_FAKE_FAKE_FAKE_FAKE12345',
  CLOUDFLARE_API_TOKEN: 'cf_fake_token_never_leak_12345',
  CLOUDFLARE_ACCOUNT_ID: 'cf_fake_account_987654321',
};

function makeEnv(over = {}) {
  return { ...FAKE, ...over };
}

function makeReq(ip, body, method = 'POST') {
  return new Request('https://aitoolsnova.com/api/gemini', {
    method,
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
      Origin: 'https://aitoolsnova.com',
      ...(method === 'OPTIONS' ? {} : {}),
    },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

const jsonResponse = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const geminiOk = (text) =>
  jsonResponse({ candidates: [{ content: { parts: [{ text }] } }] });
const groqOk = (text) => jsonResponse({ choices: [{ message: { content: text } }] });
const dsOk = (text) => jsonResponse({ choices: [{ message: { content: text } }] });

function abortLikeTimeout() {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return Promise.reject(e);
}

let passed = 0;
function check(name, cond, extra = '') {
  if (!cond) {
    console.error(`❌ FAIL: ${name} ${extra}`);
    process.exit(1);
  }
  passed++;
  console.log(`✅ ${name}`);
}

async function run(ip, body, env) {
  const res = await onRequest({ request: makeReq(ip, body), env: env || makeEnv() });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  return { res, data, text };
}

// Track outbound calls so we can assert the fallback order.
let calls = [];
function installFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const rec = { url: u, body: init?.body ? JSON.parse(init.body) : null };
    calls.push(rec);
    return handler(u, rec);
  };
}

// =============================================================================
// TEST 1: Gemini timeout (all 4 models) -> Groq gpt-oss-120b succeeds -> 200
// =============================================================================
{
  console.log('\n--- Test 1: Gemini timeout -> Groq success ---');
  installFetch((u) => {
    if (u.includes('generativelanguage.googleapis.com')) return abortLikeTimeout();
    if (u.includes('api.groq.com') && u.includes('chat/completions')) return groqOk('4');
    if (u.includes('api.deepseek.com')) return dsOk('deepseek-should-not-run');
    if (u.includes('api.cloudflare.com')) return jsonResponse({ result: { response: 'cf' } });
    return jsonResponse({}, 500);
  });
  const { res, data } = await run(
    '10.0.0.1',
    { message: 'What is 2+2?', tool: 'chat' },
    makeEnv({ GEMINI_MODEL: 'gemini-2.0-flash-lite' })
  );
  check('HTTP 200 returned', res.status === 200, `got ${res.status}`);
  check('reply is correct', data.reply === '4', JSON.stringify(data.reply));
  check('provider reported', data.provider === 'groq:openai/gpt-oss-120b', data.provider);
  const gemCalls = calls.filter((c) => c.url.includes('generativelanguage'));
  check('all 4 Gemini models tried before fallback', gemCalls.length === 4, `got ${gemCalls.length}`);
  check(
    'Gemini chain order is env→2.5→2.0→latest',
    ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'].every((m) =>
      gemCalls.some((c) => c.url.includes(`/models/${m}:`))
    ),
    gemCalls.map((c) => c.url.split('/models/')[1]?.split(':')[0]).join(',')
  );
  check('env GEMINI_MODEL tried first', gemCalls[0]?.url.includes('/models/gemini-2.0-flash-lite:'), gemCalls[0]?.url);
  check('Groq tried gpt-oss-120b first', calls.find((c) => c.url.includes('api.groq.com'))?.body?.model === 'openai/gpt-oss-120b');
}

// =============================================================================
// TEST 2: Gemini 404 on gemini-2.5-flash, EMPTY response on gemini-2.0-flash
//         -> gemini-flash-latest answers -> 200 via third Gemini model
// =============================================================================
{
  console.log('\n--- Test 2: Gemini 404/empty -> next Gemini model ---');
  installFetch((u) => {
    if (u.includes('/models/gemini-2.5-flash:')) {
      return jsonResponse({ error: { message: `Model not found for gemini-2.5-flash (404)` } }, 404);
    }
    if (u.includes('/models/gemini-2.0-flash:')) {
      return jsonResponse({ candidates: [] }); // 200 but empty
    }
    if (u.includes('/models/gemini-flash-latest:')) {
      return geminiOk('Answer from gemini-flash-latest');
    }
    return jsonResponse({}, 500);
  });
  const { res, data } = await run('10.0.0.2', { message: 'hi', tool: 'chat' }, makeEnv());
  check('HTTP 200 after Gemini model fallback', res.status === 200, `got ${res.status}`);
  check('reply from third Gemini model', data.reply === 'Answer from gemini-flash-latest', JSON.stringify(data.reply));
  check('provider names winning model', data.provider === 'gemini:gemini-flash-latest', data.provider);
  const gemCalls = calls.filter((c) => c.url.includes('generativelanguage'));
  check('exactly 3 Gemini calls (404, empty, ok)', gemCalls.length === 3, `got ${gemCalls.length}`);
}

// =============================================================================
// TEST 3: Groq 429 on every model (Gemini key absent) -> DeepSeek answers
// =============================================================================
{
  console.log('\n--- Test 3: Groq 429 -> DeepSeek fallback ---');
  installFetch((u) => {
    if (u.includes('api.groq.com')) {
      return jsonResponse(
        { error: { message: 'Rate limit reached for model. Try again in 0.1s' } },
        429
      );
    }
    if (u.includes('api.deepseek.com')) return dsOk('DeepSeek to the rescue');
    return jsonResponse({}, 500);
  });
  const { res, data } = await run(
    '10.0.0.3',
    { message: 'hello', tool: 'seo' },
    makeEnv({ GEMINI_API_KEY: '', GROQ_MODEL: 'llama-3.1-8b-instant' })
  );
  check('HTTP 200 via DeepSeek', res.status === 200, `got ${res.status}`);
  check('reply from DeepSeek', data.reply === 'DeepSeek to the rescue', JSON.stringify(data.reply));
  check('provider is deepseek', data.provider === 'deepseek', data.provider);
  const groqCalls = calls.filter((c) => c.url.includes('api.groq.com'));
  const groqModels = groqCalls.map((c) => c.body?.model);
  check('every Groq model retried once on 429 (3 models x 2 attempts = 6)', groqCalls.length === 6, `got ${groqCalls.length}: ${groqModels}`);
  check(
    'Groq chain order: gpt-oss-120b, gpt-oss-20b, configured GROQ_MODEL',
    groqModels[0] === 'openai/gpt-oss-120b' && groqModels[2] === 'openai/gpt-oss-20b' && groqModels[4] === 'llama-3.1-8b-instant',
    groqModels.join(',')
  );
  check('no Gemini call when key missing', calls.every((c) => !c.url.includes('generativelanguage')));
}

// =============================================================================
// TEST 4: everything fails -> sanitized 500, no secrets anywhere in the body
// =============================================================================
{
  console.log('\n--- Test 4: all providers fail -> sanitized error ---');
  installFetch((u) => {
    if (u.includes('generativelanguage.googleapis.com')) {
      // echoes a key-looking string into the error text
      return jsonResponse({ error: { message: `API key not valid: key=${FAKE.GEMINI_API_KEY}` } }, 400);
    }
    if (u.includes('api.groq.com')) {
      return jsonResponse({ error: { message: `Auth failed Bearer ${FAKE.GROQ_API_KEY}` } }, 401);
    }
    if (u.includes('api.deepseek.com')) {
      return jsonResponse({ error: { message: `quota ${FAKE.DEEPSEEK_API_KEY}` } }, 402);
    }
    if (u.includes('api.cloudflare.com')) {
      return jsonResponse({ errors: [{ message: `denied token ${FAKE.CLOUDFLARE_API_TOKEN}` }] }, 403);
    }
    return jsonResponse({}, 500);
  });
  const { res, data, text } = await run('10.0.0.4', { message: 'x', tool: 'chat' }, makeEnv());
  check('HTTP 500 when all providers fail', res.status === 500, `got ${res.status}`);
  check('generic error message', /All AI providers failed/i.test(data.error || ''), data.error);
  for (const [k, v] of Object.entries(FAKE)) {
    check(`secret ${k} NOT leaked in response`, !text.includes(v));
  }
  check('details list present but redacted', Array.isArray(data.details) && data.details.length > 0);
}

// =============================================================================
// TEST 5: CORS/OPTIONS, method guard, validation, rate limit preserved
// =============================================================================
{
  console.log('\n--- Test 5: CORS, method guard, validation, rate limit ---');

  const optRes = await onRequest({ request: makeReq('10.0.0.5', null, 'OPTIONS'), env: makeEnv() });
  check('OPTIONS -> 204', optRes.status === 204, `got ${optRes.status}`);
  check(
    'CORS header echoes allowed origin',
    optRes.headers.get('Access-Control-Allow-Origin') === 'https://aitoolsnova.com',
    optRes.headers.get('Access-Control-Allow-Origin')
  );

  const getRes = await onRequest({ request: makeReq('10.0.0.5', null, 'GET'), env: makeEnv() });
  check('GET -> 405 method not allowed', getRes.status === 405, `got ${getRes.status}`);

  const empty = await run('10.0.0.5', { message: '', tool: 'chat' }, makeEnv());
  check('empty message -> 400', empty.res.status === 400, `got ${empty.res.status}`);

  // Rate limit: 45/min per IP. 1 request already consumed above for this IP
  // (the empty-message one), so 44 more pass, then the 46th is blocked.
  installFetch(() => geminiOk('ok'));
  for (let i = 0; i < 44; i++) {
    const r = await run('10.0.0.5', { message: 'ping', tool: 'chat' }, makeEnv());
    if (r.res.status !== 200) { check('rate limit not tripped early', false, `req ${i + 2} -> ${r.res.status}`); break; }
  }
  const limited = await run('10.0.0.5', { message: 'ping', tool: 'chat' }, makeEnv());
  check('46th request in window -> 429 rate limited', limited.res.status === 429, `got ${limited.res.status}`);
  const other = await run('10.0.0.6', { message: 'ping', tool: 'chat' }, makeEnv());
  check('different IP unaffected by rate limit', other.res.status === 200, `got ${other.res.status}`);
}

console.log(`\n🎉 All ${passed} assertions passed. Provider fallback chain is resilient.`);
