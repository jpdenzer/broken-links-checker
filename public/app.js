const form = document.getElementById('scan-form');
const urlInput = document.getElementById('url-input');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const maxPagesInput = document.getElementById('max-pages');
const checkExternalInput = document.getElementById('check-external');

const statusEl = document.getElementById('status');
const statPages = document.getElementById('stat-pages');
const statLinks = document.getElementById('stat-links');
const statBroken = document.getElementById('stat-broken');
const statUnverifiable = document.getElementById('stat-unverifiable');
const currentUrlEl = document.getElementById('current-url');

const brokenBody = document.getElementById('broken-body');
const brokenCountLabel = document.getElementById('broken-count-label');
const noBrokenEl = document.getElementById('no-broken');

const unverifiableBody = document.getElementById('unverifiable-body');
const unverifiableCountLabel = document.getElementById('unverifiable-count-label');
const noUnverifiableEl = document.getElementById('no-unverifiable');

const logEl = document.getElementById('log');
const exportBtn = document.getElementById('export-btn');

let eventSource = null;

// Groups results by link URL so a link repeated across many pages (e.g. a
// footer/social link) shows as one row with a "found on N pages" list,
// instead of one duplicate row per page it appears on.
const brokenGroups = new Map(); // url -> { tr, pages: Set, pagesListEl, summaryEl }
const unverifiableGroups = new Map();

