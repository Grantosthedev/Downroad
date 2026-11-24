const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// SYNC: These regexes are duplicated in src/renderer/renderer.js for instant UI feedback.
// If you change them here, update the renderer copy too.
const YOUTUBE_URL_REGEX = /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
const INSTAGRAM_URL_REGEX = /^https?:\/\/(?:www\.)?instagram\.com\/(?:(?:p|reel|reels|tv|stories|share)|[\w.-]+\/(?:p|reel|reels|tv))\/[\w.-]+/;
const TIKTOK_URL_REGEX = /^https?:\/\/(?:(?:www|m)\.)?tiktok\.com\/@[\w.-]+\/(?:video|photo)\/\d+|^https?:\/\/(?:vm|vt)\.tiktok\.com\/[\w]+|^https?:\/\/(?:(?:www|m)\.)?tiktok\.com\/t\/[\w]+/;
const X_URL_REGEX = /^https?:\/\/(?:(?:www|m(?:obile)?)\.)?(?:x\.com|twitter\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com|fixvx\.com)\/(?:(?:i\/web|[^/?#]+)\/status|statuses)\/\d+(?:\/(?:video|photo)\/\d+)?\/?(?:[?#]\S*)?$|^https?:\/\/(?:www\.)?t\.co\/[\w-]+\/?(?:[?#]\S*)?$/i;
const X_ALIAS_HOSTS = new Set(['x.com', 'twitter.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com', 'fixvx.com']);

function isValidYouTubeURL(url) {
  return YOUTUBE_URL_REGEX.test(url.trim());
}

function isValidURL(url) {
  const trimmed = url.trim();
  return YOUTUBE_URL_REGEX.test(trimmed)
    || INSTAGRAM_URL_REGEX.test(trimmed)
    || TIKTOK_URL_REGEX.test(trimmed)
    || X_URL_REGEX.test(trimmed);
}

function detectPlatform(url) {
  const trimmed = url.trim();
  if (YOUTUBE_URL_REGEX.test(trimmed)) return 'youtube';
  if (INSTAGRAM_URL_REGEX.test(trimmed)) return 'instagram';
  if (TIKTOK_URL_REGEX.test(trimmed)) return 'tiktok';
  if (X_URL_REGEX.test(trimmed)) return 'x';
  return null;
}

function isTiktokPhotoUrl(url) {
  return /\/photo\//.test(url.trim());
}

function isXPhotoUrl(url) {
  return /\/photo\/\d+(?:[/?#]|$)/i.test(url.trim());
}

function canonicalXHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^(?:www|m|mobile)\./, '');
}

function extractVideoId(url) {
  const match = url.trim().match(YOUTUBE_URL_REGEX);
  return match ? match[1] : null;
}

function normalizeYouTubeURL(url) {
  const videoId = extractVideoId(url);
  if (!videoId) return url;
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function normalizeInstagramURL(url) {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (!/(^|\.)instagram\.com$/i.test(parsed.hostname)) return trimmed;
    parsed.hostname = 'www.instagram.com';
    parsed.pathname = parsed.pathname.replace(
      /^\/([\w.-]+)\/(reels?|tv|p)\/([^/?#]+)\/?/i,
      (match, user, kind, code) => {
        if (/^(?:p|reel|reels|tv|stories|share)$/i.test(user)) return match;
        const canonicalKind = /^reels?$/i.test(kind) ? 'reel' : kind.toLowerCase();
        return `/${canonicalKind}/${code}/`;
      },
    );
    parsed.pathname = parsed.pathname.replace(/^\/reels\//i, '/reel/');
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase() === 'igsh' || key.toLowerCase().startsWith('utm_')) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return trimmed.replace(/(instagram\.com\/)reels\//i, '$1reel/');
  }
}

function normalizeTikTokURL(url) {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (!/(^|\.)tiktok\.com$/i.test(parsed.hostname)) return trimmed;
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function normalizeXURL(url) {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    const host = canonicalXHost(parsed.hostname);
    if (host === 't.co') {
      parsed.protocol = 'https:';
      parsed.hostname = 't.co';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    }
    if (!X_ALIAS_HOSTS.has(host)) return trimmed;
    parsed.protocol = 'https:';
    parsed.hostname = 'x.com';
    parsed.search = '';
    parsed.hash = '';
    const pathWithoutTrailingSlash = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = pathWithoutTrailingSlash || parsed.pathname;
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function normalizePlatformURL(url, platform) {
  if (platform === 'youtube') return normalizeYouTubeURL(url);
  if (platform === 'instagram') return normalizeInstagramURL(url);
  if (platform === 'tiktok') return normalizeTikTokURL(url);
  if (platform === 'x') return normalizeXURL(url);
  return String(url || '').trim();
}

function sanitizeFilename(name) {
  let safe = name
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/[.\s]+$/, '')
    .trim()
    .substring(0, 200);
  return safe || 'download';
}

function getResourcePath(...segments) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...segments);
  }
  return path.join(__dirname, '..', ...segments);
}

function getUserBinDir() {
  return path.join(app.getPath('userData'), 'bin');
}

function getBundledYtdlpPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'yt-dlp_macos');
  }
  const gzPath = path.join(__dirname, '..', 'bin', 'yt-dlp_macos.gz');
  try {
    fs.accessSync(gzPath, fs.constants.R_OK);
    return gzPath;
  } catch {
    return path.join(__dirname, '..', 'bin', 'yt-dlp_macos');
  }
}

function getYtdlpPath() {
  const userPath = path.join(getUserBinDir(), 'yt-dlp_macos');
  try {
    fs.accessSync(userPath, fs.constants.X_OK);
    return userPath;
  } catch {
    if (!app.isPackaged) {
      const devPath = path.join(__dirname, '..', 'bin', 'yt-dlp_macos');
      try {
        fs.accessSync(devPath, fs.constants.X_OK);
        return devPath;
      } catch {}
    }
    return userPath;
  }
}

function getFfmpegPath() {
  const staticPath = require('ffmpeg-static');
  if (app.isPackaged) {
    return staticPath.replace('app.asar', 'app.asar.unpacked');
  }
  return staticPath;
}

function getDenoPath() {
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, 'deno');
  }
  return path.join(__dirname, '..', 'bin', 'deno');
}

