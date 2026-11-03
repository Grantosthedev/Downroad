const test = require('node:test');
const assert = require('node:assert/strict');

const {
  _test,
  fetchMediaInfo,
  isInstagramVideoUrl,
  isUsableMediaResult,
} = require('../src/media-fetcher');

const { buildFromOgTags, constrainResultToContentType, extractShortcode, parseEmbeddedInstagramMedia, parseGraphqlMedia } = _test;

function polarisPage({
  code = 'ABC_123',
  videoUrl = 'https://cdninstagram.com/reel-video.mp4',
  imageUrl = 'https://cdninstagram.com/reel-thumbnail.jpg',
  includeVideo = true,
}) {
  const node = {
    code,
    media_type: 2,
    product_type: 'clips',
    user: { username: 'creator' },
    caption: { text: 'A Reel' },
    original_width: 1080,
    original_height: 1920,
    image_versions2: { candidates: [{ url: imageUrl, width: 1080, height: 1920 }] },
  };
  if (includeVideo) {
    node.video_versions = [
      { type: 101, url: 'https://cdninstagram.com/reel-low.mp4' },
      { type: 103, url: videoUrl },
    ];
  }
  return `<script type="application/json">${JSON.stringify({ if_not_gated_logged_out: node })}</script>`;
}

function thumbnailResult() {
  return {
    isCarousel: false,
    items: [{
      type: 'image',
      url: 'https://cdninstagram.com/reel-thumbnail.jpg',
      thumbnail: 'https://cdninstagram.com/reel-thumbnail.jpg',
    }],
  };
}

function videoResult() {
  return {
    isCarousel: false,
    items: [{
      type: 'video',
      url: 'https://cdninstagram.com/reel-video.mp4',
      thumbnail: 'https://cdninstagram.com/reel-thumbnail.jpg',
    }],
  };
}

test('recognizes only Instagram reel-style paths as video URLs', () => {
  assert.equal(isInstagramVideoUrl('https://www.instagram.com/reel/ABC_123/'), true);
  assert.equal(isInstagramVideoUrl('https://instagram.com/reels/ABC_123/'), true);
  assert.equal(isInstagramVideoUrl('https://www.instagram.com/instagram/reel/ABC_123/'), true);
  assert.equal(isInstagramVideoUrl('https://www.instagram.com/tv/ABC_123/'), true);
  assert.equal(isInstagramVideoUrl('https://www.instagram.com/p/ABC_123/'), false);
  assert.equal(isInstagramVideoUrl('https://www.instagram.com/reels/audio/ABC_123/'), false);
  assert.equal(isInstagramVideoUrl('https://example.com/reel/ABC_123/'), false);
});

test('does not accept an image-only result when video is required', () => {
  assert.equal(isUsableMediaResult(thumbnailResult(), true), false);
  assert.equal(isUsableMediaResult(videoResult(), true), true);
  assert.equal(isUsableMediaResult(thumbnailResult(), false), true);
});

test('continues past a GraphQL reel thumbnail to the video extractor', async () => {
  let ytdlpCalls = 0;
  const expectedVideo = videoResult();
  const result = await fetchMediaInfo('https://www.instagram.com/reel/ABC_123/', {
    fetchGraphqlPost: async () => ({ result: thumbnailResult(), pageHtml: '' }),
    ytdlpFetcher: async () => {
      ytdlpCalls++;
      return expectedVideo;
    },
    fetchEmbedData: async () => null,
    httpGet: async () => '',
  });

  assert.equal(ytdlpCalls, 1);
  assert.deepEqual(result, expectedVideo);
});

test('never downgrades a reel to an embed or Open Graph image', async () => {
  const result = await fetchMediaInfo('https://www.instagram.com/reel/ABC_123/', {
    fetchGraphqlPost: async () => ({ result: thumbnailResult(), pageHtml: [
      '<meta property="og:image" content="https://cdninstagram.com/reel-thumbnail.jpg">',
    ].join('') }),
    ytdlpFetcher: async () => null,
    fetchEmbedData: async () => thumbnailResult(),
  });

  assert.equal(result.errorCode, 'instagram-reel-video-unavailable');
  assert.deepEqual(result.items, []);
});

test('keeps the fast GraphQL path for regular Instagram photos', async () => {
  let ytdlpCalls = 0;
  const expectedImage = thumbnailResult();
  const result = await fetchMediaInfo('https://www.instagram.com/p/ABC_123/', {
    fetchGraphqlPost: async () => ({ result: expectedImage, pageHtml: '' }),
    ytdlpFetcher: async () => {
      ytdlpCalls++;
      return videoResult();
    },
  });

  assert.equal(ytdlpCalls, 0);
  assert.deepEqual(result, expectedImage);
});

