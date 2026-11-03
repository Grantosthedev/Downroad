const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildDownloadArgs,
  buildInfoArgs,
  chooseInstagramFileUrl,
  chooseInstagramVideoUrl,
  contextualizeDiagnosis,
  diagnoseYtdlpError,
  youtubeRuntimeArgs,
} = require('../src/ytdlp');

function executable(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downroad-deno-'));
  const file = path.join(dir, 'deno');
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

test('distinguishes 403 access rejection from actual 429 rate limiting', () => {
  const forbidden = diagnoseYtdlpError('ERROR: unable to download video data: HTTP Error 403: Forbidden');
  assert.equal(forbidden.code, 'access_forbidden');
  assert.equal(forbidden.httpStatus, 403);
  assert.doesNotMatch(forbidden.message, /rate.?limit/i);

  const limited = diagnoseYtdlpError('ERROR: HTTP Error 429: Too Many Requests');
  assert.equal(limited.code, 'rate_limited');
  assert.equal(limited.httpStatus, 429);
  assert.match(limited.message, /rate-limiting/i);
});

test('prioritizes actionable runtime and token evidence over a trailing 403', () => {
  const runtime = diagnoseYtdlpError([
    'WARNING: No supported JavaScript runtime could be found.',
    'ERROR: HTTP Error 403: Forbidden',
  ].join('\n'));
  assert.equal(runtime.code, 'js_runtime_missing');

  const token = diagnoseYtdlpError([
    'WARNING: GVS PO Token was not provided.',
    'ERROR: HTTP Error 403: Forbidden',
  ].join('\n'));
  assert.equal(token.code, 'po_token_required');
});

test('identifies TikTok verification challenges without blaming YouTube', () => {
  const diagnosis = diagnoseYtdlpError([
    '[TikTok] Solving JS challenge using native Python implementation',
    '[TikTok] Downloading webpage with challenge cookie',
    'ERROR: [TikTok] 7660967336047807758: Unable to extract universal data for rehydration',
  ].join('\n'));

  assert.equal(diagnosis.code, 'tiktok_challenge');
  assert.match(diagnosis.message, /TikTok blocked/i);
  assert.doesNotMatch(diagnosis.message, /YouTube|player/i);
});

test('recognizes TikTok sigi failures and prioritizes a terminal 403', () => {
  const sigi = diagnoseYtdlpError('ERROR: [TikTok] 123: Unable to extract sigi state');
  assert.equal(sigi.code, 'tiktok_challenge');
  assert.doesNotMatch(sigi.message, /YouTube/i);

  const forbidden = diagnoseYtdlpError([
    'WARNING: [TikTok] 123: Unable to extract sigi state',
    'ERROR: HTTP Error 403: Forbidden',
  ].join('\n'));
  assert.equal(forbidden.code, 'access_forbidden');
  assert.equal(forbidden.httpStatus, 403);
});

test('does not treat an unrelated bare Forbidden string as platform rate limiting', () => {
  const result = diagnoseYtdlpError('ERROR: Permission denied: Forbidden to write file');
  assert.equal(result.code, 'upstream_error');
  assert.doesNotMatch(result.message, /rate.?limit/i);
});

test('injects the bundled Deno runtime only into YouTube operations', (t) => {
  const deno = executable(t);
  assert.deepEqual(youtubeRuntimeArgs('youtube', deno), ['--js-runtimes', `deno:${deno}`]);
  assert.deepEqual(youtubeRuntimeArgs('instagram', deno), []);

  const infoArgs = buildInfoArgs({
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    platform: 'youtube',
    ffmpegPath: '/tmp/ffmpeg',
    denoPath: deno,
  });
  assert.ok(infoArgs.includes(`deno:${deno}`));
  assert.equal(infoArgs.includes('--no-warnings'), false);
});

test('keeps YouTube client selection under yt-dlp control', (t) => {
  const deno = executable(t);
  const args = buildDownloadArgs({
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    quality: '1080',
    outputPath: '/tmp',
    title: 'Video',
    ffmpegDir: '/tmp',
    platform: 'youtube',
    denoPath: deno,
  });

  assert.ok(args.includes(`deno:${deno}`));
  assert.equal(args.includes('--no-warnings'), false);
  assert.equal(args.some(arg => /player[_-]client/.test(arg)), false);
  assert.equal(args.some(arg => /android_vr|web_embedded/.test(arg)), false);
});

test('adds automatic recovery arguments only to YouTube operations', (t) => {
  const deno = executable(t);
  const recoveryArgs = [
    '--plugin-dirs', '/tmp/plugins',
    '--extractor-args', 'youtube:player_client=mweb',
  ];

  const youtubeArgs = buildInfoArgs({
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    platform: 'youtube',
    ffmpegPath: '/tmp/ffmpeg',
    denoPath: deno,
    recoveryArgs,
  });
  const instagramArgs = buildInfoArgs({
    url: 'https://www.instagram.com/reel/example/',
    platform: 'instagram',
    ffmpegPath: '/tmp/ffmpeg',
    denoPath: deno,
    recoveryArgs,
  });

  assert.ok(youtubeArgs.includes('/tmp/plugins'));
  assert.ok(youtubeArgs.includes('youtube:player_client=mweb'));
  assert.equal(instagramArgs.includes('/tmp/plugins'), false);
});

test('does not download a Reel cover when the file URL is a photo', () => {
  const coverOnly = {
    url: 'https://cdninstagram.com/reel-cover.jpg',
    thumbnail: 'https://cdninstagram.com/reel-cover.jpg',
    duration: 5,
    ext: 'jpg',
  };
  assert.equal(chooseInstagramVideoUrl(coverOnly), '');
  assert.equal(chooseInstagramFileUrl(coverOnly), 'https://cdninstagram.com/reel-cover.jpg');

  const withVideo = {
    ...coverOnly,
    formats: [
      { url: 'https://cdninstagram.com/reel-cover.jpg', ext: 'jpg', vcodec: 'none' },
      { url: 'https://cdninstagram.com/reel-video.mp4', ext: 'mp4', vcodec: 'avc1' },
    ],
  };
  assert.equal(chooseInstagramFileUrl(withVideo), 'https://cdninstagram.com/reel-video.mp4');
});

test('reports a final playback rejection without asking for cookies', () => {
  const diagnosis = diagnoseYtdlpError('Sign in to confirm you’re not a bot');
  assert.match(contextualizeDiagnosis(diagnosis).message, /automatic recovery/i);
  assert.doesNotMatch(contextualizeDiagnosis(diagnosis).message, /cookie|connect/i);
});
