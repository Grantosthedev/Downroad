const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const {
  binaryExists,
  getDenoPath,
  getYtdlpPath,
  getFfmpegPath,
  sanitizeFilename,
  normalizeInstagramURL,
} = require('./utils');
const { reportError } = require('./sentry-report');
const { YTDLP_CHANNEL } = require('./ytdlp-release');
const path = require('path');

// Remove stale PyInstaller temp dirs (_MEI*) that accumulate when yt-dlp is
// killed mid-run or the disk fills up. Each one is ~45 MB so even a handful
// can cause "Could not create temporary directory!" errors on low-disk systems.
function cleanStaleYtdlpTemp() {
  try {
    const tmpDir = os.tmpdir();
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      if (!entry.startsWith('_MEI')) continue;
      const fullPath = path.join(tmpDir, entry);
      try {
        // Only remove dirs that haven't been touched in the last 10 minutes
        const stat = fs.statSync(fullPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > 10 * 60 * 1000) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      } catch { /* skip if we can't stat or remove */ }
    }
  } catch { /* non-fatal */ }
}

const ERROR_RULES = [
  { code: 'disk_full', pattern: /Could not create temp|Could not create temporary/i, message: 'Your disk is almost full. Free up some space and try again.' },
  { code: 'private_content', pattern: /private video/i, message: 'This video is private. You need access to download it.' },
  { code: 'age_restricted', pattern: /age.?restrict|age.?gate|sign in to confirm your age/i, message: 'This video is age-restricted. It cannot be downloaded without authentication.' },
  { code: 'region_blocked', pattern: /not available in your country/i, message: 'This video is not available in your region.' },
  { code: 'tiktok_login_required', pattern: /\[TikTok\].*(?:requiring login|login required|logged.in users|fresh cookies)/is, message: 'TikTok requires a logged-in session for this video. Open it in TikTok to confirm it is available, then try again later.' },
  { code: 'login_required', pattern: /login.*page|locked behind|sign in to confirm you.re not a bot/i, message: 'YouTube rejected this playback request. Downroad tried automatic recovery, but YouTube still refused it.' },
  { code: 'unsupported_url', pattern: /Unsupported URL/i, message: 'This URL type isn\'t supported yet. Downroad handles videos and audio. Image-only posts aren\'t supported via this method.' },
  { code: 'js_runtime_missing', pattern: /No supported JavaScript runtime|JavaScript runtime.*(?:missing|unavailable|unsupported)/i, message: 'YouTube challenge support is unavailable. Reinstall or update Downroad to restore the bundled runtime.' },
  { code: 'po_token_required', pattern: /PO Token.*(?:required|not provided|missing)|missing.*PO Token/i, message: 'YouTube rejected this playback session. Update the download engine and try again.' },
  { code: 'sabr_only', pattern: /SABR.*(?:only|forced)|forcing SABR/i, message: 'YouTube only offered an unsupported stream for this video. Update the download engine and try again.' },
  { code: 'rate_limited', status: 429, pattern: /HTTP Error 429|429 Too Many Requests|rate.?limit/i, message: 'The platform is rate-limiting requests. Stop downloads, wait a while, then try again.' },
  { code: 'access_forbidden', status: 403, pattern: /HTTP Error 403|\b403 Forbidden\b/i, message: 'The platform rejected this video stream. Update the download engine, then try again.' },
  { code: 'tiktok_challenge', pattern: /\[TikTok\].*(?:Unable to extract (?:sigi state|universal data|webpage video data)|Unexpected response from webpage request|JS challenge|challenge cookie)/is, message: 'TikTok blocked this request with a temporary verification challenge. Downroad retried automatically, but TikTok still refused it. Wait a moment and try again.' },
  { code: 'extractor_regression', pattern: /nsig extraction|signature extraction|player.*error|cipher|unable to extract|ExtractorError|extractor.*error/i, message: 'The download engine can\'t process YouTube\'s current player. Check for updates in Settings.' },
  { code: 'network_error', pattern: /urlopen error|timed out|(?:network|connection).*(?:error|refused|reset)/i, message: 'Network error. Check your internet connection and try again.' },
  { code: 'unavailable', pattern: /video.*(?:unavailable|removed|deleted|not exist)|content.*not available|currently unavailable/i, message: 'This video is unavailable or has been removed.' },
  { code: 'invalid_url', pattern: /is not a valid URL|no video/i, message: 'Please enter a valid URL.' },
  { code: 'certificate_error', pattern: /certificate verify failed|SSL/i, message: 'SSL certificate error. Check your network or try disabling VPN/proxy.' },
  { code: 'incomplete_download', pattern: /Incomplete data|incomplete read/i, message: 'Download was interrupted. Check your connection and try again.' },
  { code: 'platform_unreachable', pattern: /unable to download webpage/i, message: 'Couldn\'t reach the platform. Check your internet or update the download engine.' },
  { code: 'engine_corrupt', pattern: /Got error.*Traceback|ModuleNotFoundError|ImportError/i, message: 'The download engine is corrupted or incompatible. Update it in Settings.' },
];

