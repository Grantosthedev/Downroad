const https = require('https');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile } = require('child_process');
const path = require('path');
const { getYtdlpPath, getUserBinDir, getBundledYtdlpPath } = require('./utils');
const {
  MINIMUM_FIXED_YTDLP_VERSION,
  YTDLP_CHANNEL,
  YTDLP_RELEASE_API,
  compareYtdlpVersions,
  isSupportedYtdlpVersion,
  releaseAsset,
} = require('./ytdlp-release');

const APP_REPO_API = 'https://api.github.com/repos/Grantosthedev/Downroad/releases/latest';

const MAX_REDIRECTS = 5;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
let activeYtdlpMutation = null;

function githubGet(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount >= MAX_REDIRECTS) {
      reject(new Error('Too many redirects'));
      return;
    }
    const req = https.get(url, {
      headers: {
        'User-Agent': 'YouTube-Clip-Downloader',
        Accept: 'application/vnd.github.v3+json',
      },
      timeout: 6000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        githubGet(res.headers.location, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid JSON response'));
        }
      });
    }).on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

const DOWNLOAD_INACTIVITY_TIMEOUT_MS = 60_000;

function downloadFileVerified(url, destPath, expectedSha256, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };

    if (redirectCount >= MAX_REDIRECTS) {
      reject(new Error('Too many redirects'));
      return;
    }

    const req = https.get(url, {
      headers: { 'User-Agent': 'Downroad' },
      timeout: DOWNLOAD_INACTIVITY_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadFileVerified(res.headers.location, destPath, expectedSha256, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const hash = crypto.createHash('sha256');
      const file = fs.createWriteStream(destPath, { mode: 0o755 });
      let inactivityTimer;
      const fail = (error) => {
        clearTimeout(inactivityTimer);
        file.destroy();
        try { fs.unlinkSync(destPath); } catch {}
        done(() => reject(error));
      };
      const resetTimer = () => {
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          res.destroy(new Error('Download stalled: no data received within timeout'));
        }, DOWNLOAD_INACTIVITY_TIMEOUT_MS);
      };

      resetTimer();
      res.on('data', (chunk) => {
        hash.update(chunk);
        resetTimer();
      });
      res.on('error', fail);
      file.on('error', fail);
      file.on('finish', () => {
        clearTimeout(inactivityTimer);
        file.close(() => {
          const actual = hash.digest('hex');
          if (actual !== expectedSha256.toLowerCase()) {
            try { fs.unlinkSync(destPath); } catch {}
            done(() => reject(new Error('yt-dlp checksum verification failed')));
            return;
          }
          done(() => resolve(actual));
        });
      });
      res.pipe(file);
    });
    req.on('error', (err) => done(() => reject(err)));
    req.on('timeout', () => req.destroy(new Error('Connection timed out while starting download')));
  });
}

async function getLatestYtdlpVersion() {
  try {
    const release = await githubGet(YTDLP_RELEASE_API);
    return release.tag_name;
  } catch {
    return null;
  }
}

function execPromise(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 5000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve(stdout);
    });
  });
}

async function stripQuarantine(filePath) {
  try {
    await execPromise('/usr/bin/xattr', ['-d', 'com.apple.quarantine', filePath]);
    console.log('[updater] Removed quarantine attribute');
  } catch (err) {
    console.log('[updater] xattr -d quarantine:', err.message || 'no attribute');
  }

  try {
    await execPromise('/usr/bin/xattr', ['-c', filePath]);
    console.log('[updater] Cleared all extended attributes');
  } catch (err) {
    console.log('[updater] xattr -c:', err.message);
  }

  try {
    await execPromise('/usr/bin/codesign', ['--force', '--sign', '-', filePath]);
    console.log('[updater] Ad-hoc signed binary');
  } catch (err) {
    console.log('[updater] codesign ad-hoc sign:', err.message);
  }
}

