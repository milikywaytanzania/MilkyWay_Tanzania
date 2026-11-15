// Points every APK link at the newest build and reports real transfer progress while downloading it.
(() => {
  const links = [...document.querySelectorAll('#appDownload, #mwApkLink, a[data-mw-apk]')];
  if (!links.length) return;

  const base = new URL('.', document.currentScript?.src || new URL('/milkyway/apk-link.js', location.href));
  const labels = new WeakMap();
  const busy = new WeakSet();
  const timers = new WeakMap();
  const timedSignal = milliseconds => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), milliseconds);
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
  };

  const labelOf = link => link.querySelector('[data-i18n="appDownload"]') || link.querySelector('span');
  const setLabel = (link, text) => {
    const label = labelOf(link);
    if (label) {
      label.textContent = text;
      label.style.display = text === labels.get(link)?.text ? labels.get(link)?.display || '' : 'inline';
    }
    link.setAttribute('aria-label', text === labels.get(link)?.text ? labels.get(link)?.ariaLabel || 'Download MilkyWay APK' : text);
  };
  const reset = link => {
    const original = labels.get(link);
    if (!original) return;
    clearTimeout(timers.get(link));
    busy.delete(link);
    link.removeAttribute('aria-busy');
    link.removeAttribute('aria-disabled');
    link.classList.remove('is-downloading');
    link.title = original.title;
    link.setAttribute('aria-label', original.ariaLabel);
    const label = labelOf(link);
    if (label) {
      label.textContent = original.text;
      label.style.display = original.display;
    }
  };

  for (const link of links) {
    const label = labelOf(link);
    labels.set(link, {
      text: label?.textContent || 'APK',
      display: label?.style.display || '',
      ariaLabel: link.getAttribute('aria-label') || 'Download MilkyWay APK',
      title: link.title,
    });
  }

  // Resolve the release before a fast click can start a download using a stale URL.
  const manifestTimeout = timedSignal(8000);
  const versionReady = fetch(new URL('download/version.json', base), {
    cache: 'no-store',
    signal: manifestTimeout.signal,
  }).then(async response => {
    if (!response.ok) throw new Error(`Release information returned HTTP ${response.status}.`);
    const latest = await response.json();
    if (!latest || !latest.versionCode) throw new Error('Release information is invalid.');
    const url = new URL(String(latest.apk || latest.url || 'download/MilkyWay.apk'), base);
    if (url.origin !== location.origin) throw new Error('The APK download URL is not on this site.');
    url.searchParams.set('v', latest.versionCode);
    links.forEach(link => { link.href = url.pathname + url.search; });
  }).catch(error => {
    console.warn('[apk] Could not refresh release information; using the current APK link.', error);
  }).finally(() => {
    manifestTimeout.clear();
  });

  async function readDownload(response, link) {
    const total = Number(response.headers.get('content-length')) || 0;
    const reader = response.body?.getReader?.();
    if (!reader) {
      setLabel(link, 'Downloading…');
      const blob = await response.blob();
      if (!blob.size) throw new Error('The APK download was empty.');
      return blob;
    }

    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      setLabel(link, total ? `Downloading ${Math.min(100, Math.floor(received / total * 100))}%` : 'Downloading…');
    }
    if (!received) throw new Error('The APK download was empty.');
    return new Blob(chunks, { type: response.headers.get('content-type') || 'application/vnd.android.package-archive' });
  }

  async function download(link) {
    if (busy.has(link)) return;
    busy.add(link);
    clearTimeout(timers.get(link));
    link.setAttribute('aria-busy', 'true');
    link.setAttribute('aria-disabled', 'true');
    link.classList.add('is-downloading');
    link.title = 'Preparing APK download…';
    setLabel(link, 'Preparing…');

    let notice = '';
    try {
      await versionReady;
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin || !/\/download\/[^/]+\.apk$/i.test(url.pathname)) {
        throw new Error('The APK download link is invalid.');
      }
      const downloadTimeout = timedSignal(10 * 60 * 1000);
      let blob;
      try {
        const response = await fetch(url, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: downloadTimeout.signal,
        });
        if (!response.ok) throw new Error(`APK download returned HTTP ${response.status}.`);
        if (/text\/html/i.test(response.headers.get('content-type') || '')) throw new Error('The server returned a page instead of the APK.');
        blob = await readDownload(response, link);
      } finally {
        downloadTimeout.clear();
      }
      const objectUrl = URL.createObjectURL(blob);
      const saveLink = document.createElement('a');
      saveLink.href = objectUrl;
      saveLink.download = 'MilkyWay.apk';
      saveLink.hidden = true;
      document.body.append(saveLink);
      try { saveLink.click(); }
      finally { saveLink.remove(); }
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      notice = 'Download started.';
    } catch (error) {
      console.error('[apk] Download failed.', error);
      notice = `Download failed: ${error?.message || 'Please try again.'}`;
    } finally {
      reset(link);
      if (notice) {
        link.title = notice;
        setLabel(link, notice.startsWith('Download failed') ? 'Download failed' : 'Download started');
        timers.set(link, setTimeout(() => reset(link), 5000));
      }
    }
  }

  links.forEach(link => link.addEventListener('click', event => {
    event.preventDefault();
    download(link);
  }));
})();
