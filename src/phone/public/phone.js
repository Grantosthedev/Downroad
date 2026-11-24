(function () {
  const COPY = {
    professional: {
      placeholder: 'Paste a YouTube, Instagram, or TikTok link',
      download: 'Download',
      save: 'Save to this phone',
      badUrl: 'Paste a YouTube, Instagram, or TikTok link.',
      locked: 'Open this page from the phone button in Downroad on your Mac.',
      fetching: 'Fetching video info.',
      queued: 'Waiting for the Mac.',
      ready: 'On iPhone, choose Save to Files.',
      offline: 'Cannot reach the Mac. Same Wi-Fi, and Downroad has to be open.',
      cancel: 'Cancel',
      cancelled: 'Cancelled.',
      failed: 'Download failed.',
    },
    unhinged: {
      placeholder: 'Hurry up and paste a link, my ninja',
      download: 'Download This Shit',
      save: 'Save to this phone',
      badUrl: 'Nope, bad URL you buffoon.',
      locked: 'Scan the code in Downroad again, fam. This page is locked.',
      fetching: 'Hold on, fetching video info...',
      queued: 'In line.',
      ready: 'On iPhone, pick Save to Files.',
      offline: 'Can\'t reach your Mac. Same Wi-Fi, and Downroad has to be open.',
      cancel: 'Cancel',
      cancelled: 'Cancelled.',
      failed: 'What the Helly! Download failed.',
    },
    diabolical: {
      placeholder: 'PASTE THE LINK. NOW.',
      download: 'RIP IT',
      save: 'SAVE IT',
      badUrl: 'THAT IS NOT A LINK. TRY AGAIN.',
      locked: 'SCAN THE CODE ON THE MAC. THIS PAGE IS LOCKED.',
      fetching: 'FETCHING.',
      queued: 'WAIT.',
      ready: 'ON IPHONE: SAVE TO FILES.',
      offline: 'CANNOT REACH THE MAC. SAME WI-FI. APP HAS TO BE OPEN.',
      cancel: 'CANCEL',
      cancelled: 'CANCELLED.',
      failed: 'DOWNLOAD FAILED.',
    },
  };

  const urlInput = document.getElementById('url');
  const clearBtn = document.getElementById('clearBtn');
  const urlRow = document.getElementById('urlRow');
  const urlHint = document.getElementById('urlHint');
  const goBtn = document.getElementById('goBtn');
  const saveLink = document.getElementById('saveLink');
  const videoCard = document.getElementById('videoCard');
  const videoCardAction = document.getElementById('videoCardAction');
  const thumb = document.getElementById('thumb');
  const titleEl = document.getElementById('title');
  const metaEl = document.getElementById('meta');
  const startTime = document.getElementById('startTime');
  const endTime = document.getElementById('endTime');
  const startClear = document.getElementById('startClear');
  const endClear = document.getElementById('endClear');
  const qualitySelector = document.getElementById('qualitySelector');
  const qualityBest = document.getElementById('qualityBest');
  const qualityAudio = document.getElementById('qualityAudio');
  const qualityBtnLabel = document.getElementById('qualityBtnLabel');
  const qualityChevron = document.getElementById('qualityChevron');
  const qualityDropdown = document.getElementById('qualityDropdown');
  const qualityDropdownList = document.getElementById('qualityDropdownList');
  const qualityBackdrop = document.getElementById('qualityBackdrop');
  const pillIndicator = document.getElementById('pillIndicator');
  const carouselCard = document.getElementById('carouselCard');
  const carouselTitle = document.getElementById('carouselTitle');
  const carouselCount = document.getElementById('carouselCount');
  const carouselGrid = document.getElementById('carouselGrid');
  const activity = document.getElementById('activity');
  const activityText = document.getElementById('activityText');
  const cancelBtn = document.getElementById('cancelBtn');
  const themeBtn = document.getElementById('themeBtn');

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
  let inspectTimer = 0;

  applyCopy();
  applyTheme();
  parkButton('url');
  window.requestAnimationFrame(placePill);
  if (!key) showHint(copy.locked, true);

  urlInput.addEventListener('input', () => {
    clearBtn.classList.toggle('visible', urlInput.value.length > 0);
    urlRow.classList.remove('error');
    if (normalize(urlInput.value) !== inspectedUrl) resetPreview();
    window.clearTimeout(inspectTimer);
    if (looksSupported(urlInput.value)) {
      inspectTimer = window.setTimeout(() => inspect(urlInput.value.trim()).catch((error) => showHint(messageFor(error), true)), 450);
    }
  });

  urlInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    go().catch((error) => showHint(messageFor(error), true));
  });

  clearBtn.addEventListener('click', () => {
    urlInput.value = '';
    clearBtn.classList.remove('visible');
    resetPreview();
    hideHint();
    urlInput.focus();
  });

  goBtn.addEventListener('click', () => {
    go().catch((error) => showHint(messageFor(error), true));
  });

  startTime.addEventListener('input', () => syncTimeState(startTime));
  endTime.addEventListener('input', () => syncTimeState(endTime));
  startClear.addEventListener('click', () => clearTime(startTime));
  endClear.addEventListener('click', () => clearTime(endTime));

  qualityBest.addEventListener('click', () => {
    if (qualityChevron.classList.contains('visible')) {
      toggleDropdown();
      return;
    }
    setQuality('best');
  });
  qualityAudio.addEventListener('click', () => {
    closeDropdown();
    setQuality('audio');
  });
  qualityBackdrop.addEventListener('click', closeDropdown);
  qualityDropdownList.addEventListener('click', (event) => {
    const item = event.target.closest('.quality-dropdown__item');
    if (!item) return;
    setQuality(item.dataset.quality || 'best', item.dataset.label || '');
    closeDropdown();
  });

  cancelBtn.addEventListener('click', async () => {
    if (!activeJob) return;
    pollGen += 1;
    try {
      await api(`/api/jobs/${activeJob}/cancel`, { method: 'POST', body: '{}' });
    } catch { /* the Mac may already be done */ }
    activeJob = '';
    showDownloadButton();
    setActivity('');
    showHint(copy.cancelled, false);
  });

  themeBtn.addEventListener('click', () => {
    theme = theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('downroad.phone.theme', theme);
    applyTheme();
  });

  window.addEventListener('resize', placePill);

  function applyCopy() {
    urlInput.placeholder = copy.placeholder;
    cancelBtn.textContent = copy.cancel;
    saveLink.textContent = copy.save;
    if (!info && !activeJob) goBtn.textContent = copy.download;
  }

  function applyTheme() {
    document.documentElement.classList.toggle('light-mode', theme === 'light');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f6eded' : '#120404');
    const icon = themeBtn.querySelector('i');
    icon.className = theme === 'light'
      ? 'hgi-stroke hgi-sun-01 ui-icon ui-icon--button'
      : 'hgi-stroke hgi-moon-02 ui-icon ui-icon--button';
  }

  async function go() {
    if (!key) {
      showHint(copy.locked, true);
      return;
    }
    const raw = urlInput.value.trim();
    if (!raw) {
      showHint(copy.badUrl, true);
      return;
    }
    if (normalize(raw) !== inspectedUrl || !info) {
      await inspect(raw);
      return;
    }
    await startJob(raw);
  }

  async function inspect(raw) {
    if (!key) return;
    hideHint();
    setActivity(copy.fetching, false);
    goBtn.disabled = true;
    try {
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
      syncTimeState(startTime);
      syncTimeState(endTime);
      renderPreview();
    } finally {
      if (!activeJob) setActivity('');
      goBtn.disabled = Boolean(activeJob);
    }
  }

  function renderPreview() {
    videoCard.classList.add('visible');
    titleEl.textContent = info.title || 'Untitled';
    titleEl.title = info.title || '';
    const bits = [platformLabel(info.platform)];
    if (info.duration) bits.push(formatDuration(info.duration));
    if (info.uploader) bits.push(info.uploader);
    metaEl.textContent = bits.filter(Boolean).join(' · ');
    const thumbWrap = thumb.parentElement;
    if (info.thumb) {
      thumbWrap.hidden = false;
      thumb.hidden = false;
      thumb.src = info.thumb;
      thumb.onload = () => thumb.classList.add('loaded');
      thumb.onerror = () => {
        thumb.classList.remove('loaded');
        thumb.hidden = true;
        thumbWrap.hidden = true;
      };
    } else {
      thumb.removeAttribute('src');
      thumb.classList.remove('loaded');
      thumb.hidden = true;
      thumbWrap.hidden = true;
    }
    const youtube = info.platform === 'youtube';
    startTime.disabled = !youtube;
    endTime.disabled = !youtube;
    renderCarousel();
    renderQuality();
    showDownloadButton();
    parkButton('card');
  }

  function renderCarousel() {
    const items = info.items || [];
    carouselGrid.replaceChildren();
    carouselCard.classList.toggle('visible', items.length > 1);
    if (items.length < 2) return;
    carouselTitle.textContent = info.title || 'Items';
    carouselCount.textContent = `${itemIndex + 1} / ${items.length}`;
    items.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'carousel-thumb' + (item.index === itemIndex ? ' selected' : '');
      button.textContent = item.label || `Item ${item.index + 1}`;
      button.addEventListener('click', () => {
        itemIndex = item.index;
        const picked = items.find((entry) => entry.index === itemIndex);
        if (!picked || picked.type !== 'video') setQuality('best');
        renderCarousel();
        renderQuality();
      });
      carouselGrid.appendChild(button);
    });
  }

  function renderQuality() {
    const items = info.items || [];
    const selected = items.find((item) => item.index === itemIndex) || items[0];
    const allImages = items.length
      ? items.every((item) => item.type !== 'video')
      : info.mediaType === 'image';
    const selectedVideo = selected ? selected.type === 'video' : info.mediaType === 'video';
    const youtube = info.platform === 'youtube';
    const heights = youtube ? (info.qualities || []).filter((item) => item.height) : [];
    const canAudio = !allImages && (youtube || info.platform === 'tiktok' || selectedVideo);

    qualityAudio.classList.toggle('collapsed', !canAudio || allImages);
    qualitySelector.classList.toggle('compact', allImages || !canAudio);
    qualityChevron.classList.toggle('visible', heights.length > 0 && !allImages);
    if (allImages) quality = 'best';
    if (!canAudio && quality === 'audio') quality = 'best';

    if (quality === 'best') {
      qualityBtnLabel.textContent = heights[0] ? `Best / ${heights[0].label}` : (allImages ? 'Original Quality' : 'Video / Photo');
    } else if (quality === 'audio') {
      qualityBtnLabel.textContent = 'Audio Only';
    } else {
      const match = heights.find((item) => String(item.height) === quality);
      qualityBtnLabel.textContent = match ? match.label : quality;
    }

    qualityBest.classList.toggle('active', quality !== 'audio');
    qualityAudio.classList.toggle('active', quality === 'audio');
    buildDropdown(heights);
    window.requestAnimationFrame(placePill);
  }

  function buildDropdown(heights) {
    qualityDropdownList.replaceChildren();
    const best = document.createElement('button');
    best.type = 'button';
    best.className = 'quality-dropdown__item' + (quality === 'best' ? ' active' : '');
    best.dataset.quality = 'best';
    best.dataset.label = heights[0] ? `Best / ${heights[0].label}` : 'Best';
    best.innerHTML = `<span>${escapeHtml(best.dataset.label)}</span><i class="hgi-stroke hgi-tick-01 quality-dropdown__item-check" aria-hidden="true"></i>`;
    qualityDropdownList.appendChild(best);
    heights.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quality-dropdown__item' + (quality === String(item.height) ? ' active' : '');
      button.dataset.quality = String(item.height);
      button.dataset.label = item.label;
      button.innerHTML = `<span>${escapeHtml(item.label)}</span><i class="hgi-stroke hgi-tick-01 quality-dropdown__item-check" aria-hidden="true"></i>`;
      qualityDropdownList.appendChild(button);
    });
  }

  function setQuality(next, label) {
    quality = next;
    if (label && next !== 'audio' && next !== 'best') qualityBtnLabel.textContent = label;
    renderQuality();
  }

  function toggleDropdown() {
    const open = !qualityDropdown.classList.contains('visible');
    qualityDropdown.classList.toggle('visible', open);
    qualityBackdrop.classList.toggle('visible', open);
    qualityChevron.classList.toggle('open', open);
  }

  function closeDropdown() {
    qualityDropdown.classList.remove('visible');
    qualityBackdrop.classList.remove('visible');
    qualityChevron.classList.remove('open');
  }

  function placePill() {
    const active = qualitySelector.querySelector('.quality-option.active:not(.collapsed)');
    if (!active) return;
    pillIndicator.style.width = `${active.offsetWidth}px`;
    pillIndicator.style.transform = `translateX(${active.offsetLeft - 6}px)`;
  }

  async function startJob(raw) {
    pollGen += 1;
    const gen = pollGen;
    hideHint();
    const created = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        url: raw,
        quality,
        startTime: info.platform === 'youtube' ? startTime.value.trim() : '',
        endTime: info.platform === 'youtube' ? endTime.value.trim() : '',
        itemIndex,
      }),
    });
    activeJob = created.id;
    goBtn.disabled = true;
    goBtn.textContent = copy.queued;
    setActivity(copy.queued, true);
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
      activeJob = '';
      showDownloadButton();
      setActivity('');
      showHint(messageFor(error), true);
      return;
    }
    if (gen !== pollGen) return;
    if (job.status === 'ready') {
      saveLink.href = `/api/jobs/${id}/file`;
      if (job.filename) saveLink.setAttribute('download', job.filename);
      saveLink.hidden = false;
      goBtn.classList.add('url-row-hidden');
      activeJob = '';
      goBtn.disabled = false;
      setActivity('');
      showHint(copy.ready, false);
      return;
    }
    if (job.status === 'error' || job.status === 'cancelled' || job.status === 'missing') {
      activeJob = '';
      showDownloadButton();
      setActivity('');
      if (job.status === 'error') showHint(job.error || copy.failed, true);
      else if (job.status === 'cancelled') showHint(copy.cancelled, false);
      return;
    }
    const label = job.status === 'queued' ? copy.queued : `${Math.round(job.percent || 0)}%`;
    goBtn.textContent = label;
    const detail = [job.speed, job.eta ? `ETA ${job.eta}` : ''].filter(Boolean).join(' · ');
    setActivity(detail ? `${label} · ${detail}` : label, true);
    window.setTimeout(() => poll(id, gen, 0), 700);
  }

  function showDownloadButton() {
    saveLink.hidden = true;
    goBtn.classList.remove('url-row-hidden');
    goBtn.disabled = false;
    goBtn.textContent = copy.download;
  }

  function parkButton(where) {
    const parent = where === 'card' ? videoCardAction : urlRow;
    parent.appendChild(goBtn);
    parent.appendChild(saveLink);
  }

  function resetPreview() {
    info = null;
    inspectedUrl = '';
    videoCard.classList.remove('visible');
    carouselCard.classList.remove('visible');
    startTime.disabled = true;
    endTime.disabled = true;
    qualityChevron.classList.remove('visible');
    qualitySelector.classList.remove('compact');
    qualityAudio.classList.remove('collapsed');
    quality = 'best';
    qualityBtnLabel.textContent = 'Video / Photo';
    qualityBest.classList.add('active');
    qualityAudio.classList.remove('active');
    closeDropdown();
    if (!activeJob) {
      showDownloadButton();
      goBtn.classList.add('url-row-hidden');
      parkButton('url');
      setActivity('');
    }
    window.requestAnimationFrame(placePill);
  }

  function syncTimeState(input) {
    input.classList.toggle('has-value', Boolean(input.value) && input.value !== '00:00:00');
  }

  function clearTime(input) {
    input.value = '00:00:00';
    syncTimeState(input);
  }

  function setActivity(text, cancellable) {
    activity.classList.toggle('visible', Boolean(text));
    activityText.textContent = text || '';
    cancelBtn.hidden = !cancellable;
  }

  function showHint(text, isError) {
    urlHint.textContent = text || '';
    urlHint.classList.toggle('visible', Boolean(text));
    urlHint.classList.toggle('error', Boolean(isError));
    urlRow.classList.toggle('error', Boolean(isError));
  }

  function hideHint() {
    urlHint.classList.remove('visible', 'error');
    urlHint.textContent = '';
    urlRow.classList.remove('error');
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

  function looksSupported(value) {
    return /youtu\.be|youtube\.com|instagram\.com|tiktok\.com/i.test(value || '');
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

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
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