function diagnoseYtdlpError(stderr) {
  const source = String(stderr || '');
  for (const rule of ERROR_RULES) {
    if (rule.pattern.test(source)) {
      return { code: rule.code, httpStatus: rule.status || null, message: rule.message };
    }
  }
  const errorLine = source.split('\n').find(l => l.includes('ERROR:'));
  if (errorLine) {
    return {
      code: 'upstream_error',
      httpStatus: null,
      message: errorLine.replace('ERROR: ', '').trim(),
    };
  }

  if (source.trim()) {
    console.error('[yt-dlp] raw stderr:', source.trim().slice(-500));
    const lastMeaningful = source.trim().split('\n').filter(l => l.trim()).slice(-2).join(' ').slice(0, 150);
    if (lastMeaningful) {
      return {
        code: 'unknown_engine_error',
        httpStatus: null,
        message: `Download engine error: ${lastMeaningful}. Try updating it in Settings.`,
      };
    }
  }

  return {
    code: 'unknown_engine_error',
    httpStatus: null,
    message: 'An unexpected download engine error occurred. Try updating it in Settings.',
  };
}

function contextualizeDiagnosis(diagnosis) {
  return diagnosis;
}

function mapError(stderr) {
  return diagnoseYtdlpError(stderr).message;
}

function reportYtdlpFailure(error, { phase, platform, quality, stderr, diagnosis } = {}) {
  if (stderr) console.error('[yt-dlp] failure tail:', String(stderr).trim().slice(-2000));
  reportError(error, {
    phase,
    platform,
    quality,
    reasonCode: diagnosis?.code,
    httpStatus: diagnosis?.httpStatus,
    architecture: process.arch,
    ytdlpChannel: YTDLP_CHANNEL,
    details: diagnosis ? {
      reasonCode: diagnosis.code,
      httpStatus: diagnosis.httpStatus,
    } : undefined,
  });
}

function youtubeRuntimeArgs(platform, denoPath = getDenoPath()) {
  if (platform !== 'youtube') return [];
  return binaryExists(denoPath) ? ['--js-runtimes', `deno:${denoPath}`] : [];
}

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'mkv', 'm4v']);

function formatHasVideo(format) {
  if (!format || typeof format !== 'object') return false;
  if (format.vcodec && format.vcodec !== 'none') return true;
  if (format.video_ext && format.video_ext !== 'none') return true;
  const ext = String(format.ext || '').toLowerCase();
  return VIDEO_EXTENSIONS.has(ext) && format.acodec !== 'none';
}

function isInstagramReelUrl(url) {
  return /instagram\.com\/(?:[\w.-]+\/)?(?:reel|reels|tv)\//i.test(url)
    && !/\/reels\/audio\//i.test(url);
}

