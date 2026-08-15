#!/usr/bin/env node
/**
 * Google Indexing API - submit ALL sitemap URLs to Google automatically.
 * Dependency-free (uses Node's built-in crypto for the RS256 JWT).
 *
 * ONE-TIME SETUP (see GOOGLE_INDEXING_SETUP.md):
 *   1. Create a Google Cloud service account, enable "Indexing API".
 *   2. Download its JSON key.
 *   3. In Search Console, add the service-account email as an OWNER of the
 *      verified property.
 *
 * RUN:
 *   GOOGLE_SERVICE_ACCOUNT_JSON='<paste full json>' node scripts/google-index-all.mjs
 *   # or
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/key.json node scripts/google-index-all.mjs
 *
 * Note: Google's daily quota is ~200 URLs/day per project.
 */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const SITE = 'https://aitoolsnova.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PUBLISH_URL = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const SCOPE = 'https://www.googleapis.com/auth/indexing';

function loadCreds() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (p) return JSON.parse(readFileSync(p, 'utf-8'));
  throw new Error('Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS');
}

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function signJwt(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: creds.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const sig = b64url(signer.sign(creds.private_key));
  return `${header}.${claim}.${sig}`;
}

async function getAccessToken(creds) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signJwt(creds),
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data));
  return data.access_token;
}

async function publish(token, url) {
  const res = await fetch(PUBLISH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, type: 'URL_UPDATED' }),
  });
  return res.status;
}

async function main() {
  const creds = loadCreds();
  const xml = await fs.readFile(path.join(ROOT, 'sitemap.xml'), 'utf-8');
  const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
  if (!urls.length) throw new Error('No URLs in sitemap.xml');

  const token = await getAccessToken(creds);
  console.log(`Got access token. Submitting ${urls.length} URLs to Google...`);

  let ok = 0, fail = 0;
  for (const u of urls) {
    const status = await publish(token, u);
    if (status === 200) { ok++; } else { fail++; console.warn(`  ${status} ${u}`); }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`✅ Google Indexing: ${ok} accepted, ${fail} failed (of ${urls.length}).`);
  if (fail) console.log('If many failed with 429, you hit the ~200/day quota - run again tomorrow.');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
