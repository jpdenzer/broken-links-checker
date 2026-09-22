import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawlSite } from './lib/crawler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/scan', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) {
    res.status(400).json({ error: 'Missing url query parameter' });
    return;
  }

  let startUrl;
  try {
    startUrl = new URL(rawUrl).toString();
  } catch {
    res.status(400).json({ error: 'Invalid URL' });
    return;
  }

  const maxPages = Math.min(Math.max(parseInt(req.query.maxPages, 10) || 50, 1), 500);
  const checkExternal = req.query.checkExternal !== 'false';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  function emit(event, data) {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  emit('start', { url: startUrl, maxPages, checkExternal });

  try {
    const stats = await crawlSite(
      startUrl,
      { maxPages, checkExternal, signal: controller.signal },
      emit
    );
    emit('done', stats);
  } catch (err) {
    emit('fatal-error', { error: err.message || 'Crawl failed' });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Broken Links Checker running at http://localhost:${PORT}`);
});