function isProbablyImageUrl(url) {
  return /\.(?:jpe?g|png|webp|gif|heic)(?:$|[?#])/i.test(String(url || ''));
}

function chooseInstagramFileUrl(info) {
  if (!info || typeof info !== 'object') return '';
  const formats = [
    ...(Array.isArray(info.formats) ? info.formats : []),
    ...(Array.isArray(info.requested_formats) ? info.requested_formats : []),
  ];
  const videoFormat = formats.find(format => format?.url && !isProbablyImageUrl(format.url) && formatHasVideo(format));
  if (videoFormat) return videoFormat.url;
  return info.url || '';
}

function chooseInstagramVideoUrl(info) {
  const fileUrl = chooseInstagramFileUrl(info);
  return fileUrl && !isProbablyImageUrl(fileUrl) ? fileUrl : '';
}

function detectMediaType(info, platform, url) {
  if (platform === 'youtube') return 'video';
  if (!info || typeof info !== 'object') return 'image';
  if (typeof info.duration === 'number' && info.duration > 0 && !isProbablyImageUrl(info.url)) return 'video';
  if (platform === 'instagram' && isInstagramReelUrl(url) && chooseInstagramVideoUrl(info)) return 'video';

  const candidateFormats = [
    info,
    ...(Array.isArray(info.requested_formats) ? info.requested_formats : []),
    ...(Array.isArray(info.formats) ? info.formats : []),
  ];

  return candidateFormats.some(formatHasVideo) ? 'video' : 'image';
}

function buildInfoArgs({ url, platform, ffmpegPath, denoPath = getDenoPath(), recoveryArgs = [] }) {
  return [
    '--dump-json',
    '--no-playlist',
    '--ffmpeg-location', path.dirname(ffmpegPath),
    ...youtubeRuntimeArgs(platform, denoPath),
    ...(platform === 'youtube' ? recoveryArgs : []),
    platform === 'instagram' ? normalizeInstagramURL(url) : url,
  ];
}

function fetchVideoInfo(url, platform, options = {}) {
  return new Promise((resolve, reject) => {
    const ytdlp = getYtdlpPath();
    const ffmpeg = getFfmpegPath();
    const fetchUrl = platform === 'instagram' ? normalizeInstagramURL(url) : url;

    const args = buildInfoArgs({
      url: fetchUrl,
      platform,
      ffmpegPath: ffmpeg,
      recoveryArgs: options.recoveryArgs,
    });

    cleanStaleYtdlpTemp();
    const timeout = platform === 'instagram' || platform === 'tiktok' ? 60000 : 30000;
    const proc = spawn(ytdlp, args);
    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    }, timeout);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error('Request timed out. Check your connection and try again.'));
        return;
      }
      if (code !== 0) {
        const diagnosis = contextualizeDiagnosis(diagnoseYtdlpError(stderr));
        const error = new Error(diagnosis.message);
        error.code = diagnosis.code;
        reportYtdlpFailure(error, { phase: 'fetch-info', platform, stderr, diagnosis });
        reject(error);
        return;
      }
      if (stderr.trim()) console.warn('[yt-dlp] fetch warnings:', stderr.trim().slice(-2000));
      try {
        const info = JSON.parse(stdout);
        const formats = info.formats || [];
        let estimatedFileSize = 0;
        for (let i = formats.length - 1; i >= 0; i--) {
          const f = formats[i];
          if (f.filesize || f.filesize_approx) {
            estimatedFileSize = f.filesize || f.filesize_approx;
            break;
          }
        }

        resolve({
          id: info.id,
          title: info.title || 'Unknown Title',
          duration: info.duration || 0,
          thumbnail: info.thumbnail || info.thumbnails?.[info.thumbnails.length - 1]?.url || '',
          isLive: info.is_live || false,
          formats: extractAvailableQualities(formats),
          uploader: info.creator || info.uploader || info.channel || '',
          uploadDate: info.upload_date || '',
          description: (info.description || '').slice(0, 300),
          viewCount: info.view_count ?? null,
          likeCount: info.like_count ?? null,
          channel: info.channel || '',
          channelUrl: info.channel_url || '',
          webpageUrl: info.webpage_url || '',
          categories: info.categories || [],
          tags: (info.tags || []).slice(0, 10),
          license: info.license || '',
          platform: platform || 'youtube',
          mediaType: detectMediaType(info, platform, fetchUrl),
          estimatedFileSize,
        });
      } catch (e) {
        reportYtdlpFailure(e, { phase: 'parse-info', platform });
        reject(new Error('Failed to parse video information.'));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      const error = new Error(`Failed to run yt-dlp: ${err.message}`);
      reportYtdlpFailure(error, { phase: 'spawn-fetch-info', platform });
      reject(error);
    });
  });
}

