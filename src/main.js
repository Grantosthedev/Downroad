const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification, nativeImage, nativeTheme } = require('electron');
const Sentry = require('@sentry/electron/main');
const {
  addBreadcrumb,
  configureSentryReporting,
  reportError,
  scrubSentryEvent,
} = require('./sentry-report');

Sentry.init({
  dsn: 'https://ba4c6bd4faa389aa182a7407e6cc186f@o4511745156710400.ingest.us.sentry.io/4511745161166848',
  release: `downroad@${app.getVersion()}`,
  environment: app.isPackaged ? 'production' : 'development',
  sendDefaultPii: false,
  attachScreenshot: false,
  beforeSend: scrubSentryEvent,
});
configureSentryReporting(Sentry);
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Store = require('electron-store');
const { selectAppUpdateState } = require('./app-update-state');
const { fetchVideoInfo, startDownload, fetchCarouselVideos, fetchInstagramMediaViaYtdlp, cleanStaleYtdlpTemp } = require('./ytdlp');
const { initializeYtdlp, updateYtdlp, getCurrentYtdlpVersion, checkAppUpdate, checkYtdlpUpdate, ensureYtdlpFresh } = require('./updater');
const { nextEngineReadinessError } = require('./ytdlp-readiness');
const { validateDenoRuntime } = require('./runtime-readiness');
const { isValidURL, detectPlatform, normalizeYouTubeURL, normalizeInstagramURL, normalizeTikTokURL, binaryExists, getYtdlpPath, getBundledYtdlpPath, getUserBinDir, getFfmpegPath, pathExists, checkDiskSpace, sanitizeFilename } = require('./utils');
const { fetchMediaInfo, downloadImage, fetchImageAsDataUri, setYtdlpFetcher } = require('./media-fetcher');
const {
  ensureYoutubeRecovery,
  isYoutubeRecoveryError,
  stopYoutubeRecovery,
} = require('./youtube-recovery');

setYtdlpFetcher(fetchInstagramMediaViaYtdlp);

let appUpdateState = { status: 'idle' };
let githubUpdateIntervalStarted = false;
let activeGithubCheck = null;
let squirrelUpdater = null;

function sendAppUpdateStatus(data) {
  const nextState = selectAppUpdateState(appUpdateState, data);
  if (nextState === appUpdateState && nextState !== data) return;
  appUpdateState = nextState;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-update-status', appUpdateState);
  }
}

function setupAutoUpdater() {
  setupGithubUpdateChecker().catch(() => {});
  if (!app.isPackaged || process.platform !== 'darwin') {
    return;
  }
  try {
    const { autoUpdater } = require('electron');
    squirrelUpdater = autoUpdater;
    const feed = `https://update.electronjs.org/Grantosthedev/Downroad/${process.platform}-${process.arch}/${app.getVersion()}`;
    autoUpdater.setFeedURL({ url: feed });

    autoUpdater.on('checking-for-update', () => {
      sendAppUpdateStatus({ status: 'checking' });
    });

    autoUpdater.on('update-available', () => {
      sendAppUpdateStatus({ status: 'downloading' });
    });

    autoUpdater.on('update-not-available', () => {
      // Don't clobber a ready-to-install update with a later background check.
      if (appUpdateState.status === 'downloaded') return;
      sendAppUpdateStatus({ status: 'up-to-date' });
    });

    autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName) => {
      const ver = (releaseName || '').replace(/^v/, '') || 'new version';
      console.log(`[auto-update] Update downloaded: ${ver}`);
      sendAppUpdateStatus({ status: 'downloaded', version: ver, method: 'squirrel' });
    });

    autoUpdater.on('error', (err) => {
      console.warn('[auto-update] Error:', err.message);
      if (appUpdateState.status === 'downloaded') return;
      sendAppUpdateStatus({ status: 'error', error: err.message });
    });

    autoUpdater.checkForUpdates();
    setInterval(() => {
      try { autoUpdater.checkForUpdates(); } catch { /* ignore */ }
    }, 6 * 60 * 60 * 1000);
  } catch (err) {
    console.warn('[auto-update] Squirrel disabled:', err.message);
    setupGithubUpdateChecker();
  }
}

async function runGithubUpdateCheck({ force = false } = {}) {
  if (activeGithubCheck) {
    if (!force) return activeGithubCheck;
    try { await activeGithubCheck; } catch { /* start fresh below */ }
  }

  if (!force && (appUpdateState.status === 'available' || appUpdateState.status === 'downloaded')) {
    sendAppUpdateStatus(appUpdateState);
    return appUpdateState;
  }

  const run = async () => {
    const currentVersion = app.getVersion();
    sendAppUpdateStatus({ status: 'checking' });
    const result = await checkAppUpdate(currentVersion);
    if (result.error) {
      sendAppUpdateStatus({ status: 'error', error: result.error });
    } else if (result.available) {
      sendAppUpdateStatus({
        status: 'available',
        version: result.version,
        url: result.url,
        method: 'github',
        autoDownloading: Boolean(squirrelUpdater),
      });
    } else {
      sendAppUpdateStatus({ status: 'up-to-date' });
    }
    return appUpdateState;
  };

  activeGithubCheck = run()
    .catch((err) => {
      reportError(err, { phase: 'app-update-check', platform: process.platform });
      sendAppUpdateStatus({ status: 'error', error: err.message || 'Update check failed' });
      return appUpdateState;
    })
    .finally(() => {
      activeGithubCheck = null;
    });

  return activeGithubCheck;
}

