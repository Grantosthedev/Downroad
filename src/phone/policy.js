const crypto = require('crypto');
const { isValidURL, detectPlatform, normalizeYouTubeURL, normalizeInstagramURL, normalizeTikTokURL, sanitizeFilename, parseTimeToSeconds } = require('../utils');

const TIME_FORMAT = /^\d{2}:\d{2}:\d{2}$/;
const QUALITY_HEIGHT = /^\d{3,4}$/;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THUMB_ID = /^[a-f0-9]{32}$/;
const MODES = new Set(['professional', 'unhinged', 'diabolical']);

const THUMB_HOSTS = [
  /(^|\.)ytimg\.com$/i,
  /(^|\.)ggpht\.com$/i,
  /(^|\.)cdninstagram\.com$/i,
  /(^|\.)fbcdn\.net$/i,
  /(^|\.)tiktokcdn\.com$/i,
  /(^|\.)tiktokcdn-us\.com$/i,
];

function normalizeSupportedUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed || trimmed.length > 2048 || !isValidURL(trimmed)) return null;
  const platform = detectPlatform(trimmed);
  if (platform === 'youtube') return { platform, url: normalizeYouTubeURL(trimmed) };
  if (platform === 'instagram') return { platform, url: normalizeInstagramURL(trimmed) };
  if (platform === 'tiktok') return { platform, url: normalizeTikTokURL(trimmed) };
  return null;
}

function isValidQuality(quality) {
  const value = String(quality || 'best');
  return value === 'best' || value === 'audio' || QUALITY_HEIGHT.test(value);
}

function isValidClock(value) {
  if (!value || value === '00:00:00') return true;
  return TIME_FORMAT.test(String(value));
}

function clipTimesAreOrdered(startTime, endTime) {
  const start = startTime && startTime !== '00:00:00' ? startTime : '';
  const end = endTime && endTime !== '00:00:00' ? endTime : '';
  if (!start || !end) return true;
  return parseTimeToSeconds(start) < parseTimeToSeconds(end);
}

function isThumbHost(hostname) {
  return THUMB_HOSTS.some((pattern) => pattern.test(hostname));
}

function safeDownloadName(name, ext) {
  const base = sanitizeFilename(String(name || 'download')).replace(/["\\]/g, '');
  const cleanExt = String(ext || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'mp4';
  return `${base}.${cleanExt}`;
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function rankLanAddress(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 9;
}

function lanAddresses(interfaces) {
  const found = [];
  for (const entries of Object.values(interfaces || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const family = entry.family === 4 ? 'IPv4' : entry.family;
      if (family !== 'IPv4' || entry.internal) continue;
      if (!entry.address || entry.address.startsWith('169.254.')) continue;
      if (rankLanAddress(entry.address) > 2) continue;
      found.push(entry.address);
    }
  }
  return [...new Set(found)].sort((a, b) => rankLanAddress(a) - rankLanAddress(b) || a.localeCompare(b, 'en'));
}

function phoneLinks({ port, token, addresses }) {
  const hash = `k=${encodeURIComponent(token)}`;
  const urls = addresses.map((ip) => `http://${ip}:${port}/#${hash}`);
  return {
    reachable: urls.length > 0,
    addresses,
    urls,
    primaryUrl: urls[0] || '',
    warning: urls.length > 0
      ? ''
      : 'Connect this Mac to Wi-Fi. A phone cannot reach localhost.',
  };
}

function decoratePhoneUrl(url, { mode, theme } = {}) {
  const parsed = new URL(url);
  const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''));
  hash.set('m', MODES.has(mode) ? mode : 'unhinged');
  hash.set('t', theme === 'light' ? 'light' : 'dark');
  parsed.hash = hash.toString();
  return parsed.toString();
}

function readLaunchHash(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const mode = params.get('m');
  const theme = params.get('t');
  return {
    key: params.get('k') || '',
    mode: MODES.has(mode) ? mode : '',
    theme: theme === 'light' || theme === 'dark' ? theme : '',
  };
}

function keysMatch(provided, expected) {
  const actual = Buffer.from(String(provided || ''));
  const wanted = Buffer.from(String(expected || ''));
  if (actual.length === 0 || actual.length !== wanted.length) return false;
  return crypto.timingSafeEqual(actual, wanted);
}

module.exports = {
  JOB_ID,
  THUMB_ID,
  clipTimesAreOrdered,
  contentDisposition,
  decoratePhoneUrl,
  isThumbHost,
  isValidClock,
  isValidQuality,
  keysMatch,
  lanAddresses,
  normalizeSupportedUrl,
  phoneLinks,
  readLaunchHash,
  safeDownloadName,
};