function extractAvailableQualities(formats) {
  const heightSet = new Set();
  for (const f of formats) {
    if (f.height && f.vcodec !== 'none') heightSet.add(f.height);
  }
  const sorted = [...heightSet].sort((a, b) => b - a);
  const seen = new Set();
  const result = [];
  for (const h of sorted) {
    let label;
    if (h >= 2160) label = '4K';
    else if (h >= 1440) label = '1440p';
    else if (h >= 1080) label = '1080p';
    else if (h >= 720) label = '720p';
    else if (h >= 480) label = '480p';
    else label = `${h}p`;
    if (!seen.has(label)) {
      seen.add(label);
      result.push({ label, height: h });
    }
  }
  return result;
}

function buildDownloadArgs({
  url,
  quality,
  startTime,
  endTime,
  outputPath,
  title,
  ffmpegDir,
  platform,
  denoPath = getDenoPath(),
  recoveryArgs = [],
}) {
  // When no title is provided (instant download), let yt-dlp resolve the filename from metadata
  const safeName = title ? sanitizeFilename(title) : '';
  const outputTemplate = safeName ? `${safeName}.%(ext)s` : '%(title)s.%(ext)s';
  const isYouTube = !platform || platform === 'youtube';
  const args = [
    '--no-playlist',
    '--newline',
    '--ffmpeg-location', ffmpegDir,
    '--concurrent-fragments', '4',
    '--retries', '5',
    '--fragment-retries', '5',
    '--buffer-size', '64K',
    ...youtubeRuntimeArgs(isYouTube ? 'youtube' : platform, denoPath),
    ...(isYouTube ? recoveryArgs : []),
  ];

  if (quality === 'audio') {
    args.push('-f', 'bestaudio[ext=m4a]/bestaudio/best');
    args.push('-x', '--audio-format', 'm4a', '--audio-quality', '0');
    args.push('-o', path.join(outputPath, outputTemplate));
  } else if (isYouTube) {
    const isNumericHeight = /^\d+$/.test(quality);
    if (isNumericHeight) {
      const h = quality;
      args.push(
        '-f',
        `bestvideo[height=${h}]+bestaudio[acodec^=mp4a]/bestvideo[height=${h}]+bestaudio/bestvideo[height<=${h}]+bestaudio[acodec^=mp4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`,
        '--merge-output-format', 'mp4',
      );
    } else {
      args.push(
        '-f',
        'bestvideo+bestaudio[acodec^=mp4a]/bestvideo+bestaudio/best',
        '--merge-output-format', 'mp4',
      );
    }
    // Sort by resolution first, then prefer H.264 video and AAC audio for reliability
    args.push('-S', 'res,vcodec:avc,acodec:mp4a');
    args.push('-o', path.join(outputPath, outputTemplate));
  } else if (platform === 'instagram') {
    args.push(
      '-f',
      'bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[vcodec^=avc1]+bestaudio/bestvideo+bestaudio/best',
    );
    args.push('--merge-output-format', 'mp4');
    args.push('-o', path.join(outputPath, outputTemplate));
  } else {
    args.push(
      '-f',
      'bestvideo+bestaudio[acodec^=mp4a]/bestvideo+bestaudio/best',
      '--merge-output-format', 'mp4',
    );
    args.push('-o', path.join(outputPath, outputTemplate));
  }

  if (isYouTube) {
    const hasStart = startTime && startTime !== '00:00:00';
    const hasEnd = endTime && endTime !== '00:00:00';
    if (hasStart || hasEnd) {
      const start = startTime || '00:00:00';
      const end = endTime || '';
      if (end) {
        args.push('--download-sections', `*${start}-${end}`);
      } else {
        args.push('--download-sections', `*${start}-inf`);
      }
    }
  }

  args.push(platform === 'instagram' ? normalizeInstagramURL(url) : url);
  return args;
}

