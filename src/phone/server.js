const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const {
  JOB_ID,
  THUMB_ID,
  clipTimesAreOrdered,
  contentDisposition,
  isThumbHost,
  isValidClock,
  isValidQuality,
  keysMatch,
  lanAddresses,
  normalizeSupportedUrl,
  phoneLinks,
  safeDownloadName,
} = require('./policy');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 8192;
const MAX_JOBS = 8;
const MAX_ACTIVE = 2;
const MAX_THUMB_BYTES = 4 * 1024 * 1024;
const INSPECTS_PER_MINUTE = 30;
const FINISHED_JOB_MS = 30 * 60 * 1000;
const PHONE_PORT_START = 8787;
const PHONE_PORT_END = 8796;

const STATIC_FILES = {
  '/': { file: path.join(PUBLIC_DIR, 'index.html'), type: 'text/html; charset=utf-8' },
  '/index.html': { file: path.join(PUBLIC_DIR, 'index.html'), type: 'text/html; charset=utf-8' },
  '/phone.css': { file: path.join(PUBLIC_DIR, 'phone.css'), type: 'text/css; charset=utf-8' },
  '/phone.js': { file: path.join(PUBLIC_DIR, 'phone.js'), type: 'text/javascript; charset=utf-8' },
  '/assets/icons.css': {
    file: path.join(__dirname, '..', 'renderer', 'fonts', 'hugeicons', 'icons.css'),
    type: 'text/css; charset=utf-8',
  },
  '/assets/hgi-stroke-rounded.woff2': {
    file: path.join(__dirname, '..', 'renderer', 'fonts', 'hugeicons', 'hgi-stroke-rounded.woff2'),
    type: 'font/woff2',
  },
  '/assets/Ligconsolata-Bold.woff': {
    file: path.join(__dirname, '..', 'renderer', 'fonts', 'Ligconsolata-Bold.woff'),
    type: 'font/woff',
  },
  '/assets/sticker.png': {
    file: path.join(__dirname, '..', 'renderer', 'stickers', 'Default.png'),
    type: 'image/png',
  },
  '/assets/icon.png': {
    file: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    type: 'image/png',
  },
};

