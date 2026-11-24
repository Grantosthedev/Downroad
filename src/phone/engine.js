const fs = require('fs');
const path = require('path');

const MIN_FREE_BYTES = 100 * 1024 * 1024;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cancelled() {
  return fail('cancelled', 'Cancelled');
}

function mediaTitle(media, fallback) {
  const caption = String(media?.caption || '').replace(/\s+/g, ' ').trim();
  if (caption) return caption.slice(0, 180);
  if (media?.owner) return `Instagram post by @${media.owner}`;
  return fallback || 'Instagram';
}

function createPhoneEngine({
  getOutputDir,
  onSaved,
  fetchVideoInfo,
  startDownload,
  fetchMediaInfo,
  downloadImage,
  ensureYoutubeRecovery,
  isYoutubeRecoveryError,
  checkDiskSpace,
  sweepPartials,
} = {}) {
  const inspected = new Map();

  function remember(url, info) {
    inspected.set(url, info);
    if (inspected.size > 40) {
      const oldest = inspected.keys().next().value;
      inspected.delete(oldest);
    }
  }

  async function inspect(url) {
    const platform = detectFromFetcher(url);
    if (platform === 'instagram' && fetchMediaInfo) {
      const media = await fetchMediaInfo(url).catch(() => null);
      if (media?.items?.length) {
        const info = {
          title: mediaTitle(media),
          duration: 0,
          platform: 'instagram',
          mediaType: media.isCarousel || media.items.length > 1
            ? 'carousel'
            : (media.items[0].type === 'video' ? 'video' : 'image'),
          uploader: media.owner || '',
          qualities: [],
          thumbnailUrl: media.items.find((item) => item.thumbnail)?.thumbnail || '',
          items: media.items.map((item, index) => ({
            index,
            type: item.type === 'video' ? 'video' : 'image',
            label: item.type === 'video' ? `Video ${index + 1}` : `Photo ${index + 1}`,
          })),
          webpageUrl: url,
        };
        remember(url, info);
        return info;
      }
    }

    const raw = await fetchVideoInfo(url, platform);
    if (platform === 'youtube' && raw?.isLive) {
      throw fail('live', 'Live streams cannot be saved. Wait until the stream ends.');
    }
    const info = {
      title: raw?.title || 'Unknown title',
      duration: raw?.duration || 0,
      platform: raw?.platform || platform || 'youtube',
      mediaType: raw?.mediaType || 'video',
      uploader: raw?.uploader || raw?.channel || '',
      qualities: Array.isArray(raw?.formats) ? raw.formats : [],
      thumbnailUrl: raw?.thumbnail || '',
      items: [],
      webpageUrl: raw?.webpageUrl || url,
    };
    remember(url, info);
    return info;
  }

  async function download(options, onProgress, signal) {
    const outputDir = getOutputDir();
    await fs.promises.mkdir(outputDir, { recursive: true });
    if (checkDiskSpace) {
      const free = await checkDiskSpace(outputDir);
      if (free < MIN_FREE_BYTES) {
        throw fail('disk', 'Not enough free space on the Mac to save this.');
      }
    }
    if (signal?.aborted) throw cancelled();

    const cached = inspected.get(options.url);
    const platform = options.platform;
    if (platform === 'instagram' && fetchMediaInfo && downloadImage) {
      const saved = await downloadInstagramItem(options, outputDir, signal, onProgress);
      if (saved) {
        await publish(saved, options, cached);
        return saved;
      }
    }

    const filePath = await runYtdlp(options, outputDir, cached?.title || '', signal, onProgress);
    const saved = describeFile(filePath, cached?.title || options.url, platform, options.quality, cached);
    await publish(saved, options, cached);
    return saved;
  }

  async function downloadInstagramItem(options, outputDir, signal, onProgress) {
    const media = await fetchMediaInfo(options.url).catch(() => null);
    const items = media?.items || [];
    if (!items.length) return null;
    const item = items[options.itemIndex] || items[0];
    const singleVideo = items.length === 1 && item.type === 'video';
    if (singleVideo || !item.url) return null;
    if (signal?.aborted) throw cancelled();
    onProgress?.({ percent: 5, speed: '', eta: '' });
    const baseName = media.owner ? `${media.owner}_${(options.itemIndex || 0) + 1}` : 'instagram';
    const result = await downloadImage(item.url, outputDir, baseName, item.type || 'image');
    if (signal?.aborted) throw cancelled();
    onProgress?.({ percent: 100, speed: '', eta: '' });
    return describeFile(
      result.filePath,
      mediaTitle(media),
      'instagram',
      'best',
      { thumbnailUrl: item.thumbnail || '', duration: 0, webpageUrl: options.url, mediaType: item.type || 'image' },
      result.fileSize,
    );
  }

  async function runYtdlp(options, outputDir, title, signal, onProgress) {
    let recoveryArgs = [];
    let youtubeRetried = false;
    let tiktokRetries = 0;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await once(recoveryArgs);
      } catch (error) {
        if (signal?.aborted || error.code === 'cancelled') throw cancelled();
        const diagnosis = error.diagnosis || error;
        if (options.platform === 'youtube' && !youtubeRetried && isYoutubeRecoveryError?.(diagnosis)) {
          youtubeRetried = true;
          onProgress?.({ percent: 0, speed: '', eta: '', status: 'recovering' });
          recoveryArgs = await ensureYoutubeRecovery();
          continue;
        }
        if (options.platform === 'tiktok' && diagnosis?.code === 'tiktok_challenge' && tiktokRetries < 2) {
          tiktokRetries += 1;
          await delay(tiktokRetries * 500, signal);
          continue;
        }
        throw error;
      }
    }
    throw fail('download_failed', 'Download failed after retries.');

    function once(extraArgs) {
      return new Promise((resolve, reject) => {
        let settled = false;
        let proc = null;
        const finish = (settle, value) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          settle(value);
        };
        const onAbort = () => {
          try { proc?.kill('SIGTERM'); } catch { /* already gone */ }
          if (sweepPartials) sweepPartials(outputDir);
          finish(reject, cancelled());
        };
        if (signal?.aborted) {
          finish(reject, cancelled());
          return;
        }
        signal?.addEventListener('abort', onAbort);
        try {
          proc = startDownload(
            {
              url: options.url,
              platform: options.platform,
              quality: options.quality || 'best',
              startTime: options.startTime,
              endTime: options.endTime,
              outputPath: outputDir,
              title: title || null,
              recoveryArgs: extraArgs,
            },
            (progress) => onProgress?.(progress),
            (filePath) => finish(resolve, filePath),
            (message, diagnosis) => {
              const error = fail(diagnosis?.code || 'download_failed', message || 'Download failed.');
              error.diagnosis = diagnosis;
              finish(reject, error);
            },
          );
          if (signal?.aborted) onAbort();
        } catch (error) {
          finish(reject, error);
        }
      });
    }
  }

  async function publish(saved, options, cached) {
    if (!onSaved) return;
    try {
      await onSaved({
        ...saved,
        quality: options.quality || 'best',
        clipStart: options.startTime || null,
        clipEnd: options.endTime || null,
        thumbnail: saved.thumbnail || cached?.thumbnailUrl || '',
        duration: saved.duration || cached?.duration || 0,
        uploader: cached?.uploader || '',
        webpageUrl: saved.webpageUrl || options.url,
      });
    } catch (error) {
      console.warn('[phone] history update failed:', error.message);
    }
  }

  return { inspect, download };
}

function detectFromFetcher(url) {
  const { detectPlatform } = require('../utils');
  return detectPlatform(url) || 'youtube';
}

function describeFile(filePath, title, platform, quality, cached, knownSize) {
  const ext = path.extname(filePath || '').replace('.', '').toLowerCase() || (quality === 'audio' ? 'm4a' : 'mp4');
  let fileSize = knownSize || 0;
  if (!fileSize) {
    try { fileSize = fs.statSync(filePath).size; } catch { fileSize = 0; }
  }
  return {
    filePath,
    title: title || 'download',
    platform,
    mediaType: cached?.mediaType || (quality === 'audio' ? 'audio' : 'video'),
    format: ext,
    fileSize,
    thumbnail: cached?.thumbnailUrl || '',
    duration: cached?.duration || 0,
    webpageUrl: cached?.webpageUrl || '',
  };
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort);
  });
}

module.exports = {
  createPhoneEngine,
};