function parseOutputLine(line, state, onProgress) {
  const trimmed = line.trim();
  if (!trimmed) return;

  const destMatch = trimmed.match(/Destination:\s*(.+)/);
  if (destMatch) {
    state.lastFile = destMatch[1];
    const basename = destMatch[1].split('/').pop().replace(/\.[^.]+$/, '');
    if (basename) onProgress({ percent: 0, speed: '', eta: '', title: basename });
    return;
  }

  const mergeMatch = trimmed.match(/Merging formats into "(.+)"/);
  if (mergeMatch) {
    state.lastFile = mergeMatch[1];
    state.lastPercent = 99.5;
    onProgress({ percent: 99.5, speed: '', eta: '', status: 'merging' });
    return;
  }

  if (trimmed.includes('has already been downloaded')) {
    state.lastFile = trimmed.replace('[download]', '').replace('has already been downloaded', '').trim();
    state.lastPercent = 100;
    onProgress({ percent: 100, speed: '', eta: '' });
    return;
  }

  if (/^\[ExtractAudio\]|^\[FixupM4a\]|^\[ffmpeg\] Fixing/.test(trimmed)) {
    state.lastPercent = 99.5;
    onProgress({ percent: 99.5, speed: '', eta: '', status: 'extracting_audio' });
    return;
  }

  if (/^\[Fixup\]|^\[MoveFiles\]|^\[FixupTimestamp\]/.test(trimmed)) {
    state.lastPercent = 99.5;
    onProgress({ percent: 99.5, speed: '', eta: '', status: 'still_working' });
    return;
  }

  const percentMatch = trimmed.match(/([\d.]+)%/);
  if (percentMatch) {
    const percent = parseFloat(percentMatch[1]);
    state.lastPercent = percent;
    const speedMatch = trimmed.match(/at\s+([\d.]+\S*\/s)/);
    const etaMatch = trimmed.match(/ETA\s+(\d+:\d+)/);
    onProgress({
      percent: Math.min(percent, 100),
      speed: speedMatch ? speedMatch[1] : '',
      eta: etaMatch ? etaMatch[1] : '',
    });
  }
}

function parseDurationSecs(probeOutput) {
  const m = probeOutput.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
}

function trackFfmpegProgress(proc, durationSecs, onProgress, statusKey) {
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    const timeMatch = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (timeMatch && durationSecs > 0) {
      const cur = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
      const pct = Math.min(Math.round((cur / durationSecs) * 100), 99);
      onProgress({ percent: 99.5, speed: '', eta: '', status: statusKey, convertPercent: pct });
    }
  });
}

