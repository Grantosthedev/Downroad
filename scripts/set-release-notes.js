#!/usr/bin/env node
/**
 * Post-publish script: reads RELEASE_NOTES.md and pushes it to the
 * matching GitHub release for the current package version.
 *
 * Runs automatically via the `postpublish` npm script after `npm run publish`.
 * Requires GITHUB_TOKEN in .env (same token used by the publisher).
 */

require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OWNER = 'Grantosthedev';
const REPO = 'Downroad';

if (!GITHUB_TOKEN) {
  console.warn('[release-notes] No GITHUB_TOKEN found in .env — skipping.');
  process.exit(0);
}

const notesPath = path.join(__dirname, '..', 'RELEASE_NOTES.md');
if (!fs.existsSync(notesPath)) {
  console.warn('[release-notes] RELEASE_NOTES.md not found — skipping.');
  process.exit(0);
}

const notes = fs.readFileSync(notesPath, 'utf8').trim();
if (!notes) {
  console.warn('[release-notes] RELEASE_NOTES.md is empty — skipping.');
  process.exit(0);
}

const { version } = require('../package.json');
const tag = `v${version}`;

function ghRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'User-Agent': 'downroad-release-notes',
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function run() {
  // Find the release matching this version tag
  const list = await ghRequest('GET', `/repos/${OWNER}/${REPO}/releases?per_page=10`);
  if (list.status !== 200) {
    console.error(`[release-notes] Failed to list releases: HTTP ${list.status}`);
    process.exit(1);
  }

  const release = list.body.find(r => r.tag_name === tag);
  if (!release) {
    console.warn(`[release-notes] No release found for tag ${tag} — skipping.`);
    process.exit(0);
  }

  const update = await ghRequest('PATCH', `/repos/${OWNER}/${REPO}/releases/${release.id}`, { body: notes });
  if (update.status === 200) {
    const state = release.draft ? 'draft' : 'published';
    console.log(`[release-notes] Updated ${state} release notes for ${tag}.`);
  } else {
    console.error(`[release-notes] Failed to update release: HTTP ${update.status}`, update.body);
    process.exit(1);
  }
}

run().catch(err => {
  console.error('[release-notes] Unexpected error:', err.message);
  process.exit(1);
});