function getPotProviderPath() {
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, 'bgutil-pot');
  }
  return path.join(__dirname, '..', 'bin', 'bgutil-pot');
}

function getYtdlpPluginDir() {
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, 'yt-dlp-plugins');
  }
  return path.join(__dirname, '..', 'bin', 'yt-dlp-plugins');
}

function getRuntimeManifestPath() {
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, 'runtime-manifest.json');
  }
  return path.join(__dirname, '..', 'bin', 'runtime-manifest.json');
}

function binaryExists(binPath) {
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseTimeToSeconds(timeStr) {
  if (!timeStr || timeStr === '00:00:00') return 0;
  const parts = timeStr.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function formatSeconds(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function checkDiskSpace(dirPath) {
  try {
    const stats = await fs.promises.statfs(dirPath);
    return stats.bavail * stats.bsize;
  } catch {
    return Infinity;
  }
}

function pathExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

module.exports = {
  isValidYouTubeURL,
  isValidURL,
  detectPlatform,
  isTiktokPhotoUrl,
  isXPhotoUrl,
  extractVideoId,
  normalizeYouTubeURL,
  normalizeInstagramURL,
  normalizeTikTokURL,
  normalizeXURL,
  normalizePlatformURL,
  sanitizeFilename,
  getYtdlpPath,
  getBundledYtdlpPath,
  getUserBinDir,
  getFfmpegPath,
  getDenoPath,
  getPotProviderPath,
  getYtdlpPluginDir,
  getRuntimeManifestPath,
  getResourcePath,
  binaryExists,
  parseTimeToSeconds,
  formatSeconds,
  checkDiskSpace,
  pathExists,
};