function ensureMacCompatible(filePath, ffmpegPath, onProgress) {
  return new Promise((resolve) => {
    if (!filePath || !filePath.endsWith('.mp4')) {
      resolve(filePath);
      return;
    }

    const probe = spawn(ffmpegPath, ['-i', filePath]);
    let probeOutput = '';
    probe.stderr.on('data', (d) => { probeOutput += d.toString(); });

    const probeTimer = setTimeout(() => {
      try { probe.kill('SIGKILL'); } catch {}
    }, 10000);

    probe.on('close', () => {
      clearTimeout(probeTimer);
      const hasNonCompatible = /Video:.*(?:vp[89]|av01|av1)/i.test(probeOutput);
      const hasCompatible = /Video:.*(?:h264|avc|hevc|h265)/i.test(probeOutput);

      if (!hasNonCompatible || hasCompatible) {
        resolve(filePath);
        return;
      }

      const durationSecs = parseDurationSecs(probeOutput);
      onProgress({ percent: 99.5, speed: '', eta: '', status: 'converting_mac', convertPercent: 0 });

      const tmpPath = filePath.replace(/\.mp4$/, '.compat.tmp.mp4');

      const hwEncode = spawn(ffmpegPath, [
        '-i', filePath,
        '-c:v', 'hevc_videotoolbox',
        '-q:v', '55',
        '-tag:v', 'hvc1',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        '-y',
        tmpPath,
      ]);

      trackFfmpegProgress(hwEncode, durationSecs, onProgress, 'converting_mac');

      let hwFailed = false;

      hwEncode.on('close', (hwCode) => {
        if (hwFailed) return;
        if (hwCode === 0) {
          try {
            fs.unlinkSync(filePath);
            fs.renameSync(tmpPath, filePath);
          } catch {}
          resolve(filePath);
          return;
        }

        try { fs.unlinkSync(tmpPath); } catch {}
        softwareEncode(filePath, ffmpegPath, tmpPath, durationSecs, onProgress, resolve);
      });

      hwEncode.on('error', () => {
        hwFailed = true;
        softwareEncode(filePath, ffmpegPath, tmpPath, durationSecs, onProgress, resolve);
      });
    });

    probe.on('error', () => {
      clearTimeout(probeTimer);
      resolve(filePath);
    });
  });
}

