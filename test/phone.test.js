const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {
  contentDisposition,
  decoratePhoneUrl,
  lanAddresses,
  normalizeSupportedUrl,
  phoneLinks,
  readLaunchHash,
  safeDownloadName,
} = require('../src/phone/policy');
const { listenPhoneServer, phonePortCandidates, startPhoneServer } = require('../src/phone/server');
const { createPhoneEngine } = require('../src/phone/engine');

const TOKEN = 'phone-test-token-0123456789abcdef';

function request(port, { method = 'GET', path: requestPath = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers: { host: `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function jsonHeaders(extra = {}) {
  return {
    'content-type': 'application/json',
    'x-downroad-key': TOKEN,
    ...extra,
  };
}

async function startTestServer(engine, extra = {}) {
  const server = await startPhoneServer({
    token: TOKEN,
    engine,
    interfaces: { lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] },
    ...extra,
  });
  return server;
}

test('normalizes supported links and drops anything else', () => {
  assert.equal(
    normalizeSupportedUrl('https://youtu.be/dQw4w9WgXcQ;rm -rf /')?.url,
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  );
  assert.equal(normalizeSupportedUrl('http://127.0.0.1/admin'), null);
  assert.equal(normalizeSupportedUrl('file:///etc/passwd'), null);
  assert.equal(normalizeSupportedUrl('https://169.254.169.254/latest'), null);
  assert.equal(
    normalizeSupportedUrl('https://www.instagram.com/reel/AbC123/?igsh=tracking')?.platform,
    'instagram',
  );
});

test('builds a phone link without advertising localhost', () => {
  const empty = phoneLinks({ port: 47321, token: TOKEN, addresses: [] });
  assert.equal(empty.reachable, false);
  assert.match(empty.warning, /Wi-Fi/);

  const links = phoneLinks({ port: 47321, token: TOKEN, addresses: ['192.168.1.20', '10.0.0.8'] });
  assert.equal(links.primaryUrl, `http://192.168.1.20:47321/#k=${TOKEN}`);
  const decorated = decoratePhoneUrl(links.primaryUrl, { mode: 'professional', theme: 'light' });
  const launch = readLaunchHash(new URL(decorated).hash);
  assert.equal(launch.key, TOKEN);
  assert.equal(launch.mode, 'professional');
  assert.equal(launch.theme, 'light');
  assert.equal(decoratePhoneUrl(links.primaryUrl, { mode: 'nope', theme: 'sepia' }).includes('m=unhinged'), true);
});

test('ranks private addresses and keeps download names safe', () => {
  assert.deepEqual(lanAddresses({
    wifi: [{ family: 'IPv4', internal: false, address: '10.1.1.1' }],
    ether: [{ family: 'IPv4', internal: false, address: '192.168.0.5' }],
    vpn: [{ family: 'IPv4', internal: false, address: '8.8.8.8' }],
    local: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    link: [{ family: 'IPv4', internal: false, address: '169.254.1.1' }],
  }), ['192.168.0.5', '10.1.1.1']);
  assert.deepEqual(lanAddresses({
    wifi: [{ family: 'IPv4', internal: false, address: '192.168.1.9' }],
    weird: { address: '10.0.0.1' },
    empty: null,
  }), ['192.168.1.9']);
  assert.deepEqual(phonePortCandidates(8790)[0], 8790);
  assert.equal(phonePortCandidates(80).includes(80), false);

  const name = safeDownloadName('bad "name"\r\n', 'mp4');
  assert.equal(name.includes('"'), false);
  assert.equal(name.includes('\n'), false);
  assert.equal(contentDisposition(name).includes('\n'), false);
  assert.match(contentDisposition('café.mp4'), /filename\*=UTF-8''/);
});

test('a weird interface list still serves the page', async () => {
  const server = await startPhoneServer({
    token: TOKEN,
    host: '127.0.0.1',
    interfaces: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
    engine: {
      inspect: async () => ({ title: 'x' }),
      download: async () => { throw new Error('no'); },
    },
  });
  try {
    const page = await request(server.port, { path: '/' });
    assert.equal(page.status, 200);
    assert.equal(server.snapshot().reachable, false);
  } finally {
    await server.close();
  }
});

test('phone page is locked without the key and ignores other hosts', async () => {
  let calls = 0;
  const server = await startTestServer({
    inspect: async () => { calls += 1; return { title: 'Nope' }; },
    download: async () => { throw new Error('should not download'); },
  });
  try {
    const page = await request(server.port, { path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.body.toString('utf8'), /Downroad/);
    assert.equal(page.body.includes(TOKEN), false);
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);

    const locked = await request(server.port, {
      method: 'POST',
      path: '/api/inspect',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://youtu.be/dQw4w9WgXcQ' }),
    });
    assert.equal(locked.status, 401);
    assert.equal(calls, 0);

    const foreign = await request(server.port, {
      method: 'POST',
      path: '/api/inspect',
      headers: jsonHeaders({ host: 'evil.example' }),
      body: JSON.stringify({ url: 'https://youtu.be/dQw4w9WgXcQ' }),
    });
    assert.equal(foreign.status, 403);

    const crossSite = await request(server.port, {
      path: '/phone.js',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(crossSite.status, 403);

    const openedFromMessages = await request(server.port, {
      path: '/',
      headers: {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    });
    assert.equal(openedFromMessages.status, 200);

    const missing = await request(server.port, { path: '/../../package.json' });
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test('inspect hides media URLs and a finished job streams the file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downroad-phone-'));
  const filePath = path.join(dir, 'clip.mp4');
  fs.writeFileSync(filePath, 'hello-phone');
  const seen = [];
  let thumbs = 0;
  const server = await startTestServer({
    inspect: async (url) => {
      seen.push(url);
      return {
        title: 'A very good clip',
        duration: 12,
        platform: 'youtube',
        mediaType: 'video',
        uploader: 'Tester',
        qualities: [{ label: '1080p', height: 1080 }],
        thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        items: [],
      };
    },
    download: async (options) => {
      seen.push(options);
      return {
        filePath,
        title: 'bad "name"\r\n',
        format: 'mp4',
        fileSize: 11,
        platform: 'youtube',
        mediaType: 'video',
      };
    },
  }, {
    fetchImpl: async (url) => {
      thumbs += 1;
      assert.equal(url, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
      return {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
        body: Buffer.from('jpeg'),
      };
    },
  });

  try {
    const infoResponse = await request(server.port, {
      method: 'POST',
      path: '/api/inspect',
      headers: jsonHeaders(),
      body: JSON.stringify({ url: 'https://youtu.be/dQw4w9WgXcQ?t=3' }),
    });
    assert.equal(infoResponse.status, 200);
    const info = JSON.parse(infoResponse.body.toString('utf8'));
    assert.equal(seen[0], 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(info.title, 'A very good clip');
    assert.equal(info.qualities[0].label, '1080p');
    assert.match(info.thumb, /^\/api\/thumbs\/[a-f0-9]{32}$/);
    assert.equal(JSON.stringify(info).includes('ytimg'), false);
    assert.equal(JSON.stringify(info).includes('thumbnailUrl'), false);

    const thumb = await request(server.port, { path: info.thumb });
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers['content-type'], 'image/jpeg');
    assert.equal(thumbs, 1);

    const badThumb = await startTestServer({
      inspect: async () => ({ title: 'x', thumbnailUrl: 'https://127.0.0.1/secret' }),
      download: async () => { throw new Error('no'); },
    });
    try {
      const hidden = await request(badThumb.port, {
        method: 'POST',
        path: '/api/inspect',
        headers: jsonHeaders(),
        body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
      });
      const hiddenInfo = JSON.parse(hidden.body.toString('utf8'));
      assert.equal(hiddenInfo.thumb, '');
    } finally {
      await badThumb.close();
    }

    const created = await request(server.port, {
      method: 'POST',
      path: '/api/jobs',
      headers: jsonHeaders(),
      body: JSON.stringify({
        url: 'https://youtu.be/dQw4w9WgXcQ',
        quality: '1080',
        startTime: '00:00:01',
        endTime: '00:00:05',
        outputDir: '/etc',
      }),
    });
    assert.equal(created.status, 202);
    const { id } = JSON.parse(created.body.toString('utf8'));
    assert.equal(seen[1].quality, '1080');
    assert.equal(seen[1].outputDir, undefined);
    assert.equal(seen[1].startTime, '00:00:01');

    let job;
    for (let i = 0; i < 10; i += 1) {
      const status = await request(server.port, {
        path: `/api/jobs/${id}`,
        headers: jsonHeaders(),
      });
      job = JSON.parse(status.body.toString('utf8'));
      if (job.status === 'ready' || job.status === 'error') break;
    }
    assert.equal(job.status, 'ready');
    assert.equal(job.filename.includes('"'), false);

    const file = await request(server.port, { path: `/api/jobs/${id}/file` });
    assert.equal(file.status, 200);
    assert.equal(file.body.toString('utf8'), 'hello-phone');
    assert.match(file.headers['content-disposition'], /^attachment;/);
    assert.equal(file.headers['x-content-type-options'], 'nosniff');

    const partial = await request(server.port, {
      path: `/api/jobs/${id}/file`,
      headers: { range: 'bytes=0-4' },
    });
    assert.equal(partial.status, 206);
    assert.equal(partial.body.toString('utf8'), 'hello');

    const backwards = await request(server.port, {
      method: 'POST',
      path: '/api/jobs',
      headers: jsonHeaders(),
      body: JSON.stringify({
        url: 'https://youtu.be/dQw4w9WgXcQ',
        startTime: '00:00:09',
        endTime: '00:00:01',
      }),
    });
    assert.equal(backwards.status, 400);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('thumbnail redirects cannot leave the image hosts', async () => {
  const fetched = [];
  const server = await startTestServer({
    inspect: async () => ({
      title: 'Preview',
      platform: 'youtube',
      thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    }),
    download: async () => { throw new Error('no'); },
  }, {
    fetchImpl: async (url) => {
      fetched.push(url);
      return {
        status: 302,
        headers: { location: 'http://127.0.0.1/secret' },
      };
    },
  });
  try {
    const info = JSON.parse((await request(server.port, {
      method: 'POST',
      path: '/api/inspect',
      headers: jsonHeaders(),
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
    })).body.toString('utf8'));
    const thumb = await request(server.port, { path: info.thumb });
    assert.equal(thumb.status, 404);
    assert.deepEqual(fetched, ['https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg']);
  } finally {
    await server.close();
  }
});

test('non-YouTube quality stays best and bad links never reach the engine', async () => {
  const seen = [];
  const server = await startTestServer({
    inspect: async () => { throw Object.assign(new Error('This video is private.'), { code: 'private_content' }); },
    download: async (options) => { seen.push(options); return { filePath: '', title: 'x' }; },
  });
  try {
    const bad = await request(server.port, {
      method: 'POST',
      path: '/api/jobs',
      headers: jsonHeaders(),
      body: JSON.stringify({ url: 'http://localhost:9/secret' }),
    });
    assert.equal(bad.status, 400);
    assert.equal(seen.length, 0);

    const tiktok = await request(server.port, {
      method: 'POST',
      path: '/api/jobs',
      headers: jsonHeaders(),
      body: JSON.stringify({
        url: 'https://www.tiktok.com/@creator/video/1234567890',
        quality: '1080',
        startTime: '00:00:01',
      }),
    });
    assert.equal(tiktok.status, 202);
    assert.equal(seen[0].quality, 'best');
    assert.equal(seen[0].startTime, '');

    const privateVideo = await request(server.port, {
      method: 'POST',
      path: '/api/inspect',
      headers: jsonHeaders(),
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
    });
    assert.equal(privateVideo.status, 422);
    assert.match(privateVideo.body.toString('utf8'), /private/);
  } finally {
    await server.close();
  }
});

test('engine retries YouTube once, saves Instagram photos directly, and cancels', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downroad-engine-'));
  try {
    const photos = createPhoneEngine({
      getOutputDir: () => dir,
      checkDiskSpace: async () => 1024 * 1024 * 1024,
      fetchVideoInfo: async () => { throw new Error('use media info'); },
      fetchMediaInfo: async () => ({
        isCarousel: true,
        owner: 'ada',
        caption: 'two photos',
        items: [
          { type: 'image', url: 'https://cdn.example/one.jpg', thumbnail: 'https://cdn.example/one.jpg' },
          { type: 'video', url: 'https://cdn.example/two.mp4' },
        ],
      }),
      downloadImage: async (url, outputDir, filename) => {
        const filePath = path.join(outputDir, `${filename}.jpg`);
        fs.writeFileSync(filePath, url);
        return { filePath, fileSize: url.length };
      },
      startDownload: () => { throw new Error('photos should not use yt-dlp'); },
    });

    const info = await photos.inspect('https://www.instagram.com/p/AbC123/');
    assert.equal(info.items.length, 2);
    assert.equal(info.items[0].url, undefined);
    const saved = await photos.download({
      url: 'https://www.instagram.com/p/AbC123/',
      platform: 'instagram',
      quality: 'best',
      itemIndex: 0,
    }, () => {}, new AbortController().signal);
    assert.match(saved.filePath, /\.jpg$/);
    assert.equal(fs.readFileSync(saved.filePath, 'utf8'), 'https://cdn.example/one.jpg');

    const live = createPhoneEngine({
      getOutputDir: () => dir,
      fetchVideoInfo: async () => ({ title: 'Live now', isLive: true, platform: 'youtube' }),
    });
    await assert.rejects(
      live.inspect('https://www.youtube.com/watch?v=abcdefghijk'),
      (error) => error.code === 'live',
    );

    const calls = [];
    let attempts = 0;
    const recorded = createPhoneEngine({
      getOutputDir: () => dir,
      checkDiskSpace: async () => 1024 * 1024 * 1024,
      fetchVideoInfo: async () => ({ title: 'Recorded', duration: 4, platform: 'youtube', isLive: false }),
      startDownload: (options, _progress, onComplete, onError) => {
        attempts += 1;
        calls.push(options.recoveryArgs);
        if (attempts === 1) onError('forbidden', { code: 'access_forbidden' });
        else {
          const filePath = path.join(dir, 'video.mp4');
          fs.writeFileSync(filePath, 'video');
          onComplete(filePath);
        }
        return { kill() {} };
      },
      ensureYoutubeRecovery: async () => ['recovered'],
      isYoutubeRecoveryError: (error) => error?.code === 'access_forbidden',
    });
    const video = await recorded.download({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      platform: 'youtube',
      quality: 'best',
    }, () => {}, new AbortController().signal);
    assert.equal(video.format, 'mp4');
    assert.deepEqual(calls, [[], ['recovered']]);

    const controller = new AbortController();
    let killed = false;
    const cancellable = createPhoneEngine({
      getOutputDir: () => dir,
      checkDiskSpace: async () => 1024 * 1024 * 1024,
      fetchVideoInfo: async () => ({ title: 'Recorded', platform: 'youtube' }),
      startDownload: () => {
        const proc = { kill() { killed = true; } };
        setTimeout(() => controller.abort(), 20);
        return proc;
      },
      isYoutubeRecoveryError: () => false,
    });
    await assert.rejects(
      cancellable.download({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        platform: 'youtube',
        quality: 'best',
      }, () => {}, controller.signal),
      (error) => error.code === 'cancelled',
    );
    assert.equal(killed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a busy phone port falls through and old jobs expire', async () => {
  const blocker = http.createServer((_req, res) => res.end('busy'));
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const taken = blocker.address().port;
  let clock = 1_000_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downroad-phone-expire-'));
  const filePath = path.join(dir, 'clip.mp4');
  fs.writeFileSync(filePath, 'still-here');
  const server = await listenPhoneServer({
    token: TOKEN,
    host: '127.0.0.1',
    interfaces: { lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] },
    now: () => clock,
    engine: {
      inspect: async () => ({ title: 'Later' }),
      download: async () => ({ filePath, title: 'Later', format: 'mp4', fileSize: 10 }),
    },
  }, [taken, 0]);
  try {
    assert.notEqual(server.port, taken);
    const created = await request(server.port, {
      method: 'POST',
      path: '/api/jobs',
      headers: jsonHeaders(),
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
    });
    const first = JSON.parse(created.body.toString('utf8')).id;
    let ready = false;
    for (let i = 0; i < 10 && !ready; i += 1) {
      const status = JSON.parse((await request(server.port, {
        path: `/api/jobs/${first}`,
        headers: jsonHeaders(),
      })).body.toString('utf8'));
      ready = status.status === 'ready';
    }
    assert.equal(ready, true);
    clock += 31 * 60 * 1000;
    const second = await request(server.port, {
      method: 'POST',
      path: '/api/jobs',
      headers: jsonHeaders(),
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
    });
    assert.equal(second.status, 202);
    const gone = await request(server.port, { path: `/api/jobs/${first}/file` });
    assert.equal(gone.status, 409);
  } finally {
    await server.close();
    await new Promise((resolve) => blocker.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
