(function () {
  const COPY = {
    professional: {
      placeholder: 'Paste a link',
      check: 'Check link',
      download: 'Download',
      save: 'Save to this phone',
      badUrl: 'Paste a YouTube, Instagram, or TikTok link.',
      locked: 'Open this page from the phone button in Downroad on your Mac.',
      queued: 'Waiting',
      ready: 'On iPhone, choose Save to Files.',
      offline: 'Cannot reach the Mac. Same Wi-Fi, and Downroad has to be open.',
      footnote: 'Same Wi-Fi. Nothing to install.',
      cancel: 'Cancel',
      cancelled: 'Cancelled.',
      failed: 'Download failed.',
      audio: 'Audio',
      video: 'Video',
    },
    unhinged: {
      placeholder: 'Paste a link, my ninja',
      check: 'Check this link',
      download: 'Download This Shit',
      save: 'Save to this phone',
      badUrl: 'Nope, bad URL you buffoon.',
      locked: 'Scan the code in Downroad again, fam. This page is locked.',
      queued: 'In line',
      ready: 'On iPhone, pick Save to Files.',
      offline: 'Can\'t reach your Mac. Same Wi-Fi, and Downroad has to be open.',
      footnote: 'Same Wi-Fi. Nothing to install.',
      cancel: 'Cancel',
      cancelled: 'Cancelled.',
      failed: 'What the Helly! Download failed.',
      audio: 'Audio',
      video: 'Video',
    },
    diabolical: {
      placeholder: 'PASTE THE LINK',
      check: 'CHECK IT',
      download: 'RIP IT',
      save: 'SAVE IT',
      badUrl: 'THAT IS NOT A LINK. TRY AGAIN.',
      locked: 'SCAN THE CODE ON THE MAC. THIS PAGE IS LOCKED.',
      queued: 'WAIT',
      ready: 'ON IPHONE: SAVE TO FILES.',
      offline: 'CANNOT REACH THE MAC. SAME WI-FI. APP HAS TO BE OPEN.',
      footnote: 'SAME WI-FI. NOTHING TO INSTALL.',
      cancel: 'CANCEL',
      cancelled: 'CANCELLED.',
      failed: 'DOWNLOAD FAILED.',
      audio: 'AUDIO',
      video: 'VIDEO',
    },
  };

  const urlInput = document.getElementById('url');
  const clearBtn = document.getElementById('clearBtn');
  const banner = document.getElementById('banner');
  const form = document.getElementById('form');
  const goBtn = document.getElementById('goBtn');
  const card = document.getElementById('card');
  const thumb = document.getElementById('thumb');
  const titleEl = document.getElementById('title');
  const metaEl = document.getElementById('meta');
  const itemsEl = document.getElementById('items');
  const controls = document.getElementById('controls');
  const startTime = document.getElementById('startTime');
  const endTime = document.getElementById('endTime');
  const qualities = document.getElementById('qualities');
  const jobTrack = document.getElementById('jobTrack');
  const jobFill = document.getElementById('jobFill');
  const jobText = document.getElementById('jobText');
  const cancelBtn = document.getElementById('cancelBtn');
  const saveLink = document.getElementById('saveLink');
  const themeBtn = document.getElementById('themeBtn');
  const footnote = document.getElementById('footnote');
  const sticker = document.getElementById('sticker');

  const launch = readLaunchHash(location.hash);
  if (launch.key) localStorage.setItem('downroad.phone.key', launch.key);
  if (launch.mode) localStorage.setItem('downroad.phone.mode', launch.mode);
  if (launch.theme) localStorage.setItem('downroad.phone.theme', launch.theme);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);

  let key = localStorage.getItem('downroad.phone.key') || '';
  let mode = localStorage.getItem('downroad.phone.mode') || 'unhinged';
  if (!COPY[mode]) mode = 'unhinged';
  let copy = COPY[mode];
  let theme = localStorage.getItem('downroad.phone.theme') === 'light' ? 'light' : 'dark';
  let info = null;
  let inspectedUrl = '';
  let quality = 'best';
  let itemIndex = 0;
  let pollGen = 0;
  let activeJob = '';

  applyCopy();
  applyTheme();
  syncChrome();
  if (!key) showBanner(copy.locked);

  urlInput.addEventListener('input', () => {
    clearBtn.hidden = urlInput.value.length === 0;
    if (normalize(urlInput.value) !== inspectedUrl) resetPreview();
  });

  clearBtn.addEventListener('click', () => {
    urlInput.value = '';
    clearBtn.hidden = true;
    resetPreview();
    hideBanner();
    urlInput.focus();
  });

  themeBtn.addEventListener('click', () => {
    theme = theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('downroad.phone.theme', theme);
    applyTheme();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!key) {
      showBanner(copy.locked);
      return;
    }
    const raw = urlInput.value.trim();
    if (!raw) {
      showBanner(copy.badUrl);
      return;
    }
    hideBanner();
    goBtn.disabled = true;
    try {
      if (normalize(raw) !== inspectedUrl || !info) {
        await inspect(raw);
        return;
      }
      await startJob(raw);
    } catch (error) {
      showBanner(messageFor(error));
    } finally {
      goBtn.disabled = Boolean(activeJob);
    }
  });

  cancelBtn.addEventListener('click', async () => {
    if (!activeJob) return;
    pollGen += 1;
    try {
      await api(`/api/jobs/${activeJob}/cancel`, { method: 'POST', body: '{}' });
    } catch { /* the Mac may already be done */ }
    activeJob = '';
    showIdleAction();
    setStatus(copy.cancelled);
  });

  function applyCopy() {
    urlInput.placeholder = copy.placeholder;
    footnote.textContent = copy.footnote;
    if (!info) goBtn.textContent = copy.check;
    else if (!activeJob && saveLink.hidden) goBtn.textContent = copy.download;
    cancelBtn.textContent = copy.cancel;
    saveLink.textContent = copy.save;
  }

  function applyTheme() {
    document.documentElement.classList.toggle('light-mode', theme === 'light');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f6eded' : '#120404');
    const icon = themeBtn.querySelector('i');
    icon.className = theme === 'light'
      ? 'hgi-stroke hgi-sun-01 ui-icon'
      : 'hgi-stroke hgi-moon-02 ui-icon';
  }

  function syncChrome() {
    const busy = Boolean(info);
    sticker.hidden = busy;
    footnote.hidden = busy;
  }

  async function inspect(raw) {
    const data = await api('/api/inspect', {
      method: 'POST',
      body: JSON.stringify({ url: raw }),
    });
    info = data;
    inspectedUrl = normalize(raw);
    quality = 'best';
    itemIndex = 0;
    startTime.value = '00:00:00';
    endTime.value = '00:00:00';
    if (!activeJob) showIdleAction();
    renderPreview();
    goBtn.textContent = copy.download;
  }

  function renderPreview() {
    card.hidden = false;
    const budget = info.thumb ? 28 : 42;
    titleEl.textContent = midTruncate(info.title || 'Untitled', budget);
    titleEl.title = info.title || '';
    const bits = [platformLabel(info.platform)];
    if (info.duration) bits.push(formatDuration(info.duration));
    if (info.uploader) bits.push(info.uploader);
    metaEl.textContent = bits.filter(Boolean).join(' · ');
    if (info.thumb) {
      thumb.hidden = false;
      thumb.src = info.thumb;
      thumb.alt = '';
    } else {
      thumb.removeAttribute('src');
      thumb.hidden = true;
    }
    renderItems();
    renderControls();
    syncChrome();
  }

  function renderItems() {
    itemsEl.replaceChildren();
    const items = info.items || [];
    itemsEl.hidden = items.length < 2;
    items.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.textContent = item.label || `Item ${item.index + 1}`;
      button.setAttribute('aria-pressed', item.index === itemIndex ? 'true' : 'false');
      button.addEventListener('click', () => {
        itemIndex = item.index;
        const picked = (info.items || []).find((entry) => entry.index === itemIndex);
        if (!picked || picked.type !== 'video') quality = 'best';
        renderItems();
        renderControls();
      });
      itemsEl.appendChild(button);
    });
  }

  function renderControls() {
    const youtube = info.platform === 'youtube';
    const items = info.items || [];
    const selected = items.find((item) => item.index === itemIndex) || items[0];
    const allImages = items.length
      ? items.every((item) => item.type !== 'video')
      : info.mediaType === 'image';
    const selectedVideo = selected ? selected.type === 'video' : info.mediaType === 'video';
    const canAudio = !allImages && (youtube || info.platform === 'tiktok' || selectedVideo);
    const choices = [];
    if (!allImages) choices.push({ id: 'best', label: copy.video });
    if (youtube) {
      (info.qualities || []).forEach((item) => {
        if (item.height) choices.push({ id: String(item.height), label: item.label });
      });
    }
    if (canAudio) choices.push({ id: 'audio', label: copy.audio });
    if (!choices.some((choice) => choice.id === quality)) quality = 'best';
    qualities.replaceChildren();
    choices.forEach((choice) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.role = 'radio';
      button.textContent = choice.label;
      button.setAttribute('aria-checked', choice.id === quality ? 'true' : 'false');
      button.addEventListener('click', () => {
        quality = choice.id;
        renderControls();
      });
      qualities.appendChild(button);
    });
    document.querySelector('.times').hidden = !youtube;
    qualities.hidden = choices.length < 2;
    controls.hidden = !youtube && qualities.hidden;
  }

  async function startJob(raw) {
    pollGen += 1;
    const gen = pollGen;
    const body = {
      url: raw,
      quality,
      startTime: info.platform === 'youtube' ? startTime.value.trim() : '',
      endTime: info.platform === 'youtube' ? endTime.value.trim() : '',
      itemIndex,
    };
    const created = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    activeJob = created.id;
    showWorking(copy.queued);
    await poll(created.id, gen);
  }

  async function poll(id, gen, misses = 0) {
    if (gen !== pollGen) return;
    let job;
    try {
      job = await api(`/api/jobs/${id}`);
    } catch (error) {
      if (gen !== pollGen) return;
      if (misses < 4) {
        window.setTimeout(() => poll(id, gen, misses + 1), 700);
        return;
      }
      showBanner(messageFor(error));
      activeJob = '';
      showIdleAction();
      return;
    }
    if (gen !== pollGen) return;
    setProgress(job.percent || 0);
    if (job.status === 'ready') {
      saveLink.hidden = false;
      saveLink.href = `/api/jobs/${id}/file`;
      if (job.filename) saveLink.setAttribute('download', job.filename);
      goBtn.hidden = true;
      jobTrack.hidden = true;
      cancelBtn.hidden = true;
      activeJob = '';
      goBtn.disabled = false;
      setStatus(copy.ready);
      return;
    }
    if (job.status === 'error' || job.status === 'cancelled' || job.status === 'missing') {
      activeJob = '';
      showIdleAction();
      if (job.status === 'error') showBanner(job.error || copy.failed);
      else if (job.status === 'cancelled') setStatus(copy.cancelled);
      return;
    }
    if (job.status === 'queued') showWorking(copy.queued);
    else showWorking(`${Math.round(job.percent || 0)}%`, speedLine(job));
    window.setTimeout(() => poll(id, gen, 0), 700);
  }

  function showWorking(label, detail) {
    goBtn.hidden = false;
    saveLink.hidden = true;
    goBtn.textContent = label;
    jobTrack.hidden = false;
    cancelBtn.hidden = false;
    setStatus(detail || '');
  }

  function showIdleAction() {
    goBtn.hidden = false;
    saveLink.hidden = true;
    jobTrack.hidden = true;
    cancelBtn.hidden = true;
    goBtn.disabled = false;
    goBtn.textContent = info ? copy.download : copy.check;
    jobText.hidden = true;
    jobText.textContent = '';
  }

  function speedLine(job) {
    return [job.speed, job.eta ? `ETA ${job.eta}` : ''].filter(Boolean).join(' · ');
  }

  function setStatus(text) {
    jobText.hidden = !text;
    jobText.textContent = text || '';
  }

  function resetPreview() {
    info = null;
    inspectedUrl = '';
    card.hidden = true;
    itemsEl.hidden = true;
    controls.hidden = true;
    if (!activeJob) showIdleAction();
    syncChrome();
  }

  function setProgress(percent) {
    const value = Math.max(0, Math.min(100, Number(percent) || 0)) / 100;
    jobFill.style.transform = `scaleX(${value})`;
  }

  async function api(path, options) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options && options.headers);
    if (key) headers['X-Downroad-Key'] = key;
    let response;
    try {
      response = await fetch(path, {
        method: options && options.method ? options.method : 'GET',
        headers,
        body: options ? options.body : undefined,
      });
    } catch {
      throw Object.assign(new Error(copy.offline), { code: 'offline' });
    }
    if (response.status === 204) return {};
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(data.error || copy.failed), { code: data.code || 'request_failed' });
    }
    return data;
  }

  function messageFor(error) {
    if (!error) return copy.failed;
    if (error.code === 'bad_url') return copy.badUrl;
    if (error.code === 'locked') return copy.locked;
    if (error.code === 'offline') return copy.offline;
    return error.message || copy.failed;
  }

  function showBanner(text) {
    banner.hidden = false;
    banner.textContent = text;
  }

  function hideBanner() {
    banner.hidden = true;
    banner.textContent = '';
  }

  function normalize(value) {
    return String(value || '').trim();
  }

  function platformLabel(platform) {
    if (platform === 'youtube') return 'YouTube';
    if (platform === 'instagram') return 'Instagram';
    if (platform === 'tiktok') return 'TikTok';
    return '';
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  function midTruncate(str, maxLen) {
    if (!str || str.length <= maxLen) return str || '';
    const tail = Math.floor(maxLen * 0.35);
    const head = maxLen - tail - 1;
    return `${str.slice(0, head)}…${str.slice(-tail)}`;
  }

  function readLaunchHash(hash) {
    const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const nextMode = params.get('m');
    const nextTheme = params.get('t');
    return {
      key: params.get('k') || '',
      mode: COPY[nextMode] ? nextMode : '',
      theme: nextTheme === 'light' || nextTheme === 'dark' ? nextTheme : '',
    };
  }
}());