function softwareEncode(filePath, ffmpegPath, tmpPath, durationSecs, onProgress, resolve) {
  onProgress({ percent: 99.5, speed: '', eta: '', status: 'converting_sw', convertPercent: 0 });
  const swEncode = spawn(ffmpegPath, [
    '-i', filePath,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '18',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    '-y',
    tmpPath,
  ]);

  trackFfmpegProgress(swEncode, durationSecs, onProgress, 'converting_sw');

  swEncode.on('close', (code) => {
    if (code === 0) {
      try {
        fs.unlinkSync(filePath);
        fs.renameSync(tmpPath, filePath);
      } catch { /* keep original if rename fails */ }
    } else {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    resolve(filePath);
  });

  swEncode.on('error', () => resolve(filePath));
}

function ensureAacAudio(filePath, ffmpegPath, onProgress) {
  return new Promise((resolve) => {
    if (!filePath || !filePath.endsWith('.mp4')) {
      resolve(filePath);
      return;
    }

    const probe = spawn(ffmpegPath, ['-i', filePath]);
    let probeOutput = '';
    probe.stderr.on('data', (d) => { probeOutput += d.toString(); });

    const probeTimer = setTimeout(() => {
      try { probe.kill('SIGKILL'); } catch {}
    }, 10000);

    probe.on('close', () => {
      clearTimeout(probeTimer);
      const hasAudio = /Audio:/i.test(probeOutput);
      const hasNonAacAudio = /Audio:.*(?:opus|vorbis)/i.test(probeOutput);
      const hasAacAudio = /Audio:.*(?:aac|mp4a)/i.test(probeOutput);

      // Skip if no audio, already AAC, or no known non-AAC codec detected
      if (!hasAudio || hasAacAudio || !hasNonAacAudio) {
        resolve(filePath);
        return;
      }

      const durationSecs = parseDurationSecs(probeOutput);
      onProgress({ percent: 99.5, speed: '', eta: '', status: 'converting_audio', convertPercent: 0 });

      const tmpPath = filePath.replace(/\.mp4$/, '.aac.tmp.mp4');
      const proc = spawn(ffmpegPath, [
        '-i', filePath,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        '-y',
        tmpPath,
      ]);

      trackFfmpegProgress(proc, durationSecs, onProgress, 'converting_audio');

      proc.on('close', (code) => {
        if (code === 0) {
          try {
            fs.unlinkSync(filePath);
            fs.renameSync(tmpPath, filePath);
          } catch {}
        } else {
          try { fs.unlinkSync(tmpPath); } catch {}
        }
        resolve(filePath);
      });

      proc.on('error', () => resolve(filePath));
    });

    probe.on('error', () => {
      clearTimeout(probeTimer);
      resolve(filePath);
    });
  });
}

function startDownload(options, onProgress, onComplete, onError) {
  const ytdlp = getYtdlpPath();
  const ffmpegPath = getFfmpegPath();
  const ffmpegDir = path.dirname(ffmpegPath);

  cleanStaleYtdlpTemp();
  const args = buildDownloadArgs({ ...options, ffmpegDir });
  const safeArgs = args.map(a => /^https?:\/\//.test(a) ? a.replace(/\?.*$/, '?<redacted>') : a);
  console.log('[yt-dlp] spawn:', safeArgs.join(' '));
  const proc = spawn(ytdlp, args);

  const MAX_STDERR = 10 * 1024;
  let stderrBuf = '';
  const parseState = { lastFile: '', lastPercent: 0, lastOutputTime: Date.now() };

  const parseLine = (line) => {
    const t = line.trim();
    if (t) {
      parseState.lastOutputTime = Date.now();
      console.log('[yt-dlp]', t);
    }
    parseOutputLine(line, parseState, onProgress);
  };

  const heartbeat = setInterval(() => {
    const silentMs = Date.now() - parseState.lastOutputTime;
    if (silentMs >= 5000 && parseState.lastPercent >= 99) {
      onProgress({ percent: 99.5, speed: '', eta: '', status: 'still_working' });
    }
  }, 3000);

  proc.stdout.on('data', (data) => {
    data.toString().split('\n').forEach(parseLine);
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString();
    stderrBuf += text;
    if (stderrBuf.length > MAX_STDERR) {
      stderrBuf = stderrBuf.slice(-MAX_STDERR);
    }
    text.split('\n').forEach(parseLine);
  });

  proc.on('close', (code) => {
    clearInterval(heartbeat);
    if (code === 0) {
      const filePath = parseState.lastFile;
      if (filePath && filePath.endsWith('.mp4')) {
        ensureMacCompatible(filePath, ffmpegPath, onProgress)
          .then((compatPath) => ensureAacAudio(compatPath, ffmpegPath, onProgress))
          .then((finalPath) => onComplete(finalPath));
      } else {
        onComplete(filePath);
      }
    } else {
      const diagnosis = contextualizeDiagnosis(diagnoseYtdlpError(stderrBuf));
      const error = new Error(diagnosis.message);
      error.code = diagnosis.code;
      reportYtdlpFailure(error, {
        phase: 'download',
        platform: options.platform,
        quality: options.quality,
        stderr: stderrBuf,
        diagnosis,
      });
      onError(error.message, diagnosis);
    }
  });

  proc.on('error', (err) => {
    clearInterval(heartbeat);
    const error = new Error(`Failed to run yt-dlp: ${err.message}`);
    reportYtdlpFailure(error, {
      phase: 'spawn-download',
      platform: options.platform,
      quality: options.quality,
    });
    onError(error.message);
  });

  return proc;
}

function fetchCarouselVideos(url) {
  return new Promise((resolve) => {
    const ytdlp = getYtdlpPath();
    const ffmpeg = getFfmpegPath();
    const fetchUrl = normalizeInstagramURL(url);

    const args = [
      '--dump-json',
      '--ffmpeg-location', path.dirname(ffmpeg),
      fetchUrl,
    ];

    cleanStaleYtdlpTemp();
    const proc = spawn(ytdlp, args, { timeout: 60000 });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        const diagnosis = diagnoseYtdlpError(stderr);
        const error = new Error(diagnosis.message);
        reportYtdlpFailure(error, { phase: 'fetch-carousel', platform: 'instagram', stderr, diagnosis });
        resolve([]);
        return;
      }
      try {
        const items = [];
        const lines = stdout.trim().split('\n');

        for (const line of lines) {
          try {
            const info = JSON.parse(line);
            const videoUrl = chooseInstagramVideoUrl(info);
            const thumbnail = info.thumbnail || info.thumbnails?.[info.thumbnails.length - 1]?.url || '';

            if (videoUrl && detectMediaType(info, 'instagram', fetchUrl) === 'video') {
              items.push({
                type: 'video',
                url: videoUrl,
                thumbnail,
                width: info.width || 0,
                height: info.height || 0,
              });
            }
          } catch { /* skip unparseable lines */ }
        }

        resolve(items);
      } catch (error) {
        reportYtdlpFailure(error, { phase: 'parse-carousel', platform: 'instagram' });
        resolve([]);
      }
    });

    proc.on('error', (error) => {
      reportYtdlpFailure(error, { phase: 'spawn-carousel', platform: 'instagram' });
      resolve([]);
    });
  });
}