test('parses current Instagram mobile video metadata as video', () => {
  const result = parseGraphqlMedia({
    media_type: 2,
    taken_at: 1720000000,
    user: { username: 'creator' },
    caption: { text: 'A Reel' },
    image_versions2: {
      candidates: [{ url: 'https://cdn.example/thumb.jpg', width: 1080, height: 1920 }],
    },
    video_versions: [{ url: 'https://cdn.example/reel.mp4', width: 1080, height: 1920 }],
  });

  assert.equal(result.owner, 'creator');
  assert.equal(result.items[0].type, 'video');
  assert.equal(result.items[0].url, 'https://cdn.example/reel.mp4');
  assert.equal(result.items[0].thumbnail, 'https://cdn.example/thumb.jpg');
});

test('parses mixed current Instagram carousel metadata', () => {
  const result = parseGraphqlMedia({
    media_type: 8,
    user: { username: 'creator' },
    carousel_media: [
      {
        media_type: 1,
        image_versions2: { candidates: [{ url: 'https://cdn.example/photo.jpg' }] },
      },
      {
        media_type: 2,
        image_versions2: { candidates: [{ url: 'https://cdn.example/video-thumb.jpg' }] },
        video_versions: [{ url: 'https://cdn.example/video.mp4' }],
      },
    ],
  });

  assert.equal(result.isCarousel, true);
  assert.deepEqual(result.items.map(item => item.type), ['image', 'video']);
  assert.equal(result.items[1].url, 'https://cdn.example/video.mp4');
});

test('reads the embedded Reel file instead of the post cover', async () => {
  let ytdlpCalls = 0;
  const result = await fetchMediaInfo('https://www.instagram.com/p/ABC_123/', {
    fetchGraphqlPost: async () => ({ result: thumbnailResult(), pageHtml: polarisPage({}) }),
    ytdlpFetcher: async () => {
      ytdlpCalls++;
      return thumbnailResult();
    },
    fetchEmbedData: async () => thumbnailResult(),
  });

  assert.equal(ytdlpCalls, 0);
  assert.equal(result.items[0].type, 'video');
  assert.equal(result.items[0].url, 'https://cdninstagram.com/reel-video.mp4');
  assert.equal(result.items[0].thumbnail, 'https://cdninstagram.com/reel-thumbnail.jpg');
});

test('does not save a Reel cover when the embedded post has no video file', async () => {
  const result = await fetchMediaInfo('https://www.instagram.com/instagram/reel/ABC_123/', {
    fetchGraphqlPost: async () => ({
      result: thumbnailResult(),
      pageHtml: polarisPage({ includeVideo: false }),
    }),
    ytdlpFetcher: async () => null,
    fetchEmbedData: async () => thumbnailResult(),
  });

  assert.equal(result.errorCode, 'instagram-reel-video-unavailable');
  assert.deepEqual(result.items, []);
});

test('resolves an Instagram share link before reading the Reel', async () => {
  let graphqlCalls = 0;
  const result = await fetchMediaInfo('https://www.instagram.com/share/BAGsharetoken/', {
    httpGet: async () => ({
      body: `${polarisPage({})}<meta property="og:url" content="https://www.instagram.com/instagram/reel/ABC_123/">`,
      finalUrl: 'https://www.instagram.com/share/BAGsharetoken/',
      headers: {},
    }),
    fetchGraphqlPost: async () => {
      graphqlCalls++;
      return { result: thumbnailResult(), pageHtml: '' };
    },
  });

  assert.equal(graphqlCalls, 0);
  assert.equal(result.items[0].type, 'video');
  assert.equal(result.items[0].url, 'https://cdninstagram.com/reel-video.mp4');
});

test('keeps an embedded photo post as a photo', () => {
  const html = `<script type="application/json">${JSON.stringify({
    if_not_gated_logged_out: {
      code: 'PHOTO123',
      media_type: 1,
      product_type: 'feed',
      user: { username: 'creator' },
      image_versions2: { candidates: [{ url: 'https://cdninstagram.com/photo.jpg', width: 1080 }] },
    },
  })}</script>`;
  const result = parseEmbeddedInstagramMedia(html, 'PHOTO123');
  assert.equal(result.items[0].type, 'image');
  assert.equal(result.items[0].url, 'https://cdninstagram.com/photo.jpg');
  assert.equal(extractShortcode('https://www.instagram.com/share/BAGsharetoken/'), null);
  assert.equal(extractShortcode('https://www.instagram.com/instagram/reel/ABC_123/'), 'ABC_123');
});

test('does not downgrade requested Reel video to an image fallback', () => {
  const imageResult = {
    isCarousel: false,
    items: [{ type: 'image', url: 'https://cdn.example/poster.jpg' }],
  };

  assert.equal(constrainResultToContentType(imageResult, 'video'), null);
  assert.equal(
    buildFromOgTags({ 'og:image': 'https://cdn.example/poster.jpg' }, 'video'),
    null,
  );
});
