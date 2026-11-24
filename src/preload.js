require('@sentry/electron/preload');

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  fetchVideoInfo: (url) => ipcRenderer.invoke('fetch-video-info', url),
  startDownload: (options) => ipcRenderer.invoke('start-download', options),
  fetchMediaInfo: (url) => ipcRenderer.invoke('fetch-media-info', url),
  fetchCarouselVideos: (url) => ipcRenderer.invoke('fetch-carousel-videos', url),
  downloadImage: (options) => ipcRenderer.invoke('download-image', options),
  proxyImage: (url) => ipcRenderer.invoke('proxy-image', url),
  cancelDownload: (id) => ipcRenderer.invoke('cancel-download', id),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  revealInFinder: (filePath) => ipcRenderer.invoke('reveal-in-finder', filePath),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  updateYtdlp: () => ipcRenderer.invoke('update-ytdlp'),
  checkYtdlpUpdate: () => ipcRenderer.invoke('check-ytdlp-update'),
  getYtdlpVersion: () => ipcRenderer.invoke('get-ytdlp-version'),
  checkAppUpdate: () => ipcRenderer.invoke('check-app-update'),
  getClipboard: () => ipcRenderer.invoke('get-clipboard'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  cleanupPartialFiles: (dir) => ipcRenderer.invoke('cleanup-partial-files', dir),
  getProjects: () => ipcRenderer.invoke('get-projects'),
  getActiveProject: () => ipcRenderer.invoke('get-active-project'),
  setActiveProject: (name) => ipcRenderer.invoke('set-active-project', name),
  createProject: (name) => ipcRenderer.invoke('create-project', name),
  deleteProject: (name) => ipcRenderer.invoke('delete-project', name),
  setProjectSubfolder: (name, enabled) => ipcRenderer.invoke('set-project-subfolder', name, enabled),
  getHistory: () => ipcRenderer.invoke('get-history'),
  deleteHistoryEntry: (id, deleteFile = false) => ipcRenderer.invoke('delete-history-entry', id, deleteFile),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  updateHistoryEntryProject: (id, project) => ipcRenderer.invoke('update-history-entry-project', { id, project }),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  saveFile: (options) => ipcRenderer.invoke('save-file', options),
  showNotification: (title, body, filePath, stickerType) => ipcRenderer.invoke('show-notification', title, body, filePath, stickerType),

  onDownloadProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('download-progress', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },
  onDownloadComplete: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('download-complete', listener);
    return () => ipcRenderer.removeListener('download-complete', listener);
  },
  onDownloadError: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('download-error', listener);
    return () => ipcRenderer.removeListener('download-error', listener);
  },
  onDownloadCancelled: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('download-cancelled', listener);
    return () => ipcRenderer.removeListener('download-cancelled', listener);
  },
  onWindowFocus: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('window-focus', listener);
    return () => ipcRenderer.removeListener('window-focus', listener);
  },
  onYtdlpUpdated: (callback) => {
    const listener = (_event, version) => callback(version);
    ipcRenderer.on('ytdlp-updated', listener);
    return () => ipcRenderer.removeListener('ytdlp-updated', listener);
  },
  onBackgroundActivity: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('background-activity', listener);
    return () => ipcRenderer.removeListener('background-activity', listener);
  },
  onHistoryEntryUpdated: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('history-entry-updated', listener);
    return () => ipcRenderer.removeListener('history-entry-updated', listener);
  },
  onAppUpdateStatus: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('app-update-status', listener);
    return () => ipcRenderer.removeListener('app-update-status', listener);
  },
  getAppUpdateStatus: () => ipcRenderer.invoke('get-app-update-status'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  startPhoneAccess: () => ipcRenderer.invoke('phone-access-start'),
  stopPhoneAccess: () => ipcRenderer.invoke('phone-access-stop'),
  rotatePhoneAccess: () => ipcRenderer.invoke('phone-access-rotate'),
});
