import * as cheerio from 'cheerio';
import { Limiter } from './limiter.js';

const NON_PAGE_EXTENSIONS =
  /\.(jpe?g|png|gif|svg|webp|ico|bmp|css|js|mjs|json|xml|pdf|zip|rar|7z|gz|tar|mp4|mp3|wav|avi|mov|wmv|woff2?|ttf|eot|otf|docx?|xlsx?|pptx?|csv|rss|atom)(\?.*)?$/i;

const SKIP_SCHEMES = /^(mailto|tel|javascript|data|blob|about):/i;

// Status codes that are ambiguous for an automated checker: they far more
// often mean "a WAF/bot-check/rate-limiter/login-wall is blocking this
// scripted request" than "this resource is actually gone." A domain
// allowlist doesn't scale (Facebook, ANSI, EBSCO's SSO dispatcher, and
// countless other sites all return these to non-browser clients), so we
// classify by status code instead: only 404/410 and genuine server/network
// failures are reported as broken; these are reported as unverifiable.
const AMBIGUOUS_STATUSES = new Map([
  [400, 'Bad Request — usually a WAF/bot check rejecting the request, not a dead link'],
  [401, 'Unauthorized — requires login'],
  [403, 'Forbidden — often bot detection or requires login'],
  [407, 'Proxy authentication required'],
  [429, 'Rate limited — too many requests, not a dead link'],
  [503, 'Service unavailable — often a bot-check page or temporary outage'],
]);

function unverifiableResult(url, extra) {
  return {
    url,
    ok: false,
    broken: false,
    unverifiable: true,
    ...extra,
  };
}

function isSkippableHref(href) {
  if (!href) return true;
  const trimmed = href.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('#')) return true;
  if (SKIP_SCHEMES.test(trimmed)) return true;
  return false;
}