function testBinary(binPath) {
  return new Promise((resolve) => {
    execFile(binPath, ['--version'], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[updater] Binary test failed:', err.message);
        if (err.code) console.error('[updater]   code:', err.code);
        if (err.signal) console.error('[updater]   signal:', err.signal);
        if (stderr) console.error('[updater]   stderr:', stderr.substring(0, 500));
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function getCurrentYtdlpVersion() {
  const ytdlpPath = getYtdlpPath();
  return testBinary(ytdlpPath);
}

function engineMetadataPath(userBinDir = getUserBinDir()) {
  return path.join(userBinDir, 'yt-dlp-release.json');
}

function readEngineMetadata(userBinDir = getUserBinDir()) {
  try {
    return JSON.parse(fs.readFileSync(engineMetadataPath(userBinDir), 'utf8'));
  } catch {
    return null;
  }
}

function writeEngineMetadata(metadata, userBinDir = getUserBinDir()) {
  const target = engineMetadataPath(userBinDir);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

function shouldThrottleYtdlpCheck({ currentVersion, metadata, storedState, now = Date.now() }) {
  const checkedAt = Math.max(Number(metadata?.checkedAt) || 0, Number(storedState?.checkedAt) || 0);
  return Boolean(
    currentVersion
    && isSupportedYtdlpVersion(currentVersion)
    && metadata?.channel === YTDLP_CHANNEL
    && (now - checkedAt) < CHECK_INTERVAL_MS
  );
}

function preserveSupportedEngine(currentVersion, updateResult) {
  if (updateResult?.success || !currentVersion || !isSupportedYtdlpVersion(currentVersion)) {
    return updateResult;
  }
  return {
    success: true,
    version: currentVersion,
    skipped: true,
    updateError: updateResult?.error || 'Optional engine update failed',
  };
}

async function installReleaseAsset(asset, options = {}) {
  const userBinDir = options.userBinDir || getUserBinDir();
  const destPath = options.destPath || path.join(userBinDir, 'yt-dlp_macos');
  const backupPath = `${destPath}.previous`;
  const candidatePath = `${destPath}.download-${process.pid}-${Date.now()}`;
  const download = options.download || downloadFileVerified;
  const validate = options.validate || testBinary;
  const prepare = options.prepare || stripQuarantine;
  const writeMetadata = options.writeMetadata || writeEngineMetadata;
  const currentVersion = options.currentVersion;

  if (currentVersion && compareYtdlpVersions(asset.version, currentVersion) === -1) {
    return { success: true, version: currentVersion, channel: YTDLP_CHANNEL, skipped: true };
  }

  fs.mkdirSync(userBinDir, { recursive: true });
  try {
    await download(asset.downloadUrl, candidatePath, asset.sha256);
    fs.chmodSync(candidatePath, 0o755);
    await prepare(candidatePath);

    const candidateVersion = await validate(candidatePath);
    if (!candidateVersion || compareYtdlpVersions(candidateVersion, asset.version) !== 0) {
      throw new Error(`Downloaded yt-dlp version did not match ${asset.version}`);
    }
    if (!isSupportedYtdlpVersion(candidateVersion)) {
      throw new Error(`yt-dlp ${candidateVersion} predates the required YouTube fix`);
    }

    try { fs.unlinkSync(backupPath); } catch {}
    let movedExisting = false;
    if (fs.existsSync(destPath)) {
      fs.renameSync(destPath, backupPath);
      movedExisting = true;
    }

    try {
      fs.renameSync(candidatePath, destPath);
      const installedVersion = await validate(destPath);
      if (!installedVersion || compareYtdlpVersions(installedVersion, candidateVersion) !== 0) {
        throw new Error('Installed yt-dlp failed its post-install validation');
      }
      writeMetadata({
        channel: YTDLP_CHANNEL,
        version: candidateVersion,
        sha256: asset.sha256,
        checkedAt: Date.now(),
      }, userBinDir);
    } catch (error) {
      try { fs.unlinkSync(destPath); } catch {}
      if (movedExisting && fs.existsSync(backupPath)) fs.renameSync(backupPath, destPath);
      throw error;
    }

    return { success: true, version: candidateVersion, channel: YTDLP_CHANNEL };
  } finally {
    try { fs.unlinkSync(candidatePath); } catch {}
  }
}

async function initializeYtdlpInternal() {
  const userBinDir = getUserBinDir();
  fs.mkdirSync(userBinDir, { recursive: true });
  const destPath = path.join(userBinDir, 'yt-dlp_macos');
  const bundledPath = getBundledYtdlpPath();

  let hasBundled = false;
  try {
    fs.accessSync(bundledPath, fs.constants.R_OK);
    hasBundled = true;
  } catch {}

  if (!hasBundled) {
    console.log('[updater] No bundled yt-dlp found, falling back to download');
    return performYtdlpUpdate();
  }

  try {
    console.log('[updater] Installing bundled yt-dlp to userData...');
    const bundledData = bundledPath.endsWith('.gz')
      ? zlib.gunzipSync(fs.readFileSync(bundledPath))
      : fs.readFileSync(bundledPath);
    const candidatePath = `${destPath}.bundled-${process.pid}`;
    fs.writeFileSync(candidatePath, bundledData, { mode: 0o755 });
    await stripQuarantine(candidatePath);

    const version = await testBinary(candidatePath);
    if (version && isSupportedYtdlpVersion(version)) {
      const backupPath = `${destPath}.previous`;
      try { fs.unlinkSync(backupPath); } catch {}
      let movedExisting = false;
      if (fs.existsSync(destPath)) {
        fs.renameSync(destPath, backupPath);
        movedExisting = true;
      }
      try {
        fs.renameSync(candidatePath, destPath);
        const installedVersion = await testBinary(destPath);
        if (!installedVersion || compareYtdlpVersions(installedVersion, version) !== 0) {
          throw new Error('Bundled yt-dlp failed its post-install validation');
        }
        writeEngineMetadata({
          channel: YTDLP_CHANNEL,
          version,
          bundled: true,
          checkedAt: Date.now(),
        }, userBinDir);
      } catch (error) {
        try { fs.unlinkSync(destPath); } catch {}
        if (movedExisting && fs.existsSync(backupPath)) fs.renameSync(backupPath, destPath);
        throw error;
      }
      console.log(`[updater] Bundled yt-dlp ready: v${version}`);
      return { success: true, version, channel: YTDLP_CHANNEL };
    }

    try { fs.unlinkSync(candidatePath); } catch {}
    console.log('[updater] Bundled binary is stale or invalid, trying download');
    return performYtdlpUpdate();
  } catch (err) {
    console.error('[updater] Failed to initialize from bundle:', err.message);
    return performYtdlpUpdate();
  }
}

async function performYtdlpUpdate() {
  try {
    const currentVersion = await getCurrentYtdlpVersion();
    console.log(`[updater] Resolving latest yt-dlp ${YTDLP_CHANNEL} release`);
    const release = await githubGet(YTDLP_RELEASE_API);
    const asset = releaseAsset(release);
    if (!isSupportedYtdlpVersion(asset.version)) {
      throw new Error(`Latest nightly ${asset.version} predates ${MINIMUM_FIXED_YTDLP_VERSION}`);
    }
    if (
      currentVersion
      && isSupportedYtdlpVersion(currentVersion)
      && compareYtdlpVersions(asset.version, currentVersion) === -1
    ) {
      console.log(`[updater] Keeping newer yt-dlp ${currentVersion}; channel build is ${asset.version}`);
      return { success: true, version: currentVersion, skipped: true };
    }
    const result = await installReleaseAsset(asset, { currentVersion });
    console.log(`[updater] Installed yt-dlp ${result.channel}@${result.version}`);
    return result;
  } catch (err) {
    console.error('[updater] yt-dlp update failed:', err.message);
    return { success: false, error: err.message };
  }
}

function runYtdlpMutation(task) {
  if (activeYtdlpMutation) return activeYtdlpMutation;
  activeYtdlpMutation = Promise.resolve()
    .then(task)
    .finally(() => {
      activeYtdlpMutation = null;
    });
  return activeYtdlpMutation;
}

function initializeYtdlp() {
  return runYtdlpMutation(initializeYtdlpInternal);
}

function updateYtdlp() {
  return runYtdlpMutation(performYtdlpUpdate);
}

async function checkYtdlpUpdate() {
  try {
    const current = await getCurrentYtdlpVersion();
    const metadata = readEngineMetadata();
    if (!current || !isSupportedYtdlpVersion(current) || metadata?.channel !== YTDLP_CHANNEL) {
      console.log('[updater] yt-dlp is missing, stale, or on the wrong channel; updating...');
      return await updateYtdlp();
    }

    const latest = await getLatestYtdlpVersion();
    if (!latest) return { success: true, version: current, skipped: true };

    if (isNewerYtdlpVersion(latest, current)) {
      console.log(`[updater] yt-dlp outdated (${current} → ${latest}), updating...`);
      return await updateYtdlp();
    }

    writeEngineMetadata({ ...metadata, channel: YTDLP_CHANNEL, version: current, checkedAt: Date.now() });
    return { success: true, version: current, channel: YTDLP_CHANNEL, skipped: true };
  } catch (err) {
    console.error('[updater] yt-dlp update check failed:', err.message);
    return { success: false, error: err.message };
  }
}

async function ensureYtdlpFresh(store) {
  try {
    const current = await getCurrentYtdlpVersion();
    const metadata = readEngineMetadata();
    const storedState = store?.get('ytdlpEngineState') || {};
    const canThrottle = shouldThrottleYtdlpCheck({
      currentVersion: current,
      metadata,
      storedState,
    });

    if (canThrottle) {
      return { success: true, version: current, channel: YTDLP_CHANNEL, skipped: true };
    }
    if (!current || !isSupportedYtdlpVersion(current) || metadata?.channel !== YTDLP_CHANNEL) {
      console.log('[updater] yt-dlp is missing, stale, or on the wrong channel; updating...');
      const result = await updateYtdlp();
      const readinessResult = preserveSupportedEngine(current, result);
      if (readinessResult !== result) {
        console.warn(`[updater] Keeping supported yt-dlp ${current} after optional update failure`);
      }
      return readinessResult;
    }

    const latest = await getLatestYtdlpVersion();
    if (!latest) return { success: true, version: current, skipped: true };

    if (isNewerYtdlpVersion(latest, current)) {
      console.log(`[updater] yt-dlp outdated (${current} → ${latest}), updating...`);
      const result = await updateYtdlp();
      if (result.success && store) {
        store.set('ytdlpEngineState', {
          channel: YTDLP_CHANNEL,
          version: result.version,
          checkedAt: Date.now(),
        });
      }
      return result;
    }

    const checkedState = { channel: YTDLP_CHANNEL, version: current, checkedAt: Date.now() };
    writeEngineMetadata({ ...metadata, ...checkedState });
    if (store) store.set('ytdlpEngineState', checkedState);
    return { success: true, version: current, channel: YTDLP_CHANNEL, skipped: true };
  } catch (err) {
    console.error('[updater] auto-update check failed:', err.message);
    return { success: false, error: err.message };
  }
}

function isNewerYtdlpVersion(latest, current) {
  return compareYtdlpVersions(latest, current) === 1;
}

function isNewerAppVersion(latest, current) {
  const a = String(latest || '').split('.').map(Number);
  const b = String(current || '').split('.').map(Number);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

async function checkAppUpdate(currentVersion) {
  try {
    const release = await githubGet(APP_REPO_API);
    const tag = release?.tag_name;
    if (!tag) {
      return { available: false, error: 'No release info returned' };
    }
    const latestVersion = tag.replace(/^v/, '').trim();
    if (isNewerAppVersion(latestVersion, currentVersion)) {
      return {
        available: true,
        version: latestVersion,
        url: release.html_url,
      };
    }
    return { available: false };
  } catch (err) {
    return { available: false, error: err.message || 'Update check failed' };
  }
}

module.exports = {
  downloadFileVerified,
  engineMetadataPath,
  getLatestYtdlpVersion,
  getCurrentYtdlpVersion,
  initializeYtdlp,
  installReleaseAsset,
  isNewerAppVersion,
  isNewerYtdlpVersion,
  readEngineMetadata,
  preserveSupportedEngine,
  runYtdlpMutation,
  shouldThrottleYtdlpCheck,
  updateYtdlp,
  checkYtdlpUpdate,
  ensureYtdlpFresh,
  checkAppUpdate,
  writeEngineMetadata,
};
