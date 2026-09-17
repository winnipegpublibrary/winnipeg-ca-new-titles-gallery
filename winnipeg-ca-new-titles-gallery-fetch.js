#!/usr/bin/env node
/**
 * WPL New Titles Gallery — GitHub Actions fetch script
 *
 * Fetches every curated Enterprise RSS list, parses out title/link/ISBN,
 * and writes a single static JSON file for GitHub Pages to serve. Run on
 * a schedule by .github/workflows/refresh-new-titles.yml.
 *
 * This is a direct port of the parsing logic from the Google Apps Script
 * proxy (new-titles-proxy.gs). That logic was hard-won over many rounds
 * of real Enterprise feed data breaking naive XML parsing — see the
 * comments below and the project docs for why it's built this way.
 *
 * No CORS concern here at all: CORS is a browser-only restriction, and
 * this runs server-side, fetching Enterprise directly. The reason a
 * static file exists at all is so BROWSERS can read the result without
 * hitting Enterprise (or any live backend) themselves.
 *
 * Free-text search is NOT supported by this approach — there's no live
 * backend to run an arbitrary query against a static file. If search
 * comes back, it'll need its own live piece again (Azure Function, or
 * similar) alongside this.
 */

const fs = require('fs');
const path = require('path');

const ENTERPRISE_HOST = 'https://winca.ent.sirsidynix.net';
const MAX_ITEMS = 30;
const RETRY_PAUSE_MS = 1500;
const REQUEST_PAUSE_MS = 500; // between sequential suffix fetches within one target
const TARGET_PAUSE_MS = 800;  // between different targets, being gentle overall

const OUTPUT_DIR = path.join(__dirname, 'docs', 'data');
const DATA_FILE = path.join(OUTPUT_DIR, 'new-titles.json');
const STATUS_FILE = path.join(OUTPUT_DIR, 'status.json');

// Same FEEDS mapping as the GAS proxy — kept in sync manually for now,
// since this is a separate codebase from new-titles-proxy.gs.
const FEEDS = {
  fiction:        { stem: 'n2ew' },
  nonfiction:     { stem: 'n2ewnf' },
  biography:      { stem: 'n2ewnf', lm: 'BIOGRAPHY' },
  mystery:        { stem: 'n2ew', lm: 'MYSTERY' },
  romance:        { stem: 'n2ew', lm: 'ROMANCE' },
  scifi:          { stem: 'n2ew', lm: 'SCIFI' },
  inspirational:  { stem: 'n2ew', lm: 'INSPIRATIONAL' },
  genFiction:     { stem: 'n2ew', lm: 'GENFICTION' },
  graphicNovels:  { stem: 'n2ewgn' },
  largeType:      { stem: 'n2ewlt' },

  childrensFiction:    { stem: 'n2ewjf' },
  childrensNonfiction: { stem: 'n2ewjnf' },
  pictureBooks:        { stem: 'n2ewjx' },
  youngAdult:          { stem: 'n2ewya' },

  audiobooks:  { stem: 'n2ewa' },
  dvd:         { stem: 'n2ewdvd' },
  musicCd:     { stem: 'n2ewcd' },
  videoGames:  { stem: 'n2ewgm' },
};

