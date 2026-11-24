const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  detectPlatform,
  extractVideoId,
  isTiktokPhotoUrl,
  isValidURL,
  isXPhotoUrl,
  normalizeInstagramURL,
  normalizePlatformURL,
  normalizeTikTokURL,
  normalizeXURL,
  normalizeYouTubeURL,
  sanitizeFilename,
} = require('../src/utils');

const SAMPLE_X_URL = 'https://x.com/junglerockres/status/2124952586700591526/video/1?a=dOSEUEp09_ZYR7JRPjs&s=46';

test('detects supported platforms and rejects unrelated URLs', () => {
  assert.equal(detectPlatform('https://youtu.be/dQw4w9WgXcQ'), 'youtube');
  assert.equal(detectPlatform('https://www.instagram.com/reel/ABC_123/'), 'instagram');
  assert.equal(detectPlatform('https://www.instagram.com/instagram/reel/Chunk8-jurw/'), 'instagram');
  assert.equal(detectPlatform('https://www.tiktok.com/@creator/video/1234567890'), 'tiktok');
  assert.equal(detectPlatform(SAMPLE_X_URL), 'x');
  assert.equal(detectPlatform('https://twitter.com/i/web/status/910031516746514432'), 'x');
  assert.equal(detectPlatform('https://x.com/i/status/2124952586700591526'), 'x');
  assert.equal(detectPlatform('https://mobile.twitter.com/junglerockres/status/2124952586700591526'), 'x');
  assert.equal(detectPlatform('https://fxtwitter.com/junglerockres/status/2124952586700591526/video/1'), 'x');
  assert.equal(detectPlatform('https://t.co/AbC123'), 'x');
  assert.equal(detectPlatform('https://x.com/junglerockres'), null);
  assert.equal(detectPlatform('https://x.com/junglerockres/status/2124952586700591526/retweets'), null);
  assert.equal(detectPlatform('https://notx.com/junglerockres/status/2124952586700591526'), null);
  assert.equal(detectPlatform('https://example.com/video'), null);
  assert.equal(isValidURL(SAMPLE_X_URL), true);
  assert.equal(isValidURL('https://example.com/video'), false);
});

test('normalizes X posts and keeps the selected video', () => {
  assert.equal(
    normalizeXURL(SAMPLE_X_URL),
    'https://x.com/junglerockres/status/2124952586700591526/video/1',
  );
  assert.equal(
    normalizeXURL('https://mobile.twitter.com/junglerockres/status/2124952586700591526/?s=46'),
    'https://x.com/junglerockres/status/2124952586700591526',
  );
  assert.equal(
    normalizeXURL('https://www.fxtwitter.com/junglerockres/status/2124952586700591526/video/2/'),
    'https://x.com/junglerockres/status/2124952586700591526/video/2',
  );
  assert.equal(normalizeXURL('https://www.t.co/AbC123/?s=46'), 'https://t.co/AbC123/');
  assert.equal(normalizeXURL('https://example.com/status/1?s=46'), 'https://example.com/status/1?s=46');
  assert.equal(
    normalizePlatformURL(SAMPLE_X_URL, 'x'),
    'https://x.com/junglerockres/status/2124952586700591526/video/1',
  );
  assert.equal(isXPhotoUrl('https://x.com/junglerockres/status/2124952586700591526/photo/1'), true);
  assert.equal(isXPhotoUrl(SAMPLE_X_URL), false);
});

test('renderer uses the same X URL matcher as the main process', () => {
  const pattern = /const X_URL_REGEX = (.+);/;
  const utilsSource = fs.readFileSync(path.join(__dirname, '../src/utils.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  assert.equal(utilsSource.match(pattern)[1], rendererSource.match(pattern)[1]);
});

test('normalizes supported URLs without changing unsupported hosts', () => {
  assert.equal(extractVideoId('https://youtube.com/watch?v=dQw4w9WgXcQ&t=30'), 'dQw4w9WgXcQ');
  assert.equal(
    normalizeYouTubeURL('https://youtu.be/dQw4w9WgXcQ?t=30'),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  );
  assert.equal(
    normalizeInstagramURL('https://instagram.com/reels/ABC_123/?utm_source=test'),
    'https://www.instagram.com/reel/ABC_123/',
  );
  assert.equal(
    normalizeInstagramURL('https://www.instagram.com/reel/DbKz_FIMK3C/?utm_source=ig_web_copy_link&igsh=tracking'),
    'https://www.instagram.com/reel/DbKz_FIMK3C/',
  );
  assert.equal(
    normalizeInstagramURL('https://www.instagram.com/p/DbKz_FIMK3C/?img_index=2&igsh=tracking'),
    'https://www.instagram.com/p/DbKz_FIMK3C/?img_index=2',
  );
  assert.equal(
    normalizeInstagramURL('https://www.instagram.com/instagram/reel/Chunk8-jurw/?igsh=tracking'),
    'https://www.instagram.com/reel/Chunk8-jurw/',
  );
  assert.equal(
    normalizeInstagramURL('https://www.instagram.com/instagram/reels/Chunk8-jurw/'),
    'https://www.instagram.com/reel/Chunk8-jurw/',
  );
  assert.equal(
    normalizeTikTokURL('https://www.tiktok.com/@creator/video/7660967336047807758?q=search&t=123#comments'),
    'https://www.tiktok.com/@creator/video/7660967336047807758',
  );
  assert.equal(
    normalizeTikTokURL('https://vt.tiktok.com/ABC123/?_r=1'),
    'https://vt.tiktok.com/ABC123/',
  );
  assert.equal(normalizeInstagramURL('https://example.com/reels/ABC/'), 'https://example.com/reels/ABC/');
  assert.equal(normalizeTikTokURL('https://example.com/video/123?q=test'), 'https://example.com/video/123?q=test');
});

test('identifies TikTok photo posts and creates safe filenames', () => {
  assert.equal(isTiktokPhotoUrl('https://www.tiktok.com/@creator/photo/1234567890'), true);
  assert.equal(sanitizeFilename('../bad:name?.mp4 '), '-bad-name-.mp4');
  assert.equal(sanitizeFilename('...'), 'download');
});