function resolveUrl(href, baseUrl) {
  try {
    const resolved = new URL(href, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    resolved.hash = '';
    return resolved.toString();
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, { method = 'GET', timeout = 10000, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function checkLink(url, { timeout, signal }) {
  // Try HEAD first (cheap); fall back to GET on non-ok responses, since
  // many servers handle HEAD unreliably (405, or silently drop it).
  // Exception: if HEAD already gives an ambiguous status, stop there -
  // retrying with GET on these can trigger runaway SSO redirect loops
  // (login walls bouncing an unauthenticated client back and forth)
  // that time out or throw "redirect count exceeded" instead of ever
  // resolving, which would otherwise get misreported as broken.
  try {
    let res;
    try {
      res = await fetchWithTimeout(url, { method: 'HEAD', timeout, signal });
      if (!res.ok && !AMBIGUOUS_STATUSES.has(res.status)) {
        res = await fetchWithTimeout(url, { method: 'GET', timeout, signal });
      }
    } catch {
      res = await fetchWithTimeout(url, { method: 'GET', timeout, signal });
    }

    if (AMBIGUOUS_STATUSES.has(res.status)) {
      return unverifiableResult(url, {
        status: res.status,
        statusText: res.statusText,
        reason: AMBIGUOUS_STATUSES.get(res.status),
      });
    }
    return {
      url,
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      broken: !res.ok,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      // Could be a genuinely dead/slow host, or a server that stalls
      // scripted requests on purpose - we can't tell which, so don't
      // report it as definitively broken.
      return unverifiableResult(url, {
        error: 'Timed out',
        reason: 'Timed out — may be a slow/blocking server rather than a dead link',
      });
    }
    // A redirect loop almost always means an SSO/login flow bouncing an
    // unauthenticated client back and forth, not a dead link.
    if (/redirect count exceeded/i.test(err.cause?.message || err.message || '')) {
      return unverifiableResult(url, {
        error: err.message,
        reason: 'Redirect loop — likely a login flow that requires a real browser session',
      });
    }
    return { url, ok: false, broken: true, error: err.message || 'Request failed' };
  }
}

/**
 * Crawls a site starting at startUrl, restricted to the same origin,
 * and checks every link found (internal and external) for reachability.
 *
 * @param {string} startUrl
 * @param {object} opts { maxPages, pageConcurrency, linkConcurrency, timeout, checkExternal, signal }
 * @param {(event: string, data: object) => void} emit
 */
export async function crawlSite(startUrl, opts, emit) {
  const {
    maxPages = 50,
    pageConcurrency = 5,
    linkConcurrency = 10,
    timeout = 10000,
    checkExternal = true,
    signal,
  } = opts;

  const startOrigin = new URL(startUrl).origin;
  const linkLimiter = new Limiter(linkConcurrency);

  // Cap concurrent requests per external host so we don't trigger rate
  // limiting ourselves - many distinct links (e.g. lots of resolver URLs)
  // often redirect to the same handful of vendor domains, and firing them
  // all at once can look like abuse to that server.
  const hostLimiters = new Map();
  function limiterForHost(hostname) {
    if (!hostLimiters.has(hostname)) hostLimiters.set(hostname, new Limiter(2));
    return hostLimiters.get(hostname);
  }

  const visitedPages = new Set();
  const queuedPages = new Set([startUrl]);
  const pageCheckCache = new Map(); // link url -> Promise<result>
  const stats = { pagesCrawled: 0, linksChecked: 0, brokenFound: 0, unverifiableFound: 0 };

  let queue = [startUrl];
  const inFlight = new Set();

  function isAborted() {
    return signal && signal.aborted;
  }

  function checkLinkOnce(link, foundOnPage) {
    if (!pageCheckCache.has(link)) {
      let hostname;
      try {
        hostname = new URL(link).hostname;
      } catch {
        hostname = null;
      }
      const promise = linkLimiter.run(() => {
        const run = () => checkLink(link, { timeout, signal });
        return hostname ? limiterForHost(hostname).run(run) : run();
      });
      pageCheckCache.set(link, promise);
      promise.then((result) => {
        stats.linksChecked++;
        if (result.broken) stats.brokenFound++;
        if (result.unverifiable) stats.unverifiableFound++;
        emit('link-checked', { ...result, foundOn: foundOnPage });
        emit('progress', { ...stats, pagesQueued: queue.length + inFlight.size });
      });
    } else {
      pageCheckCache.get(link).then((result) => {
        emit('link-checked', { ...result, foundOn: foundOnPage, cached: true });
      });
    }
    return pageCheckCache.get(link);
  }

  async function processPage(pageUrl) {
    emit('page-start', { url: pageUrl });
    let res;
    let html;
    try {
      res = await fetchWithTimeout(pageUrl, { timeout, signal });
      const contentType = res.headers.get('content-type') || '';
      emit('page-result', { url: pageUrl, ok: res.ok, status: res.status });
      if (!res.ok) return;
      if (!contentType.includes('text/html')) return;
      html = await res.text();
    } catch (err) {
      if (err.name === 'AbortError') return;
      emit('page-result', { url: pageUrl, ok: false, error: err.message || 'Request failed' });
      return;
    }

    const $ = cheerio.load(html);
    const hrefs = new Set();
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (isSkippableHref(href)) return;
      const abs = resolveUrl(href, pageUrl);
      if (abs) hrefs.add(abs);
    });

    for (const link of hrefs) {
      let linkOrigin;
      try {
        linkOrigin = new URL(link).origin;
      } catch {
        continue;
      }
      const sameOrigin = linkOrigin === startOrigin;

      if (sameOrigin) {
        checkLinkOnce(link, pageUrl);
        if (
          !visitedPages.has(link) &&
          !queuedPages.has(link) &&
          !NON_PAGE_EXTENSIONS.test(new URL(link).pathname) &&
          visitedPages.size + queuedPages.size < maxPages
        ) {
          queuedPages.add(link);
          queue.push(link);
        }
      } else if (checkExternal) {
        checkLinkOnce(link, pageUrl);
      }
    }
  }

  await new Promise((resolve) => {
    function pump() {
      if (isAborted()) {
        resolve();
        return;
      }
      while (
        inFlight.size < pageConcurrency &&
        queue.length > 0 &&
        visitedPages.size < maxPages
      ) {
        const url = queue.shift();
        if (visitedPages.has(url)) continue;
        visitedPages.add(url);
        stats.pagesCrawled++;
        const task = processPage(url).finally(() => {
          inFlight.delete(task);
          emit('progress', { ...stats, pagesQueued: queue.length + inFlight.size });
          pump();
        });
        inFlight.add(task);
      }
      emit('progress', { ...stats, pagesQueued: queue.length + inFlight.size });
      if (inFlight.size === 0 && (queue.length === 0 || visitedPages.size >= maxPages || isAborted())) {
        resolve();
      }
    }
    pump();
  });

  // Wait for any still-pending link checks to finish before reporting done.
  await Promise.allSettled(pageCheckCache.values());

  return stats;
}