async function setupGithubUpdateChecker() {
  await runGithubUpdateCheck();
  if (!githubUpdateIntervalStarted) {
    githubUpdateIntervalStarted = true;
    setInterval(() => {
      runGithubUpdateCheck().catch(() => {});
    }, 6 * 60 * 60 * 1000);
  }
}

ipcMain.handle('install-update', () => {
  if (!app.isPackaged || process.platform !== 'darwin' || !squirrelUpdater) {
    return { success: false, error: 'Auto-install only works in the packaged Mac app.' };
  }
  try {
    squirrelUpdater.quitAndInstall();
    return { success: true };
  } catch (err) {
    console.warn('[auto-update] quitAndInstall failed:', err.message);
    reportError(err, { phase: 'app-update-install', platform: process.platform });
    return { success: false, error: err.message || 'Couldn\'t install the update.' };
  }
});

ipcMain.handle('get-app-update-status', () => appUpdateState);

const GOOD_STICKERS = [
  'good14.png', 'good23.png', 'good24.png', 'good25.png', 'good26.png',
  'good27.png', 'good28.png', 'good29.png', 'good30.png', 'good31.png',
  'good32.png', 'good33.png',
];
const BAD_STICKERS = [
  'bad11.png', 'bad12.png', 'bad13.png', 'bad14.png',
  'bad15.png', 'bad16.png', 'bad17.png',
];

function getStickerIcon(type) {
  const pool = type === 'bad' ? BAD_STICKERS : GOOD_STICKERS;
  const name = pool[Math.floor(Math.random() * pool.length)];
  try {
    const buf = fs.readFileSync(path.join(__dirname, 'renderer', 'stickers', name));
    return nativeImage.createFromBuffer(buf);
  } catch {
    return null;
  }
}

const store = new Store({
  defaults: {
    downloadPath: path.join(app.getPath('downloads'), 'YT Clips'),
    quality: 'best',
    autoPaste: true,
    showInFinder: false,
    instantDownload: false,
    mode: 'unhinged',
    windowBounds: { width: 880, height: 640 },
    downloadHistory: [],
    projects: [],
    projectHues: {},
    projectSubfolders: {},
    activeProject: null,
    lastYtdlpCheck: 0,
    ytdlpEngineState: {},
    lastCacheCleared: 0,
  },
});

function nt(unhinged, professional, diabolical) {
  const mode = store.get('mode');
  if (mode === 'professional') return professional;
  if (mode === 'diabolical') return diabolical || unhinged;
  return unhinged;
}

const SEED_HUES = [180, 280, 80, 230, 130, 310, 55];

function assignOptimalHue(takenHues) {
  const MIN = 40, MAX = 320, MIN_DIST = 25;
  const taken = new Set(takenHues);

  for (const seed of SEED_HUES) {
    if ([...taken].every(h => Math.abs(h - seed) >= MIN_DIST)) return seed;
  }

  const sorted = [...takenHues].sort((a, b) => a - b);
  let bestGap = sorted[0] - MIN;
  let bestMid = MIN + bestGap / 2;

  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1] - sorted[i];
    if (gap > bestGap) { bestGap = gap; bestMid = sorted[i] + gap / 2; }
  }

  const lastGap = MAX - sorted[sorted.length - 1];
  if (lastGap > bestGap) bestMid = sorted[sorted.length - 1] + lastGap / 2;

  return Math.round(bestMid);
}

function ensureProjectHues() {
  const projects = store.get('projects');
  const hues = { ...store.get('projectHues') };
  let changed = false;

  for (const name of Object.keys(hues)) {
    if (!projects.includes(name)) { delete hues[name]; changed = true; }
  }
  for (const name of projects) {
    if (hues[name] == null) { hues[name] = assignOptimalHue(Object.values(hues)); changed = true; }
  }

  if (changed) store.set('projectHues', hues);
  return hues;
}

const videoInfoCache = new Map();

let mainWindow = null;
const activeDownloads = new Map();
let ytdlpUpdatePromise = null;
let ytdlpReadyError = null;
let denoReadinessPromise = null;
let denoReadyError = null;