// Which (key, months) combinations to actually fetch. Mirrors the GAS
// proxy's REFRESH_TARGETS: the default view for every list, plus the
// two known-sparse shelves also get a months=2 merged version.
const TARGETS = Object.keys(FEEDS).map((key) => ({ key, months: 1 }))
  .concat([
    { key: 'graphicNovels', months: 2 },
    { key: 'largeType', months: 2 },
  ]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Confirmed against the actual "RSS" link Enterprise generates in the
// browser — a completely different path/encoding than the standard
// search-results page.
function buildQueryUrl(term, lm, exact) {
  const q = exact ? `"${term}"` : term;
  let qs = 'qu=' + encodeURIComponent(q);
  if (lm) qs += '&te=&lm=' + encodeURIComponent(lm);
  return `${ENTERPRISE_HOST}/client/rss/hitlist/default/${qs}`;
}

function buildFeedUrl(feed, suffix) {
  return buildQueryUrl(feed.stem + suffix, feed.lm, true);
}

async function fetchWithRetry(url) {
  const fetchOptions = {
    headers: {
      Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml',
    },
  };
  let resp = await fetch(url, fetchOptions);
  if (resp.status !== 200) {
    await sleep(RETRY_PAUSE_MS);
    resp = await fetch(url, fetchOptions);
  }
  return resp;
}

// Decodes standard XML entities plus numeric character references.
// Anything that isn't a recognized entity is left exactly as-is —
// including a stray unescaped '&' that shouldn't have been there in
// the first place, which just comes through as a literal '&'.
function unescapeXml(str) {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function cleanTitle(t) {
  if (!t) return '';
  return t.replace(/\.\s*$/, '').trim();
}

// Enterprise's content field embeds the ISBN inside a double-escaped
// "&amp;#160;" (non-breaking space) entity. The literal characters
// "160" sitting right there look like the start of a digit run and
// will wreck a naive "skip non-digits then grab digits" regex. This
// instead looks for a digit run of exact ISBN length (13, or 10
// possibly ending in X), so the false 3-digit run gets skipped over
// naturally rather than tripping up the match.
function extractIsbn(rawContent) {
  const isbnIndex = rawContent.indexOf('ISBN');
  if (isbnIndex === -1) return null;
  const window = rawContent.slice(isbnIndex, isbnIndex + 60);
  const match = window.match(/\d{13}|\d{9}[\dXx]/);
  return match ? match[0] : null;
}

// Enterprise's feed has repeatedly contained malformed markup —
// unescaped ampersands, illegal control characters, even a stray raw
// <input> HTML fragment leaking in from a vendor-supplied field. A
// strict XML parser rejects the whole document over one bad character
// anywhere in it. This instead pulls each entry's fields out with
// targeted pattern matching that doesn't care what garbage sits
// between tags.
function parseEntry(block) {
  const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
  const title = titleMatch ? cleanTitle(unescapeXml(titleMatch[1])) : '';

  const linkMatch = block.match(/<link\b[^>]*\brel="alternate"[^>]*\bhref="([^"]*)"/);
  const link = linkMatch ? unescapeXml(linkMatch[1]) : null;

  const contentMatch = block.match(/<content[^>]*>([\s\S]*?)<\/content>/);
  const rawContent = contentMatch ? contentMatch[1] : '';
  const isbn = extractIsbn(rawContent);

  return { title, link, isbn };
}

async function fetchAndParse(url) {
  const resp = await fetchWithRetry(url);
  if (resp.status !== 200) {
    throw new Error(`Enterprise returned ${resp.status} (after retry) for ${url}`);
  }
  const text = await resp.text();
  const entryBlocks = text.match(/<entry>[\s\S]*?<\/entry>/g) || [];

  const items = [];
  for (let i = 0; i < entryBlocks.length && items.length < MAX_ITEMS; i++) {
    const parsed = parseEntry(entryBlocks[i]);
    if (!parsed.title || !parsed.link || !parsed.isbn) continue;
    items.push(parsed);
  }
  return items;
}

async function fetchMerged(feed, months) {
  const seen = new Set();
  const merged = [];

  for (let suffix = 1; suffix <= months && merged.length < MAX_ITEMS; suffix++) {
    if (suffix > 1) await sleep(REQUEST_PAUSE_MS);
    const items = await fetchAndParse(buildFeedUrl(feed, suffix));
    for (const item of items) {
      if (merged.length >= MAX_ITEMS) break;
      if (seen.has(item.isbn)) continue;
      seen.add(item.isbn);
      merged.push(item);
    }
  }
  return merged;
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const lists = {};
  const status = { generatedAt: new Date().toISOString(), targets: [] };

  for (let i = 0; i < TARGETS.length; i++) {
    if (i > 0) await sleep(TARGET_PAUSE_MS);
    const { key, months } = TARGETS[i];
    const outputKey = months > 1 ? `${key}:${months}` : key;
    const feed = FEEDS[key];

    try {
      const items = await fetchMerged(feed, months);
      lists[outputKey] = { items };
      status.targets.push({ key: outputKey, ok: true, itemCount: items.length });
      console.log(`OK   ${outputKey}: ${items.length} items`);
    } catch (err) {
      // One target failing shouldn't take down the rest. If there's
      // an existing JSON file from a previous successful run, leave
      // that list's old data in place rather than dropping it —
      // visitors see slightly stale covers rather than a broken
      // shelf. Fresh runs with no prior file just omit it.
      const previous = readPreviousData();
      if (previous && previous.lists && previous.lists[outputKey]) {
        lists[outputKey] = previous.lists[outputKey];
        status.targets.push({ key: outputKey, ok: false, error: String(err), keptStale: true });
        console.error(`FAIL ${outputKey} (kept stale data): ${err}`);
      } else {
        status.targets.push({ key: outputKey, ok: false, error: String(err), keptStale: false });
        console.error(`FAIL ${outputKey} (no prior data to fall back on): ${err}`);
      }
    }
  }

  fs.writeFileSync(DATA_FILE, JSON.stringify({ generatedAt: status.generatedAt, lists }, null, 2));
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));

  const failures = status.targets.filter((t) => !t.ok);
  if (failures.length) {
    console.error(`\n${failures.length} of ${status.targets.length} targets failed.`);
    // Exit code reflects failure for GitHub Actions' own visibility
    // (a red X on the workflow run), but only if EVERY target failed
    // — a handful of failures with stale fallback data isn't worth
    // alerting on, since visitors still see a working (if slightly
    // outdated) gallery either way.
    if (failures.length === status.targets.length) {
      process.exit(1);
    }
  }
}

function readPreviousData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
