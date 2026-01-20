#!/usr/bin/env node
/**
 * Standalone briefing generator for GitHub Actions
 * Scrapes NYT + secondary sources and outputs briefing.json
 *
 * Run: node generate-briefing.js
 * Output: briefing.json (committed to repo, accessible via GitHub Pages)
 */

const https = require('https');
const http = require('http');
const cheerio = require('cheerio');
const fs = require('fs');

// ============================================
// FETCH UTILITIES
// ============================================

function fetch(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html, application/rss+xml, application/xml, text/xml'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetch(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

// ============================================
// NYT SCRAPING
// ============================================

function cleanHeadline(text) {
  if (!text) return null;
  let h = text.trim().replace(/\s+/g, ' ');
  h = h.replace(/^\d+\s*min\s*(read|listen)/i, '').trim();
  h = h.replace(/\d+\s*min\s*(read|listen)$/i, '').trim();
  const split = h.match(/^(.{20,}?[a-z])([A-Z][a-z]{2,}.{30,})/);
  if (split) h = split[1];
  return (h.length >= 15 && h.length <= 200) ? h : null;
}

function parseHomepage(html) {
  const $ = cheerio.load(html);
  const result = { lead: null, live: [], headlines: [] };
  const seen = new Set();

  // Live stories
  $('a[href*="/live/"]').each((i, el) => {
    let h = $(el).text().trim().replace(/\s+/g, ' ').replace(/Jan\.\s*\d+.*?ET/gi, '').trim();
    if (h.length < 5) return;
    const url = $(el).attr('href');
    const full = url?.startsWith('/') ? 'https://www.nytimes.com' + url : url;
    if (full && !seen.has(full)) {
      seen.add(full);
      result.live.push({ headline: h, url: full, source: 'Live' });
    }
  });

  // Regular articles - match current and previous year
  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;
  $(`a[href*="/${currentYear}/"], a[href*="/${prevYear}/"]`).each((i, el) => {
    const href = $(el).attr('href');
    if (!href?.match(/\/\d{4}\/\d{2}\/\d{2}\//)) return;
    if (href.includes('/video/') || href.includes('/interactive/')) return;
    const h = cleanHeadline($(el).text());
    if (!h) return;
    const full = href.startsWith('/') ? 'https://www.nytimes.com' + href : href;
    if (seen.has(full)) return;
    seen.add(full);
    if (!result.lead) result.lead = { headline: h, url: full, source: 'Lead' };
    result.headlines.push({ headline: h, url: full, source: 'Homepage' });
  });

  return result;
}

function parseSection(html, name) {
  const $ = cheerio.load(html);
  const headlines = [];
  const seen = new Set();
  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;

  $(`a[href*="/${currentYear}/"], a[href*="/${prevYear}/"]`).each((i, el) => {
    const href = $(el).attr('href');
    if (!href?.match(/\/\d{4}\/\d{2}\/\d{2}\//)) return;
    const h = cleanHeadline($(el).text());
    if (!h) return;
    const full = href.startsWith('/') ? 'https://www.nytimes.com' + href : href;
    if (seen.has(full)) return;
    seen.add(full);
    headlines.push({ headline: h, url: full, source: name });
  });

  return headlines;
}

async function scrapeNYT() {
  console.log('Scraping NYT...');
  const results = { lead: null, live: [], primary: [], secondary: [], timestamp: null };

  const tasks = [
    { type: 'homepage', url: 'https://www.nytimes.com/' },
    { type: 'section', url: 'https://www.nytimes.com/section/us', name: 'U.S.' },
    { type: 'section', url: 'https://www.nytimes.com/section/politics', name: 'Politics' },
    { type: 'section', url: 'https://www.nytimes.com/section/world/americas', name: 'Latin America' },
    { type: 'section', url: 'https://www.nytimes.com/section/world/europe', name: 'Europe' },
    { type: 'section', url: 'https://www.nytimes.com/section/world/asia', name: 'Asia' },
    { type: 'section', url: 'https://www.nytimes.com/section/world/middleeast', name: 'Middle East' },
    { type: 'section', url: 'https://www.nytimes.com/section/world/africa', name: 'Africa' },
    { type: 'section', url: 'https://www.nytimes.com/section/business', name: 'Business' },
    { type: 'section', url: 'https://www.nytimes.com/section/technology', name: 'Technology' }
  ];

  const seen = new Set();

  for (const task of tasks) {
    try {
      const html = await fetch(task.url);
      if (task.type === 'homepage') {
        const hp = parseHomepage(html);
        results.lead = hp.lead;
        results.live = hp.live;
        hp.headlines.slice(0, 10).forEach(h => {
          if (!seen.has(h.url)) {
            seen.add(h.url);
            results.primary.push(h);
          }
        });
      } else {
        const headlines = parseSection(html, task.name);
        headlines.slice(0, 5).forEach(h => {
          if (!seen.has(h.url)) {
            seen.add(h.url);
            results.secondary.push(h);
          }
        });
      }
      console.log(`  ✓ ${task.name || 'Homepage'}`);
    } catch (e) {
      console.log(`  ✗ ${task.name || 'Homepage'}: ${e.message}`);
    }
  }

  results.timestamp = new Date().toISOString();
  return results;
}

// ============================================
// RSS SCRAPING
// ============================================

function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const title = (itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                   itemXml.match(/<title>(.*?)<\/title>/))?.[1]?.trim();
    const link = (itemXml.match(/<link><!\[CDATA\[(.*?)\]\]><\/link>/) ||
                  itemXml.match(/<link>(.*?)<\/link>/))?.[1]?.trim();
    const description = (itemXml.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) ||
                        itemXml.match(/<description>(.*?)<\/description>/))?.[1]?.trim();
    const pubDate = (itemXml.match(/<pubDate>(.*?)<\/pubDate>/))?.[1]?.trim();

    if (title && link) {
      items.push({
        title: title.replace(/<[^>]*>/g, '').trim(),
        link: link,
        description: description ? description.replace(/<[^>]*>/g, '').trim().slice(0, 200) : '',
        pubDate: pubDate || null
      });
    }
  }
  return items;
}

const RSS_FEEDS = {
  reuters: [{ name: 'Reuters', url: 'https://news.google.com/rss/search?q=when:24h+allinurl:reuters.com&ceid=US:en&hl=en-US&gl=US' }],
  ap: [{ name: 'AP', url: 'https://news.google.com/rss/search?q=when:24h+allinurl:apnews.com&ceid=US:en&hl=en-US&gl=US' }],
  bbc: [{ name: 'BBC World', url: 'http://feeds.bbci.co.uk/news/world/rss.xml' }],
  wsj: [
    { name: 'WSJ World', url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml' },
    { name: 'WSJ Markets', url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml' }
  ],
  ft: [{ name: 'FT', url: 'https://www.ft.com/rss/home' }],
  bloomberg: [
    { name: 'Bloomberg Markets', url: 'https://feeds.bloomberg.com/markets/news.rss' },
    { name: 'Bloomberg Politics', url: 'https://feeds.bloomberg.com/politics/news.rss' }
  ],
  guardian: [{ name: 'Guardian World', url: 'https://www.theguardian.com/world/rss' }],
  aljazeera: [{ name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' }],
  washpost: [{ name: 'Washington Post World', url: 'https://feeds.washingtonpost.com/rss/world' }],
  economist: [{ name: 'Economist', url: 'https://news.google.com/rss/search?q=when:7d+allinurl:economist.com&ceid=US:en&hl=en-US&gl=US' }],
  scmp: [{ name: 'South China Morning Post', url: 'https://www.scmp.com/rss/91/feed' }],
  timesofisrael: [{ name: 'Times of Israel', url: 'https://www.timesofisrael.com/feed/' }],
  afp: [{ name: 'AFP/France24', url: 'https://www.france24.com/en/rss' }]
};

async function scrapeRSS() {
  console.log('Scraping RSS feeds...');
  const results = {};

  for (const [source, feeds] of Object.entries(RSS_FEEDS)) {
    results[source] = [];
    for (const feed of feeds) {
      try {
        const xml = await fetch(feed.url);
        const items = parseRSS(xml);
        results[source].push(...items.slice(0, 8).map(item => ({
          ...item,
          source: feed.name
        })));
        console.log(`  ✓ ${feed.name} (${items.length} items)`);
      } catch (e) {
        console.log(`  ✗ ${feed.name}: ${e.message}`);
      }
    }
  }

  results.timestamp = new Date().toISOString();
  return results;
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('='.repeat(50));
  console.log('Generating Briefing');
  console.log(new Date().toISOString());
  console.log('='.repeat(50));
  console.log('');

  const startTime = Date.now();

  // Run both scrapers in parallel
  const [nyt, secondary] = await Promise.all([
    scrapeNYT(),
    scrapeRSS()
  ]);

  const briefing = {
    nyt,
    secondary,
    generated: new Date().toISOString(),
    source: 'github-actions'
  };

  // Save to file (will be committed by GitHub Actions)
  fs.writeFileSync('briefing.json', JSON.stringify(briefing, null, 2));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('');
  console.log('='.repeat(50));
  console.log('RESULTS');
  console.log('='.repeat(50));
  console.log(`NYT Lead: ${nyt.lead?.headline || 'None'}`);
  console.log(`NYT Live: ${nyt.live.length} | Primary: ${nyt.primary.length} | Secondary: ${nyt.secondary.length}`);
  console.log(`RSS sources: ${Object.keys(secondary).length - 1}`);
  console.log(`Time: ${elapsed}s`);
  console.log('');
  console.log('Output: briefing.json');

  // Exit with error if no data (so GitHub Actions marks it as failed)
  if (!nyt.lead && nyt.primary.length === 0) {
    console.error('❌ FAILED: No NYT data scraped');
    process.exit(1);
  }

  console.log('✅ SUCCESS');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