async function fetchVideoInfoWithRecovery(url, platform) {
  const maxAttempts = platform === 'tiktok' ? 3 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchVideoInfo(url, platform);
    } catch (error) {
      if (platform === 'youtube' && isYoutubeRecoveryError(error)) {
        console.warn(`[youtube-recovery] Retrying metadata after ${error.code}`);
        const recoveryArgs = await ensureYoutubeRecovery();
        return fetchVideoInfo(url, platform, { recoveryArgs });
      }
      if (platform !== 'tiktok' || error.code !== 'tiktok_challenge' || attempt === maxAttempts) {
        throw error;
      }
      console.warn(`[tiktok-recovery] Retrying metadata after verification challenge (${attempt}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, attempt * 500));
    }
  }
  throw new Error('TikTok metadata recovery exhausted unexpectedly.');
}

async function awaitYtdlpReady(url) {
  if (ytdlpUpdatePromise) await ytdlpUpdatePromise;
  if (ytdlpReadyError) {
    throw new Error(`Download engine unavailable: ${ytdlpReadyError}`);
  }
  if (detectPlatform(url || '') === 'youtube') {
    if (denoReadinessPromise) await denoReadinessPromise;
    if (denoReadyError) {
      throw new Error(`YouTube runtime unavailable: ${denoReadyError}`);
    }
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  const { width, height } = store.get('windowBounds');

  // Apply saved theme before window creation so vibrancy uses the right appearance
  const savedTheme = store.get('theme', 'auto');
  nativeTheme.themeSource = savedTheme === 'dark' ? 'dark' : savedTheme === 'light' ? 'light' : 'system';

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 840,
    minHeight: 580,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    transparent: true,
    backgroundColor: '#00000000',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ['https://*.cdninstagram.com/*', 'https://*.fbcdn.net/*'] },
    (details, callback) => {
      details.requestHeaders['Referer'] = 'https://www.instagram.com/';
      details.requestHeaders['Origin'] = 'https://www.instagram.com';
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    setupAutoUpdater();
  });

  mainWindow.on('focus', () => {
    mainWindow.webContents.send('window-focus');
  });

  mainWindow.on('resize', () => {
    try {
      const bounds = mainWindow.getBounds();
      store.set('windowBounds', { width: bounds.width, height: bounds.height });
    } catch { /* ignore persist errors */ }
  });

  mainWindow.on('close', (e) => {
    if (activeDownloads.size > 0) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Cancel', 'Quit Anyway'],
        defaultId: 0,
        cancelId: 0,
        title: 'Active Downloads, Fam',
        message: `You got ${activeDownloads.size} download${activeDownloads.size > 1 ? 's' : ''} running. Quit anyway? smh`,
      });
      if (choice === 0) {
        e.preventDefault();
        return;
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- IPC Handlers ---

ipcMain.handle('fetch-video-info', async (_event, url) => {
  if (!isValidURL(url)) {
    throw new Error('That\'s not a valid URL. Paste a YouTube, Instagram, or TikTok link.');
  }
  await awaitYtdlpReady(url);
  const platform = detectPlatform(url);
  addBreadcrumb('Fetch video info', { platform });
  const normalizedUrl = platform === 'youtube'
    ? normalizeYouTubeURL(url)
    : platform === 'instagram'
      ? normalizeInstagramURL(url)
      : normalizeTikTokURL(url);
  const cacheKey = normalizedUrl;
  const fetchUrl = normalizedUrl;

  const info = await fetchVideoInfoWithRecovery(fetchUrl, platform);

  if (platform === 'youtube' && info.isLive) {
    throw new Error('Live streams can\'t be clipped, bitch. Wait for the stream to end like everyone else.');
  }
  if (videoInfoCache.size > 50) {
    const oldest = videoInfoCache.keys().next().value;
    videoInfoCache.delete(oldest);
  }
  videoInfoCache.set(cacheKey, info);
  return info;
});

const VALID_QUALITIES = new Set(['best', 'audio']);
const VALID_QUALITY_HEIGHT = /^\d{3,4}$/;
const TIME_FORMAT = /^\d{2}:\d{2}:\d{2}$/;

ipcMain.handle('start-download', async (event, options) => {
  if (!options || typeof options !== 'object') {
    throw new Error('Invalid download options, you inept noodle.');
  }
  if (!isValidURL(options.url)) {
    throw new Error('That\'s not a valid URL. Paste a YouTube, Instagram, or TikTok link.');
  }
  await awaitYtdlpReady(options.url);
  if (options.quality && !VALID_QUALITIES.has(options.quality) && !VALID_QUALITY_HEIGHT.test(options.quality)) {
    throw new Error('Invalid quality setting, you thick as a brick.');
  }
  if (options.startTime && !TIME_FORMAT.test(options.startTime)) {
    throw new Error('Invalid start time format, you numbskull.');
  }
  if (options.endTime && !TIME_FORMAT.test(options.endTime)) {
    throw new Error('Invalid end time format, you clown.');
  }

  const platform = detectPlatform(options.url);
  addBreadcrumb('Download requested', {
    platform,
    quality: options.quality || 'best',
    mediaType: options.mediaType || 'video',
  });
  const basePath = options.outputPath || store.get('downloadPath');
  const activeProject = store.get('activeProject');
  const useSubfolder = activeProject && store.get('projectSubfolders')[activeProject] !== false;
  const downloadPath = useSubfolder ? path.join(basePath, activeProject) : basePath;

  if (!pathExists(downloadPath)) {
    try {
      fs.mkdirSync(downloadPath, { recursive: true });
    } catch {
      throw new Error('Cannot save to this folder, you clumsy oaf. Pick another goddamn folder.');
    }
  }

  const freeSpace = await checkDiskSpace(downloadPath);
  if (freeSpace < 100 * 1024 * 1024) {
    throw new Error('Disk space is fucking cooked. Free some space or switch drives.');
  }

  try {
    fs.accessSync(downloadPath, fs.constants.W_OK);
  } catch {
    throw new Error('Cannot save to this folder, you clumsy oaf. Pick another goddamn folder.');
  }

  const downloadId = crypto.randomUUID();
  const downloadUrl = platform === 'youtube'
    ? normalizeYouTubeURL(options.url)
    : platform === 'instagram'
      ? normalizeInstagramURL(options.url)
      : normalizeTikTokURL(options.url);

  const downloadOptions = {
    url: downloadUrl,
    quality: options.quality || 'best',
    startTime: options.startTime,
    endTime: options.endTime,
    outputPath: downloadPath,
    title: options.title || null,
    platform,
  };

  let recoveryAttempted = false;
  let tiktokRecoveryAttempts = 0;
  let proc = null;
  const startDownloadAttempt = (attemptOptions = downloadOptions) => {
    proc = startDownload(
      attemptOptions,
      (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('download-progress', { id: downloadId, ...progress });
        }
      },
      (filePath) => {
      const wasCancelledLate = activeDownloads.get(downloadId)?.cancelled;
      activeDownloads.delete(downloadId);

      if (wasCancelledLate) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('download-cancelled', { id: downloadId });
        }
        return;
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-complete', { id: downloadId, filePath });
      }

      try {
        const cachedInfo = videoInfoCache.get(downloadOptions.url) || {};
        let fileSize = 0;
        try { fileSize = fs.statSync(filePath).size; } catch { /* ignore */ }
        const ext = path.extname(filePath || '').replace('.', '').toLowerCase();

        const historyEntry = {
          id: crypto.randomUUID(),
          videoId: cachedInfo.id || '',
          title: cachedInfo.title || downloadOptions.title,
          thumbnail: cachedInfo.thumbnail || options.thumbnail || '',
          uploader: cachedInfo.uploader || '',
          channel: cachedInfo.channel || '',
          channelUrl: cachedInfo.channelUrl || '',
          webpageUrl: cachedInfo.webpageUrl || downloadOptions.url,
          uploadDate: cachedInfo.uploadDate || '',
          description: cachedInfo.description || '',
          duration: cachedInfo.duration || options.duration || 0,
          viewCount: cachedInfo.viewCount ?? null,
          likeCount: cachedInfo.likeCount ?? null,
          categories: cachedInfo.categories || [],
          tags: cachedInfo.tags || [],
          license: cachedInfo.license || '',
          quality: downloadOptions.quality,
          resolution: cachedInfo.formats?.[0]?.label ?? cachedInfo.formats?.[0] ?? null,
          clipStart: downloadOptions.startTime || null,
          clipEnd: downloadOptions.endTime || null,
          filePath: filePath || '',
          fileSize,
          format: ext || (downloadOptions.quality === 'audio' ? 'm4a' : 'mp4'),
          downloadedAt: new Date().toISOString(),
          platform: cachedInfo.platform || platform || 'youtube',
          mediaType: cachedInfo.mediaType || 'video',
          project: activeProject || null,
        };

        const history = store.get('downloadHistory');
        history.unshift(historyEntry);
        if (history.length > 500) history.length = 500;
        store.set('downloadHistory', history);

        // For instant/cache-miss downloads, do a background info fetch so the
        // history entry gets filled in with title, thumbnail, duration, etc.
        if (Object.keys(cachedInfo).length === 0) {
          fetchVideoInfoWithRecovery(downloadOptions.url, platform).then(info => {
            if (!info) return;
            const hist = store.get('downloadHistory');
            const idx = hist.findIndex(e => e.id === historyEntry.id);
            if (idx === -1) return;
            hist[idx] = {
              ...hist[idx],
              title:       hist[idx].title       || info.title       || '',
              thumbnail:   hist[idx].thumbnail   || info.thumbnail   || '',
              duration:    hist[idx].duration    || info.duration    || 0,
              uploader:    hist[idx].uploader    || info.uploader    || '',
              channel:     hist[idx].channel     || info.channel     || '',
              channelUrl:  hist[idx].channelUrl  || info.channelUrl  || '',
              uploadDate:  hist[idx].uploadDate  || info.uploadDate  || '',
              description: hist[idx].description || (info.description || '').slice(0, 300),
              viewCount:   hist[idx].viewCount  ?? info.viewCount  ?? null,
              likeCount:   hist[idx].likeCount  ?? info.likeCount  ?? null,
              categories:  hist[idx].categories?.length ? hist[idx].categories : (info.categories || []),
              tags:        hist[idx].tags?.length        ? hist[idx].tags        : (info.tags || []).slice(0, 10),
            };
            store.set('downloadHistory', hist);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('history-entry-updated', hist[idx]);
            }
          }).catch(() => {}); // silent best-effort — never block the UI
        }

        if (Notification.isSupported()) {
          const notif = new Notification({
            title: nt('WTF it actually worked, download complete', 'Download complete', 'DONE. IT ACTUALLY WORKED. SHOCKING.'),
            body: cachedInfo.title || path.basename(filePath || nt('Video saved somehow, lol', 'Video saved', 'FILE SAVED. YOU\'RE WELCOME.')),
            silent: false,
            icon: getStickerIcon('good'),
            actions: [{ type: 'button', text: 'Show File' }],
          });
          notif.on('click', () => {
            if (filePath) shell.showItemInFolder(filePath);
          });
          notif.on('action', () => {
            if (filePath) shell.showItemInFolder(filePath);
          });
          notif.show();
        }

        if (store.get('showInFinder') && filePath) {
          shell.showItemInFolder(filePath);
        }
      } catch { /* history/notification must never block the completion event */ }
      },
      (errorMsg, diagnosis) => {
      const entry = activeDownloads.get(downloadId);
      const wasCancelled = entry?.cancelled;

      if (
        !wasCancelled
        && platform === 'youtube'
        && !recoveryAttempted
        && isYoutubeRecoveryError(diagnosis)
      ) {
        recoveryAttempted = true;
        console.warn(`[youtube-recovery] Retrying download after ${diagnosis.code}`);
        ensureYoutubeRecovery()
          .then(recoveryArgs => {
            const current = activeDownloads.get(downloadId);
            if (!current || current.cancelled) {
              activeDownloads.delete(downloadId);
              if (current?.cancelled && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-cancelled', { id: downloadId });
              }
              return;
            }
            startDownloadAttempt({ ...downloadOptions, recoveryArgs });
          })
          .catch(error => {
            activeDownloads.delete(downloadId);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('download-error', {
                id: downloadId,
                error: error.message || errorMsg,
              });
            }
          });
        return;
      }

      if (
        !wasCancelled
        && platform === 'tiktok'
        && diagnosis?.code === 'tiktok_challenge'
        && tiktokRecoveryAttempts < 2
      ) {
        tiktokRecoveryAttempts += 1;
        console.warn(`[tiktok-recovery] Retrying download after verification challenge (${tiktokRecoveryAttempts}/2)`);
        setTimeout(() => {
          const current = activeDownloads.get(downloadId);
          if (!current || current.cancelled) {
            activeDownloads.delete(downloadId);
            if (current?.cancelled && mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('download-cancelled', { id: downloadId });
            }
            return;
          }
          startDownloadAttempt();
        }, tiktokRecoveryAttempts * 500);
        return;
      }

      activeDownloads.delete(downloadId);

      if (wasCancelled) {
        try {
          const files = fs.readdirSync(downloadPath);
          for (const file of files) {
            if (file.endsWith('.part') || file.endsWith('.ytdl')) {
              fs.unlinkSync(path.join(downloadPath, file));
            }
          }
        } catch { /* ignore cleanup errors */ }

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('download-cancelled', { id: downloadId });
        }
        return;
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-error', { id: downloadId, error: errorMsg });
      }

      if (Notification.isSupported()) {
        const notif = new Notification({
          title: nt('What the Helly! Download Failed', 'Download failed', 'DOWNLOAD EXPLODED. GREAT JOB.'),
          body: errorMsg || nt('idk how to tell you but... Something went wrong.', 'Something went wrong.', 'SOMETHING BROKE. BIG SURPRISE.'),
          silent: false,
          icon: getStickerIcon('bad'),
        });
        notif.on('click', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
          }
        });
        notif.show();
      }
      },
    );
    const current = activeDownloads.get(downloadId);
    activeDownloads.set(downloadId, {
      process: proc,
      options: attemptOptions,
      cancelled: current?.cancelled === true,
    });
    return proc;
  };

  startDownloadAttempt();
  return { id: downloadId };
});

ipcMain.handle('fetch-media-info', async (_event, url) => {
  await awaitYtdlpReady(url);
  return await fetchMediaInfo(url);
});

ipcMain.handle('fetch-carousel-videos', async (_event, url) => {
  await awaitYtdlpReady(url);
  return await fetchCarouselVideos(url);
});

ipcMain.handle('proxy-image', async (_event, url) => {
  try { return await fetchImageAsDataUri(url); } catch { return null; }
});

ipcMain.handle('download-image', async (_event, options) => {
  const imageBasePath = options.outputPath || store.get('downloadPath');
  const imageActiveProject = store.get('activeProject');
  const imageUseSubfolder = imageActiveProject && store.get('projectSubfolders')[imageActiveProject] !== false;
  const downloadPath = imageUseSubfolder ? path.join(imageBasePath, imageActiveProject) : imageBasePath;

  if (!pathExists(downloadPath)) {
    try {
      fs.mkdirSync(downloadPath, { recursive: true });
    } catch {
      throw new Error('Cannot save to this folder. Pick another folder.');
    }
  }

  const freeSpace = await checkDiskSpace(downloadPath);
  if (freeSpace < 50 * 1024 * 1024) {
    throw new Error('Not enough disk space. Free some space or switch drives.');
  }

  try {
    fs.accessSync(downloadPath, fs.constants.W_OK);
  } catch {
    throw new Error('Cannot write to this folder. Pick another folder.');
  }

  const result = await downloadImage(options.url, downloadPath, options.filename || 'image', options.mediaType);

  if (store.get('showInFinder') && result.filePath) {
    shell.showItemInFolder(result.filePath);
  }

  const history = store.get('downloadHistory');
  const groupId = options.carouselGroupId;

  if (groupId) {
    const existing = history.find(e => e.carouselGroupId === groupId);
    const childItem = {
      filePath: result.filePath,
      fileSize: result.fileSize,
      mediaType: options.mediaType || 'image',
      format: path.extname(result.filePath).replace('.', '').toLowerCase() || 'jpg',
    };

    if (existing) {
      existing.carouselItems.push(childItem);
      existing.fileSize = existing.carouselItems.reduce((sum, ci) => sum + (ci.fileSize || 0), 0);
    } else {
      const parentEntry = {
        id: crypto.randomUUID(),
        carouselGroupId: groupId,
        videoId: '',
        title: options.title || options.filename || 'Instagram carousel',
        thumbnail: options.thumbnail || '',
        uploader: options.postOwner || '',
        channel: options.postOwner || '',
        channelUrl: '',
        webpageUrl: options.webpageUrl || '',
        uploadDate: '',
        description: (options.caption || '').slice(0, 300),
        duration: 0,
        viewCount: null,
        likeCount: null,
        categories: [],
        tags: [],
        license: '',
        quality: 'best',
        clipStart: null,
        clipEnd: null,
        filePath: result.filePath,
        fileSize: result.fileSize,
        format: path.extname(result.filePath).replace('.', '').toLowerCase() || 'jpg',
        downloadedAt: new Date().toISOString(),
        platform: 'instagram',
        mediaType: 'carousel',
        carouselItems: [childItem],
        project: imageActiveProject || null,
      };
      history.unshift(parentEntry);
    }
  } else {
    if (Notification.isSupported()) {
      const isVideo = options.mediaType === 'video';
      const notif = new Notification({
        title: isVideo
          ? nt('Reel downloaded, you legend', 'Reel downloaded', 'REEL DOWNLOADED. DON\'T THANK ME.')
          : nt('you downloaded an image, well fucking done', 'Image downloaded', 'IMAGE DOWNLOADED. OUTSTANDING WORK, I\'M SURE.'),
        body: options.title || options.filename || (isVideo
          ? nt('Reel saved, fam', 'Reel saved', 'REEL SAVED. YOU\'RE WELCOME.')
          : nt('Image saved, fam', 'Image saved', 'IMAGE SAVED. TRY NOT TO LOSE IT.')),
        silent: false,
        icon: getStickerIcon('good'),
      });
      notif.on('click', () => {
        if (result.filePath) shell.showItemInFolder(result.filePath);
      });
      notif.show();
    }

    const historyEntry = {
      id: crypto.randomUUID(),
      videoId: '',
      title: options.title || options.filename || 'Instagram post',
      thumbnail: options.thumbnail || '',
      uploader: options.postOwner || '',
      channel: options.postOwner || '',
      channelUrl: '',
      webpageUrl: options.webpageUrl || '',
      uploadDate: '',
      description: (options.caption || '').slice(0, 300),
      duration: options.duration || 0,
      viewCount: null,
      likeCount: null,
      categories: [],
      tags: [],
      license: '',
      quality: 'best',
      clipStart: null,
      clipEnd: null,
      filePath: result.filePath,
      fileSize: result.fileSize,
      format: path.extname(result.filePath).replace('.', '').toLowerCase() || 'jpg',
      downloadedAt: new Date().toISOString(),
      platform: 'instagram',
      mediaType: options.mediaType || 'image',
      project: imageActiveProject || null,
    };
    history.unshift(historyEntry);
  }

  if (history.length > 500) history.length = 500;
  store.set('downloadHistory', history);

  return { filePath: result.filePath, fileSize: result.fileSize };
});

ipcMain.handle('cancel-download', async (_event, downloadId) => {
  function killEntry(entry) {
    entry.cancelled = true;
    entry.process.kill('SIGTERM');
    setTimeout(() => { try { entry.process.kill('SIGKILL'); } catch {} }, 3000);
  }
  if (downloadId) {
    const entry = activeDownloads.get(downloadId);
    if (entry) {
      killEntry(entry);
      return { cancelled: true };
    }
    return { cancelled: false };
  }
  for (const [, entry] of activeDownloads) {
    killEntry(entry);
  }
  return { cancelled: true };
});

ipcMain.handle('select-folder', async () => {
  const dialogOpts = {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Pick a folder, mother fucka',
    defaultPath: store.get('downloadPath'),
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(mainWindow, dialogOpts)
    : await dialog.showOpenDialog(dialogOpts);
  if (!result.canceled && result.filePaths.length > 0) {
    const selected = result.filePaths[0];
    store.set('downloadPath', selected);
    return selected;
  }
  return null;
});

ipcMain.handle('reveal-in-finder', async (_event, filePath) => {
  if (filePath) {
    const resolved = path.resolve(filePath);
    if (fs.existsSync(resolved)) {
      shell.showItemInFolder(resolved);
      return { found: true };
    }
    const savedDir = path.dirname(resolved);
    if (fs.existsSync(savedDir)) {
      shell.openPath(savedDir);
      return { found: false };
    }
  }
  shell.openPath(path.resolve(store.get('downloadPath')));
  return { found: false };
});

ipcMain.handle('get-settings', async () => {
  return {
    downloadPath: store.get('downloadPath'),
    quality: store.get('quality'),
    autoPaste: store.get('autoPaste'),
    showInFinder: store.get('showInFinder'),
    instantDownload: store.get('instantDownload'),
    mode: store.get('mode'),
    theme: store.get('theme', 'auto'),
    activeProject: store.get('activeProject'),
    projects: store.get('projects'),
    projectHues: ensureProjectHues(),
    projectSubfolders: store.get('projectSubfolders'),
  };
});

const ALLOWED_SETTINGS = new Set(['quality', 'autoPaste', 'downloadPath', 'showInFinder', 'instantDownload', 'mode', 'theme']);

ipcMain.handle('set-setting', async (_event, key, value) => {
  if (!ALLOWED_SETTINGS.has(key)) return;
  store.set(key, value);
  if (key === 'theme') {
    nativeTheme.themeSource = value === 'dark' ? 'dark' : value === 'light' ? 'light' : 'system';
  }
});

ipcMain.handle('update-ytdlp', async () => {
  if (ytdlpUpdatePromise) await ytdlpUpdatePromise;
  const result = await updateYtdlp();
  ytdlpReadyError = nextEngineReadinessError(ytdlpReadyError, result);
  return result;
});

ipcMain.handle('check-ytdlp-update', async () => {
  if (ytdlpUpdatePromise) await ytdlpUpdatePromise;
  const result = await checkYtdlpUpdate();
  ytdlpReadyError = nextEngineReadinessError(ytdlpReadyError, result);
  return result;
});

ipcMain.handle('get-ytdlp-version', async () => {
  return await getCurrentYtdlpVersion();
});

ipcMain.handle('check-app-update', async () => {
  // Already have something actionable: re-emit so the UI can react again.
  if (appUpdateState.status === 'downloaded' || appUpdateState.status === 'available') {
    sendAppUpdateStatus(appUpdateState);
    return appUpdateState;
  }

  if (app.isPackaged && process.platform === 'darwin' && squirrelUpdater) {
    try {
      squirrelUpdater.checkForUpdates();
      return appUpdateState;
    } catch (err) {
      console.warn('[auto-update] Manual check failed:', err.message);
      // Fall through to GitHub check
    }
  }
  return runGithubUpdateCheck({ force: true });
});

ipcMain.handle('show-notification', async (_event, title, body, filePath, stickerType = 'good') => {
  if (Notification.isSupported()) {
    const notifOptions = { title, body, silent: false, icon: getStickerIcon(stickerType) };
    if (filePath) notifOptions.actions = [{ type: 'button', text: 'Show File' }];
    const notif = new Notification(notifOptions);
    notif.on('click', () => {
      if (filePath) shell.showItemInFolder(filePath);
      else if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
    });
    notif.on('action', () => {
      if (filePath) shell.showItemInFolder(filePath);
    });
    notif.show();
  }
});

ipcMain.handle('get-clipboard', async () => {
  return clipboard.readText();
});

ipcMain.handle('get-app-version', async () => {
  return app.getVersion();
});

function sweepPartialFiles(dir) {
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (
        file.endsWith('.part') ||
        file.endsWith('.ytdl') ||
        file.endsWith('.compat.tmp.mp4') ||
        file.endsWith('.aac.tmp.mp4')
      ) {
        try { fs.unlinkSync(path.join(dir, file)); } catch { /* skip locked files */ }
      }
    }
  } catch { /* non-fatal */ }
}

ipcMain.handle('cleanup-partial-files', async (_event, dir) => {
  const allowedBase = store.get('downloadPath');
  const targetDir = dir || allowedBase;
  const resolved = path.resolve(targetDir);
  if (!resolved.startsWith(path.resolve(allowedBase))) return;
  sweepPartialFiles(resolved);
});

ipcMain.handle('get-projects', async () => {
  return store.get('projects');
});

ipcMain.handle('get-active-project', async () => {
  return store.get('activeProject');
});

ipcMain.handle('set-active-project', async (_event, projectName) => {
  if (projectName && typeof projectName === 'string') {
    const sanitized = sanitizeFilename(projectName).substring(0, 50);
    if (!sanitized) return null;
    store.set('activeProject', sanitized);
    const projects = store.get('projects');
    const filtered = projects.filter(p => p !== sanitized);
    filtered.unshift(sanitized);
    store.set('projects', filtered);

    const hues = store.get('projectHues');
    if (hues[sanitized] == null) {
      hues[sanitized] = assignOptimalHue(Object.values(hues));
      store.set('projectHues', hues);
    }

    return { name: sanitized, projectHues: hues };
  }
  store.set('activeProject', null);
  return null;
});

ipcMain.handle('create-project', async (_event, projectName) => {
  if (!projectName || typeof projectName !== 'string') return null;
  const sanitized = sanitizeFilename(projectName).substring(0, 50);
  if (!sanitized) return null;

  const projects = store.get('projects');
  if (!projects.includes(sanitized)) {
    projects.unshift(sanitized);
    store.set('projects', projects);
  }

  const hues = store.get('projectHues');
  if (hues[sanitized] == null) {
    hues[sanitized] = assignOptimalHue(Object.values(hues));
    store.set('projectHues', hues);
  }

  return { name: sanitized, projectHues: hues };
});

ipcMain.handle('delete-project', async (_event, projectName) => {
  if (!projectName) return { projects: store.get('projects'), projectHues: store.get('projectHues') };
  const projects = store.get('projects').filter(p => p !== projectName);
  store.set('projects', projects);
  const hues = store.get('projectHues');
  delete hues[projectName];
  store.set('projectHues', hues);
  const subfolders = store.get('projectSubfolders');
  delete subfolders[projectName];
  store.set('projectSubfolders', subfolders);
  if (store.get('activeProject') === projectName) {
    store.set('activeProject', null);
  }

  // Clear orphaned project references from history so deleted project names
  // do not ghost in the history filter dropdown.
  const history = store.get('downloadHistory');
  const updated = history.map(e => e.project === projectName ? { ...e, project: null } : e);
  store.set('downloadHistory', updated);

  return { projects, projectHues: hues };
});

ipcMain.handle('set-project-subfolder', (_event, name, enabled) => {
  const subfolders = { ...store.get('projectSubfolders') };
  subfolders[name] = enabled;
  store.set('projectSubfolders', subfolders);
  return subfolders;
});

ipcMain.handle('get-history', async () => {
  return store.get('downloadHistory');
});

ipcMain.handle('delete-history-entry', async (_event, id, deleteFile = false) => {
  const history = store.get('downloadHistory');
  const entry = history.find(e => e.id === id);

  let filesDeleted = 0;
  const errors = [];

  if (deleteFile && entry) {
    const paths = [];
    if (entry.filePath) paths.push(entry.filePath);
    if (entry.mediaType === 'carousel' && Array.isArray(entry.carouselItems)) {
      for (const item of entry.carouselItems) {
        if (item.filePath) paths.push(item.filePath);
      }
    }

    await Promise.all(paths.map(async (fp) => {
      try {
        await fs.promises.unlink(fp);
        filesDeleted++;
      } catch (err) {
        if (err.code !== 'ENOENT') {
          errors.push(`${path.basename(fp)}: ${err.message}`);
        }
      }
    }));
  }

  store.set('downloadHistory', history.filter(e => e.id !== id));
  return { filesDeleted, errors };
});

ipcMain.handle('clear-history', async () => {
  store.set('downloadHistory', []);
});

ipcMain.handle('update-history-entry-project', async (_event, { id, project }) => {
  const history = store.get('downloadHistory');
  const idx = history.findIndex(e => e.id === id);
  if (idx === -1) return null;
  history[idx] = { ...history[idx], project: project || null };
  store.set('downloadHistory', history);
  return history[idx];
});

ipcMain.handle('open-external', async (_event, url) => {
  if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url);
  }
});

ipcMain.handle('save-file', async (_event, { defaultPath, content }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath,
    filters: [{ name: 'CSV Spreadsheet', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { saved: false };
  await fs.promises.writeFile(filePath, content, 'utf8');
  return { saved: true, filePath };
});

// --- App lifecycle ---

const CACHE_CLEAR_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

app.on('ready', () => {
  app.setName('Downroad');
  cleanStaleYtdlpTemp();
  try { fs.unlinkSync(path.join(app.getPath('userData'), 'youtube-cookies.txt')); } catch {}

  // Periodically clear the Chromium disk cache so thumbnail images and other
  // network responses don't accumulate silently over years of use.
  const lastCacheCleared = store.get('lastCacheCleared');
  if (!lastCacheCleared || (Date.now() - lastCacheCleared) >= CACHE_CLEAR_INTERVAL_MS) {
    const { session } = require('electron');
    session.defaultSession.clearCache().then(() => {
      store.set('lastCacheCleared', Date.now());
      console.log('[startup] Chromium cache cleared (monthly maintenance)');
    }).catch((err) => {
      console.warn('[startup] Cache clear failed (non-fatal):', err.message);
    });
  }

  createWindow();

  const sendActivity = (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('background-activity', data);
    }
  };

  let activityNotified = false;
  let pendingActivityResult = null;
  const needsInitialDownload = !binaryExists(getYtdlpPath());

  denoReadinessPromise = validateDenoRuntime({ packaged: app.isPackaged })
    .then((result) => {
      denoReadyError = null;
      Sentry.setTag('deno_version', String(result.version));
      return result;
    })
    .catch((error) => {
      denoReadyError = error?.message || 'Deno runtime validation failed';
      console.error('[startup] YouTube runtime is not ready:', denoReadyError);
      return null;
    });

  ytdlpUpdatePromise = (async () => {
    if (needsInitialDownload) {
      console.log('[startup] yt-dlp not found in userData, initializing...');
      sendActivity({ type: 'ytdlp-check', status: 'downloading' });
      const result = await initializeYtdlp();
      if (!result.success) {
        console.error('[startup] yt-dlp initialization failed:', result.error);
        dialog.showErrorBox(
          'Setup Failed',
          `Could not set up yt-dlp: ${result.error}\n\nPlease restart the app. If the problem persists, check your internet connection.`,
        );
        app.quit();
        return null;
      }
      return result;
    }
    return ensureYtdlpFresh(store);
  })().then((result) => {
    if (!result) {
      ytdlpReadyError = 'Initial setup failed';
      return;
    }
    if (!result.success) {
      ytdlpReadyError = result.error || 'Required engine update failed';
      console.error('[startup] yt-dlp is not ready:', ytdlpReadyError);
      pendingActivityResult = { type: 'ytdlp-check', status: 'failed' };
      if (activityNotified) sendActivity(pendingActivityResult);
      return;
    }
    ytdlpReadyError = null;
    if (result.version) Sentry.setTag('ytdlp_version', String(result.version));
    if (result.channel) Sentry.setTag('ytdlp_channel', String(result.channel));
    if (result.success && !result.skipped) {
      console.log(`[startup] yt-dlp ready: ${result.version}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ytdlp-updated', result.version);
      }
      pendingActivityResult = { type: 'ytdlp-check', status: 'updated' };
    } else {
      pendingActivityResult = { type: 'ytdlp-check', status: 'up-to-date' };
    }
    if (activityNotified) sendActivity(pendingActivityResult);
  }).catch((error) => {
    ytdlpReadyError = error?.message || 'Engine setup failed';
    pendingActivityResult = { type: 'ytdlp-check', status: 'failed' };
    if (activityNotified) sendActivity(pendingActivityResult);
  }).finally(() => {
    ytdlpUpdatePromise = null;
  });

  mainWindow.webContents.once('did-finish-load', () => {
    if (!pendingActivityResult) {
      activityNotified = true;
      sendActivity({ type: 'ytdlp-check', status: needsInitialDownload ? 'downloading' : 'checking' });
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  stopYoutubeRecovery();
  for (const [, entry] of activeDownloads) {
    try { entry.process.kill('SIGTERM'); } catch { /* already dead */ }
    setTimeout(() => {
      try { entry.process.kill('SIGKILL'); } catch { /* already dead */ }
    }, 3000);
  }
  activeDownloads.clear();

  // Sweep any FFmpeg temp files left behind by a crash or force-quit.
  try {
    const downloadPath = store.get('downloadPath');
    if (downloadPath) sweepPartialFiles(path.resolve(downloadPath));
  } catch { /* non-fatal */ }
});
