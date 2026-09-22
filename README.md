# Broken Links Checker

A local web app that crawls a website and reports broken links, page by page — with live progress and results streamed straight to the browser.

## Features

- **Crawls a whole site** from a single starting URL, staying within the same origin
- **Checks every link it finds** — both internal pages and external links — for reachability
- **Live progress** streamed to the browser via Server-Sent Events (pages crawled, links checked, running counts)
- **Separates real breakage from false positives.** Links are only reported as **broken** on strong signals (404, 410, 5xx, DNS/connection failures). Ambiguous responses — `400`, `401`, `403`, `407`, `429`, `503`, timeouts, or redirect loops — are reported as **unverifiable** instead, since these usually mean a WAF, rate limiter, or login wall is blocking an automated request rather than the link actually being dead
- **Deduplicates results.** A link that appears on many pages (e.g. a footer or social link) shows as a single row with an expandable "found on N pages" list, instead of one row per occurrence
- **Configurable scans** — cap the number of pages crawled, and choose whether external links are checked

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later (uses the built-in `fetch` API)
- npm (comes bundled with Node.js)

## Setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/jpdenzer/broken-links-checker.git
cd broken-links-checker
npm install
```

## Running locally

Start the server:

```bash
npm start
```

Then open **http://localhost:3000** in your browser.

By default the server listens on port `3000`. To use a different port:

```bash
PORT=4000 npm start
```

## Usage

1. Enter the URL of the site you want to scan.
2. Optionally adjust:
   - **Max pages** — the maximum number of pages to crawl (default 50, capped at 500)
   - **Check external links too** — whether links pointing off-site are also checked (default on)
3. Click **Start Scan**. Progress streams in live: pages crawled, links checked, and running broken/unverifiable counts.
4. Review results in two tables:
   - **Broken links** — confirmed dead links (404, 410, server errors, DNS/connection failures)
   - **Unverifiable links** — links that returned an ambiguous response (see [How link classification works](#how-link-classification-works)) and should be checked manually
5. Click **Stop** at any time to cancel an in-progress scan.

## How link classification works

An automated checker can't always tell the difference between "this page doesn't exist" and "this server is blocking scripted requests." To avoid flooding you with false positives, results are classified by response signal:

| Classification | Triggers | Meaning |
|---|---|---|
| **Broken** | `404`, `410`, other `5xx`, DNS failure, connection refused | High-confidence — the link is very likely actually dead |
| **Unverifiable** | `400`, `401`, `403`, `407`, `429`, `503`, request timeout, redirect loop | Ambiguous — often a WAF, rate limit, bot check, or login wall; frequently works fine in a real browser |

Each unverifiable link includes a short reason (e.g. "Rate limited — too many requests, not a dead link") to help you judge whether it's worth investigating further.

## Project structure

```
.
├── server.js          # Express server; exposes /api/scan as an SSE endpoint
├── lib/
│   ├── crawler.js      # Site crawler, link checker, and classification logic
│   └── limiter.js      # Small concurrency limiter (no external deps)
└── public/
    ├── index.html      # UI markup
    ├── app.js          # Frontend logic (EventSource consumer, results rendering)
    └── style.css        # Styling
```

## Tech stack

- [Express](https://expressjs.com/) for the server and Server-Sent Events endpoint
- [Cheerio](https://cheerio.js.org/) for parsing crawled pages and extracting links
- Vanilla HTML/CSS/JS on the frontend — no build step required