function fetchInstagramMediaViaYtdlp(url) {
  return new Promise((resolve) => {
    const ytdlp = getYtdlpPath();
    const ffmpeg = getFfmpegPath();
    const fetchUrl = normalizeInstagramURL(url);

    const args = [
      '--dump-json',
      '--ffmpeg-location', path.dirname(ffmpeg),
      fetchUrl,
    ];

    cleanStaleYtdlpTemp();
    const proc = spawn(ytdlp, args);
    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    }, 60000);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed || code !== 0) {
        if (code !== 0) {
          const diagnosis = diagnoseYtdlpError(stderr);
          const error = new Error(diagnosis.message);
          reportYtdlpFailure(error, {
            phase: 'fetch-instagram-fallback',
            platform: 'instagram',
            stderr,
            diagnosis,
          });
        }
        resolve(null);
        return;
      }
      try {
        const lines = stdout.trim().split('\n');
        const items = [];
        let owner = '';
        let caption = '';
        let timestamp = '';

        for (const line of lines) {
          try {
            const info = JSON.parse(line);
            if (!owner) owner = info.uploader || info.channel || '';
            if (!caption) caption = (info.description || '').slice(0, 300);
            if (!timestamp && info.upload_date) {
              const d = info.upload_date;
              timestamp = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
            }

            const thumb = info.thumbnail || info.thumbnails?.[info.thumbnails.length - 1]?.url || '';
            const videoUrl = chooseInstagramVideoUrl(info);
            const mediaUrl = videoUrl || (isInstagramReelUrl(fetchUrl) ? '' : (info.url || ''));
            const isVideo = Boolean(videoUrl);

            if (mediaUrl) {
              items.push({
                type: isVideo ? 'video' : 'image',
                url: mediaUrl,
                thumbnail: thumb,
                width: info.width || 0,
                height: info.height || 0,
              });
            }
          } catch { /* skip unparseable lines */ }
        }

        if (items.length === 0) {
          resolve(null);
          return;
        }

        resolve({
          isCarousel: items.length > 1,
          owner,
          caption,
          timestamp,
          items,
          _fromYtdlp: true,
        });
      } catch (error) {
        reportYtdlpFailure(error, { phase: 'parse-instagram-fallback', platform: 'instagram' });
        resolve(null);
      }
    });

    proc.on('error', (error) => {
      clearTimeout(timer);
      reportYtdlpFailure(error, { phase: 'spawn-instagram-fallback', platform: 'instagram' });
      resolve(null);
    });
  });
}

module.exports = {
  buildDownloadArgs,
  buildInfoArgs,
  chooseInstagramFileUrl,
  chooseInstagramVideoUrl,
  cleanStaleYtdlpTemp,
  contextualizeDiagnosis,
  diagnoseYtdlpError,
  fetchCarouselVideos,
  fetchInstagramMediaViaYtdlp,
  fetchVideoInfo,
  mapError,
  startDownload,
  youtubeRuntimeArgs,
};