function logLine(text) {
  const div = document.createElement('div');
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function totalOccurrences(groups) {
  let total = 0;
  for (const entry of groups.values()) total += entry.pages.size;
  return total;
}

function updateCountLabel(groups, countLabelEl) {
  const unique = groups.size;
  const total = totalOccurrences(groups);
  if (unique === 0) {
    countLabelEl.textContent = '';
  } else if (total === unique) {
    countLabelEl.textContent = `(${unique})`;
  } else {
    countLabelEl.textContent = `(${unique} unique, ${total} total occurrences)`;
  }
}

function resetUI() {
  brokenGroups.clear();
  unverifiableGroups.clear();
  brokenBody.innerHTML = '';
  unverifiableBody.innerHTML = '';
  logEl.innerHTML = '';
  statPages.textContent = '0';
  statLinks.textContent = '0';
  statBroken.textContent = '0';
  statUnverifiable.textContent = '0';
  currentUrlEl.textContent = '';
  brokenCountLabel.textContent = '';
  unverifiableCountLabel.textContent = '';
  noBrokenEl.classList.remove('hidden');
  noUnverifiableEl.classList.remove('hidden');
  statusEl.classList.remove('hidden');
  exportBtn.disabled = true;
}

function upsertRow({ result, groups, body, emptyStateEl, countLabelEl, badgeClass }) {
  emptyStateEl.classList.add('hidden');

  let entry = groups.get(result.url);
  if (!entry) {
    const tr = document.createElement('tr');

    const statusTd = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = badgeClass ? `status-badge ${badgeClass}` : 'status-badge';
    badge.textContent = result.status ? result.status : (result.error || 'ERROR');
    badge.title = result.reason || result.statusText || '';
    statusTd.appendChild(badge);

    const linkTd = document.createElement('td');
    const linkA = document.createElement('a');
    linkA.href = result.url;
    linkA.target = '_blank';
    linkA.rel = 'noopener noreferrer';
    linkA.textContent = result.url;
    linkTd.appendChild(linkA);

    const textTd = document.createElement('td');
    textTd.className = 'link-text-cell';

    const foundOnTd = document.createElement('td');
    const details = document.createElement('details');
    const summaryEl = document.createElement('summary');
    const pagesListEl = document.createElement('div');
    pagesListEl.className = 'pages-list';
    details.append(summaryEl, pagesListEl);
    foundOnTd.appendChild(details);

    tr.append(statusTd, linkTd, textTd, foundOnTd);
    body.appendChild(tr);

    entry = { tr, pages: new Set(), summaryEl, pagesListEl, textTd, text: '', result };
    groups.set(result.url, entry);
  }

  if (!entry.text && result.text) {
    entry.text = result.text;
    entry.textTd.textContent = result.text;
  } else if (!entry.text) {
    entry.textTd.textContent = '(no text)';
  }

  if (!entry.pages.has(result.foundOn)) {
    entry.pages.add(result.foundOn);
    const a = document.createElement('a');
    a.href = result.foundOn;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = result.foundOn;
    const div = document.createElement('div');
    div.appendChild(a);
    entry.pagesListEl.appendChild(div);
  }

  const n = entry.pages.size;
  entry.summaryEl.textContent = n === 1 ? '1 page' : `${n} pages`;
  updateCountLabel(groups, countLabelEl);
  exportBtn.disabled = false;
}

function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function buildResultsCsv() {
  const rows = [
    ['Type', 'Status', 'Reason', 'Link', 'Link text', 'Occurrences', 'Found on pages', 'Notes'],
  ];
  for (const [type, groups] of [['Broken', brokenGroups], ['Unverifiable', unverifiableGroups]]) {
    for (const [url, entry] of groups) {
      rows.push([
        type,
        entry.result.status ?? entry.result.error ?? '',
        entry.result.reason ?? entry.result.error ?? '',
        url,
        entry.text || '(no text)',
        entry.pages.size,
        Array.from(entry.pages).join(' | '),
        '',
      ]);
    }
  }
  return rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
}

function exportResultsCsv() {
  const csv = buildResultsCsv();
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const blobUrl = URL.createObjectURL(blob);

  let hostname = 'scan';
  try {
    hostname = new URL(urlInput.value.trim()).hostname;
  } catch {
    // keep default
  }
  const date = new Date().toISOString().slice(0, 10);

  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = `broken-links-${hostname}-${date}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

function stopScan() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  stopScan();
  resetUI();

  const maxPages = maxPagesInput.value || 50;
  const checkExternal = checkExternalInput.checked;

  const params = new URLSearchParams({
    url,
    maxPages: String(maxPages),
    checkExternal: String(checkExternal),
  });

  startBtn.disabled = true;
  stopBtn.disabled = false;

  eventSource = new EventSource(`/api/scan?${params.toString()}`);

  eventSource.addEventListener('start', (e) => {
    const data = JSON.parse(e.data);
    logLine(`Starting scan of ${data.url} (max ${data.maxPages} pages)`);
  });

  eventSource.addEventListener('page-start', (e) => {
    const data = JSON.parse(e.data);
    currentUrlEl.textContent = `Crawling: ${data.url}`;
    logLine(`Crawling ${data.url}`);
  });

  eventSource.addEventListener('page-result', (e) => {
    const data = JSON.parse(e.data);
    if (!data.ok) {
      logLine(`  page error: ${data.url} -> ${data.error || data.status}`);
    }
  });

  eventSource.addEventListener('link-checked', (e) => {
    const data = JSON.parse(e.data);
    if (data.unverifiable) {
      upsertRow({
        result: data,
        groups: unverifiableGroups,
        body: unverifiableBody,
        emptyStateEl: noUnverifiableEl,
        countLabelEl: unverifiableCountLabel,
        badgeClass: 'warning',
      });
      logLine(`  UNVERIFIABLE: ${data.url} (${data.status}, ${data.reason}) on ${data.foundOn}`);
    } else if (data.broken) {
      upsertRow({
        result: data,
        groups: brokenGroups,
        body: brokenBody,
        emptyStateEl: noBrokenEl,
        countLabelEl: brokenCountLabel,
      });
      logLine(`  BROKEN: ${data.url} (${data.status || data.error}) on ${data.foundOn}`);
    }
  });

  eventSource.addEventListener('progress', (e) => {
    const data = JSON.parse(e.data);
    statPages.textContent = data.pagesCrawled;
    statLinks.textContent = data.linksChecked;
    statBroken.textContent = data.brokenFound;
    statUnverifiable.textContent = data.unverifiableFound;
  });

  eventSource.addEventListener('done', (e) => {
    const data = JSON.parse(e.data);
    currentUrlEl.textContent = 'Scan complete.';
    logLine(`Done. Crawled ${data.pagesCrawled} pages, checked ${data.linksChecked} links, ${data.brokenFound} broken, ${data.unverifiableFound} unverifiable.`);
    stopScan();
  });

  eventSource.addEventListener('fatal-error', (e) => {
    const data = JSON.parse(e.data);
    currentUrlEl.textContent = `Error: ${data.error}`;
    logLine(`Fatal error: ${data.error}`);
    stopScan();
  });

  eventSource.onerror = () => {
    if (eventSource && eventSource.readyState === EventSource.CLOSED) {
      stopScan();
    }
  };
});

stopBtn.addEventListener('click', () => {
  currentUrlEl.textContent = 'Stopped.';
  logLine('Scan stopped by user.');
  stopScan();
});

exportBtn.addEventListener('click', exportResultsCsv);