function startPhoneServer({
  token,
  engine,
  port = 0,
  host = '0.0.0.0',
  interfaces = null,
  fetchImpl = defaultFetch,
  now = () => Date.now(),
} = {}) {
  if (!token || !engine) throw new Error('Phone server needs a token and a download engine.');

  const jobs = new Map();
  const thumbs = new Map();
  const inspectTimes = [];
  const queue = [];
  let active = 0;
  let thumbFetches = 0;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) return;
      sendJson(res, 500, { error: 'The phone link broke for a second. Try again.', code: 'server' });
      console.error('[phone] request failed:', error && error.message ? error.message : error);
    });
  });

  function snapshot() {
    const addresses = lanAddresses(interfaces || require('os').networkInterfaces());
    const links = phoneLinks({ port: server.address() ? server.address().port : port, token, addresses });
    return { running: server.listening, port: server.address()?.port || null, ...links };
  }

  function allowedHosts() {
    const currentPort = server.address()?.port;
    if (!currentPort) return new Set();
    const hosts = new Set([
      `127.0.0.1:${currentPort}`,
      `localhost:${currentPort}`,
    ]);
    for (const ip of snapshot().addresses) hosts.add(`${ip}:${currentPort}`);
    return hosts;
  }

  function hostAllowed(req) {
    const hostHeader = String(req.headers.host || '').toLowerCase().replace(/\.$/, '');
    return allowedHosts().has(hostHeader);
  }

  function isCrossSite(req) {
    const site = String(req.headers['sec-fetch-site'] || '');
    const mode = String(req.headers['sec-fetch-mode'] || '');
    const dest = String(req.headers['sec-fetch-dest'] || '');
    // A tap from Messages or a QR app is a cross-site document navigation.
    // That has to load the page. Other cross-site reads, including the file, stay blocked.
    if (req.method === 'GET' && site === 'cross-site' && mode === 'navigate' && dest === 'document') {
      return false;
    }
    if (site === 'cross-site') return true;
    const origin = req.headers.origin;
    if (!origin || origin === 'null') return false;
    try {
      const parsed = new URL(origin);
      return !allowedHosts().has(parsed.host.toLowerCase());
    } catch {
      return true;
    }
  }

  function authorized(req) {
    return keysMatch(req.headers['x-downroad-key'], token);
  }

  async function handle(req, res) {
    if (!hostAllowed(req) || isCrossSite(req)) {
      sendJson(res, 403, { error: 'This phone link only answers on your own Wi-Fi.', code: 'forbidden' });
      return;
    }

    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      sendJson(res, 400, { error: 'Bad request.', code: 'bad_request' });
      return;
    }

    if (req.method === 'GET' && STATIC_FILES[pathname]) {
      serveStatic(res, STATIC_FILES[pathname]);
      return;
    }

    const thumbMatch = pathname.match(/^\/api\/thumbs\/([a-f0-9]{32})$/);
    if (req.method === 'GET' && thumbMatch) {
      await serveThumb(res, thumbMatch[1]);
      return;
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})(\/file|\/cancel)?$/i);
    if (jobMatch && JOB_ID.test(jobMatch[1])) {
      const id = jobMatch[1];
      const action = jobMatch[2] || '';
      if (req.method === 'GET' && action === '/file') {
        serveFile(req, res, id);
        return;
      }
      if (!authorized(req)) {
        sendJson(res, 401, { error: 'Scan the code in Downroad again. This page is locked.', code: 'locked' });
        return;
      }
      if (req.method === 'GET' && !action) {
        sendJson(res, 200, publicJob(jobs.get(id)));
        return;
      }
      if (req.method === 'POST' && action === '/cancel') {
        cancelJob(id);
        sendJson(res, 200, publicJob(jobs.get(id)));
        return;
      }
    }

    if (req.method === 'POST' && (pathname === '/api/inspect' || pathname === '/api/jobs')) {
      if (!authorized(req)) {
        sendJson(res, 401, { error: 'Scan the code in Downroad again. This page is locked.', code: 'locked' });
        return;
      }
      if (pathname === '/api/inspect') await inspect(req, res);
      else await createJob(req, res);
      return;
    }

    sendJson(res, 404, { error: 'Not found.', code: 'not_found' });
  }

  async function inspect(req, res) {
    const nowMs = now();
    while (inspectTimes.length && nowMs - inspectTimes[0] > 60000) inspectTimes.shift();
    if (inspectTimes.length >= INSPECTS_PER_MINUTE) {
      sendJson(res, 429, { error: 'Slow down. This Mac is not a public website.', code: 'rate_limit' });
      return;
    }
    inspectTimes.push(nowMs);

    const body = await readBody(req, res);
    if (!body) return;
    const parsed = normalizeSupportedUrl(body.url);
    if (!parsed) {
      sendJson(res, 400, { error: 'That link is not a YouTube, Instagram, or TikTok URL.', code: 'bad_url' });
      return;
    }
    try {
      const info = await engine.inspect(parsed.url);
      const thumb = rememberThumb(info && info.thumbnailUrl);
      sendJson(res, 200, publicInfo(info, thumb));
    } catch (error) {
      sendJson(res, 422, {
        error: error.message || 'Could not read that link.',
        code: error.code || 'inspect_failed',
      });
    }
  }

  function pruneJobs() {
    const cutoff = now() - FINISHED_JOB_MS;
    for (const [id, job] of jobs) {
      if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
    }
  }

  function stampFinished(job) {
    job.finishedAt = now();
  }

  async function createJob(req, res) {
    pruneJobs();
    const unfinished = [...jobs.values()].filter((job) => job.status === 'queued' || job.status === 'running');
    if (unfinished.length >= MAX_JOBS) {
      sendJson(res, 429, { error: 'Too many phone downloads are already running. Wait for one to finish.', code: 'busy' });
      return;
    }
    const body = await readBody(req, res);
    if (!body) return;
    const parsed = normalizeSupportedUrl(body.url);
    if (!parsed) {
      sendJson(res, 400, { error: 'That link is not a YouTube, Instagram, or TikTok URL.', code: 'bad_url' });
      return;
    }
    const quality = body.quality || 'best';
    if (!isValidQuality(quality)) {
      sendJson(res, 400, { error: 'That quality is not one Downroad offers.', code: 'bad_quality' });
      return;
    }
    const startTime = body.startTime || '';
    const endTime = body.endTime || '';
    if (!isValidClock(startTime) || !isValidClock(endTime) || !clipTimesAreOrdered(startTime, endTime)) {
      sendJson(res, 400, { error: 'Clip times are wrong. Start has to be before the end.', code: 'bad_time' });
      return;
    }
    const itemIndex = Number.isInteger(body.itemIndex) ? body.itemIndex : Number(body.itemIndex || 0);
    if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex > 40) {
      sendJson(res, 400, { error: 'Pick one of the items from the post.', code: 'bad_item' });
      return;
    }

    const job = {
      id: crypto.randomUUID(),
      status: 'queued',
      percent: 0,
      speed: '',
      eta: '',
      error: '',
      code: '',
      filename: '',
      bytes: 0,
      filePath: '',
      abort: new AbortController(),
      options: {
        url: parsed.url,
        platform: parsed.platform,
        quality: parsed.platform === 'youtube' ? String(quality) : (quality === 'audio' ? 'audio' : 'best'),
        startTime: parsed.platform === 'youtube' ? startTime : '',
        endTime: parsed.platform === 'youtube' ? endTime : '',
        itemIndex,
      },
      createdAt: now(),
    };
    jobs.set(job.id, job);
    queue.push(job.id);
    pump();
    sendJson(res, 202, { id: job.id });
  }

  function pump() {
    while (active < MAX_ACTIVE && queue.length > 0) {
      const id = queue.shift();
      const job = jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      active += 1;
      job.status = 'running';
      runJob(job).finally(() => {
        active -= 1;
        pump();
      });
    }
  }

  async function runJob(job) {
    try {
      const result = await engine.download(job.options, (progress) => {
        if (!progress || job.abort.signal.aborted) return;
        if (typeof progress.percent === 'number') job.percent = Math.max(0, Math.min(100, progress.percent));
        job.speed = progress.speed || '';
        job.eta = progress.eta || '';
      }, job.abort.signal);
      if (job.abort.signal.aborted) {
        job.status = 'cancelled';
        stampFinished(job);
        return;
      }
      job.status = 'ready';
      job.percent = 100;
      job.filePath = result.filePath;
      job.bytes = result.fileSize || safeSize(result.filePath);
      job.filename = safeDownloadName(result.title, result.format || path.extname(result.filePath).slice(1));
      job.title = result.title || 'download';
      stampFinished(job);
    } catch (error) {
      if (job.abort.signal.aborted || error.code === 'cancelled') {
        job.status = 'cancelled';
        stampFinished(job);
        return;
      }
      job.status = 'error';
      job.error = error.message || 'Download failed.';
      job.code = error.code || 'download_failed';
      stampFinished(job);
    }
  }

  function cancelJob(id) {
    const job = jobs.get(id);
    if (!job || job.status === 'ready' || job.status === 'error' || job.status === 'cancelled') return;
    job.abort.abort();
    job.status = 'cancelled';
    stampFinished(job);
  }

  function serveFile(req, res, id) {
    const job = jobs.get(id);
    if (!job || job.status !== 'ready' || !job.filePath) {
      sendJson(res, 409, { error: 'That download is not ready yet.', code: 'not_ready' });
      return;
    }
    let stat;
    try {
      stat = fs.statSync(job.filePath);
    } catch {
      sendJson(res, 404, { error: 'The file disappeared off the Mac. Download it again.', code: 'missing_file' });
      return;
    }
    const type = mimeFor(job.filename);
    const headers = {
      'Content-Type': type,
      'Content-Disposition': contentDisposition(job.filename),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= stat.size || end >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...headers,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      });
      fs.createReadStream(job.filePath, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    fs.createReadStream(job.filePath).pipe(res);
  }

  function rememberThumb(remoteUrl) {
    let parsed;
    try { parsed = new URL(String(remoteUrl || '')); } catch { return ''; }
    if (parsed.protocol !== 'https:' || !isThumbHost(parsed.hostname)) return '';
    const id = crypto.randomBytes(16).toString('hex');
    thumbs.set(id, { url: parsed.toString(), expires: now() + 10 * 60 * 1000 });
    return `/api/thumbs/${id}`;
  }

  async function serveThumb(res, id) {
    if (!THUMB_ID.test(id)) {
      sendJson(res, 404, { error: 'Not found.', code: 'not_found' });
      return;
    }
    const entry = thumbs.get(id);
    if (!entry || entry.expires < now()) {
      thumbs.delete(id);
      sendJson(res, 404, { error: 'That preview expired. Paste the link again.', code: 'thumb_expired' });
      return;
    }
    if (thumbFetches >= 4) {
      sendJson(res, 429, { error: 'Too many previews at once.', code: 'rate_limit' });
      return;
    }
    thumbFetches += 1;
    try {
      const image = await fetchThumb(entry.url, fetchImpl);
      res.writeHead(200, {
        'Content-Type': image.type,
        'Content-Length': image.body.length,
        'Cache-Control': 'private, max-age=600',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(image.body);
    } catch {
      sendJson(res, 404, { error: 'Preview could not be loaded.', code: 'thumb_failed' });
    } finally {
      thumbFetches -= 1;
    }
  }

  function close() {
    for (const job of jobs.values()) {
      if (job.status === 'queued' || job.status === 'running') job.abort.abort();
    }
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return new Promise((resolve, reject) => {
    const fail = (error) => reject(error);
    server.once('error', fail);
    server.listen(port, host, () => {
      server.removeListener('error', fail);
      resolve({ snapshot, close, port: server.address().port });
    });
  });
}

function phonePortCandidates(preferred) {
  const first = Number(preferred);
  const ports = [];
  if (Number.isInteger(first) && first >= PHONE_PORT_START && first <= PHONE_PORT_END) ports.push(first);
  for (let port = PHONE_PORT_START; port <= PHONE_PORT_END; port += 1) {
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

async function listenPhoneServer(options, ports = phonePortCandidates(options && options.port)) {
  let lastError = null;
  for (const port of ports) {
    try {
      return await startPhoneServer({ ...options, port });
    } catch (error) {
      lastError = error;
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw lastError || new Error('Could not open the phone link.');
}

function publicInfo(info, thumb) {
  const source = info || {};
  const qualities = Array.isArray(source.qualities) ? source.qualities : [];
  const items = Array.isArray(source.items) ? source.items : [];
  return {
    title: String(source.title || 'Untitled').slice(0, 300),
    duration: Number(source.duration) || 0,
    platform: source.platform || '',
    mediaType: source.mediaType || 'video',
    uploader: String(source.uploader || '').slice(0, 120),
    qualities: qualities
      .map((item) => ({ label: String(item.label || ''), height: Number(item.height) || 0 }))
      .filter((item) => item.label && item.height),
    items: items.map((item, index) => ({
      index: Number.isInteger(item.index) ? item.index : index,
      type: item.type === 'video' ? 'video' : 'image',
      label: String(item.label || `Item ${index + 1}`).slice(0, 40),
    })),
    thumb: thumb || '',
  };
}

function publicJob(job) {
  if (!job) return { status: 'missing', error: 'That download is gone. Start it again.', code: 'missing' };
  return {
    id: job.id,
    status: job.status,
    percent: job.percent || 0,
    speed: job.speed || '',
    eta: job.eta || '',
    error: job.error || '',
    code: job.code || '',
    filename: job.status === 'ready' ? job.filename : '',
    bytes: job.status === 'ready' ? job.bytes : 0,
  };
}

function serveStatic(res, asset) {
  let data;
  try {
    data = fs.readFileSync(asset.file);
  } catch {
    sendJson(res, 404, { error: 'Not found.', code: 'not_found' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': asset.type,
    'Content-Length': data.length,
    'Cache-Control': asset.type.startsWith('text/html') || asset.type.startsWith('text/javascript')
      ? 'no-store'
      : 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
  });
  res.end(data);
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(data);
}

async function readBody(req, res) {
  try {
    return await readJson(req);
  } catch {
    sendJson(res, 400, { error: 'Bad request.', code: 'bad_request' });
    return null;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request is too big.'), { code: 'bad_request' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(Object.assign(new Error('Request was not valid JSON.'), { code: 'bad_request' }));
      }
    });
    req.on('error', reject);
  });
}

function safeSize(filePath) {
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

function mimeFor(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.m4a' || ext === '.mp3' || ext === '.aac') return 'audio/mp4';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webm') return 'video/webm';
  return 'video/mp4';
}

function defaultFetch(url, options) {
  const lib = url.startsWith('https:') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = lib.get(url, { headers: options.headers, timeout: options.timeoutMs }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        resolve({ status: res.statusCode, headers: res.headers });
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_THUMB_BYTES) {
          req.destroy();
          reject(new Error('Thumb too big'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function fetchThumb(startUrl, fetchImpl) {
  let current = startUrl;
  for (let hop = 0; hop < 3; hop += 1) {
    const response = await fetchImpl(current, {
      headers: {
        'User-Agent': 'Downroad',
        Accept: 'image/*',
      },
      timeoutMs: 10000,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = new URL(response.headers.location, current);
      if (next.protocol !== 'https:' || !isThumbHost(next.hostname)) {
        throw new Error('Thumb redirect left the allowlist');
      }
      current = next.toString();
      continue;
    }
    if (response.status !== 200 || !response.body) throw new Error('Thumb missing');
    const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) throw new Error('Thumb was not an image');
    return { body: response.body, type };
  }
  throw new Error('Too many thumb redirects');
}

module.exports = {
  listenPhoneServer,
  phonePortCandidates,
  startPhoneServer,
};
