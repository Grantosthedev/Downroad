const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectPlatform,
  extractVideoId,
  isTiktokPhotoUrl,
  isValidURL,
  normalizeInstagramURL,
  normalizeTikTokURL,
  normalizeYouTubeURL,
  sanitizeFilename,
} = require('../src/utils');

test('detects supported platforms and rejects unrelated URLs', () => {
  assert.equal(detectPlatform('https://youtu.be/dQw4w9WgXcQ'), 'youtube');
  assert.equal(detectPlatform('https://www.instagram.com/reel/ABC_123/'), 'instagram');
  assert.equal(detectPlatform('https://www.instagram.com/instagram/reel/Chunk8-jurw/'), 'instagram');
  assert.equal(detectPlatform('https://www.tiktok.com/@creator/video/1234567890'), 'tiktok');
  assert.equal(detectPlatform('https://example.com/video'), null);
  assert.equal(isValidURL('https://example.com/video'), false);
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
