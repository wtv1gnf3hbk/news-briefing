#!/usr/bin/env node
/**
 * Standalone briefing generator for GitHub Actions
 * Scrapes NYT + secondary sources and outputs briefing.json
 *
 * All fetches run in parallel for speed (~2-3s total)
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
    req.setTimeout(10000, () => {
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

// ============================================
// INTERNATIONAL HOMEPAGE SCRAPING
// ============================================

function parseBBCHomepage(html) {
  const $ = cheerio.load(html);
  const stories = [];
  const seen = new Set();

  // BBC uses data-testid for hero/lead stories and h2 for headlines
  // Look for prominent story containers first
  $('h2').each((i, el) => {
    const $el = $(el);
    const $link = $el.find('a').first() || $el.closest('a');
    let url = $link.attr('href') || $el.closest('a').attr('href');
    if (!url) return;

    // Make URL absolute
    if (url.startsWith('/')) url = 'https://www.bbc.com' + url;
    if (!url.includes('bbc.com') && !url.includes('bbc.co.uk')) return;

    const headline = $el.text().trim().replace(/\s+/g, ' ');
    if (headline.length < 10 || headline.length > 200) return;
    if (seen.has(url)) return;
    seen.add(url);

    stories.push({ headline, url, source: 'BBC' });
  });

  // Also check h3s for additional stories
  $('h3').each((i, el) => {
    if (stories.length >= 10) return;
    const $el = $(el);
    let url = $el.find('a').attr('href') || $el.closest('a').attr('href');
    if (!url) return;

    if (url.startsWith('/')) url = 'https://www.bbc.com' + url;
    if (!url.includes('bbc.com') && !url.includes('bbc.co.uk')) return;

    const headline = $el.text().trim().replace(/\s+/g, ' ');
    if (headline.length < 10 || headline.length > 200) return;
    if (seen.has(url)) return;
    seen.add(url);

    stories.push({ headline, url, source: 'BBC' });
  });

  return { lead: stories[0] || null, top: stories.slice(0, 5) };
}

function parseGuardianHomepage(html) {
  const $ = cheerio.load(html);
  const stories = [];
  const seen = new Set();

  // Guardian uses fc-item containers with fc-item__link for articles
  // Try multiple selector strategies

  // Strategy 1: fc-item containers (main Guardian homepage structure)
  $('div.fc-item__container a.fc-item__link, a.fc-item__link').each((i, el) => {
    if (stories.length >= 10) return;
    const $el = $(el);
    let url = $el.attr('href');
    if (!url) return;

    if (url.startsWith('/')) url = 'https://www.theguardian.com' + url;
    if (!url.includes('theguardian.com')) return;
    if (url.includes('/live/') || url.includes('/video/')) return;

    // Get headline from link text or nearby headline element
    let headline = $el.find('.fc-item__headline, .fc-item__title').text().trim();
    if (!headline) headline = $el.text().trim();
    headline = headline.replace(/\s+/g, ' ');

    if (headline.length < 10 || headline.length > 200) return;
    if (seen.has(url)) return;
    seen.add(url);

    stories.push({ headline, url, source: 'Guardian' });
  });

  // Strategy 2: data-link-name attributes (Guardian's tracking structure)
  if (stories.length < 3) {
    $('a[data-link-name*="article"]').each((i, el) => {
      if (stories.length >= 10) return;
      const $el = $(el);
      let url = $el.attr('href');
      if (!url) return;

      if (url.startsWith('/')) url = 'https://www.theguardian.com' + url;
      if (!url.includes('theguardian.com')) return;
      if (url.includes('/live/') || url.includes('/video/')) return;
      if (seen.has(url)) return;

      const headline = $el.text().trim().replace(/\s+/g, ' ');
      if (headline.length < 10 || headline.length > 200) return;
      seen.add(url);

      stories.push({ headline, url, source: 'Guardian' });
    });
  }

  // Strategy 3: Fallback to h3/h2 with links (older structure)
  if (stories.length < 3) {
    $('h3 a, h2 a, h1 a').each((i, el) => {
      if (stories.length >= 10) return;
      const $el = $(el);
      let url = $el.attr('href');
      if (!url) return;

      if (url.startsWith('/')) url = 'https://www.theguardian.com' + url;
      if (!url.includes('theguardian.com')) return;
      if (url.includes('/live/') || url.includes('/video/')) return;
      if (seen.has(url)) return;

      const headline = $el.text().trim().replace(/\s+/g, ' ');
      if (headline.length < 10 || headline.length > 200) return;
      seen.add(url);

      stories.push({ headline, url, source: 'Guardian' });
    });
  }

  return { lead: stories[0] || null, top: stories.slice(0, 5) };
}

function parseAlJazeeraHomepage(html) {
  const $ = cheerio.load(html);
  const stories = [];
  const seen = new Set();

  // Al Jazeera uses h3 for headlines typically
  $('h3 a, h2 a, .article-card a').each((i, el) => {
    if (stories.length >= 10) return;
    const $el = $(el);
    let url = $el.attr('href');
    if (!url) return;

    if (url.startsWith('/')) url = 'https://www.aljazeera.com' + url;
    if (!url.includes('aljazeera.com')) return;

    // Try to get headline from the link text or parent h3
    let headline = $el.text().trim().replace(/\s+/g, ' ');
    if (headline.length < 10) {
      headline = $el.closest('article, .article-card').find('h3, h2').first().text().trim().replace(/\s+/g, ' ');
    }
    if (headline.length < 10 || headline.length > 200) return;
    if (seen.has(url)) return;
    seen.add(url);

    stories.push({ headline, url, source: 'Al Jazeera' });
  });

  return { lead: stories[0] || null, top: stories.slice(0, 5) };
}

function parseEconomistWorldInBrief(html) {
  const $ = cheerio.load(html);
  const stories = [];
  const seen = new Set();

  // World in Brief uses various structures - try multiple strategies

  // Strategy 1: Topic item containers (common Economist structure)
  $('div.topic-item-container, div[class*="topic-item"]').each((i, el) => {
    if (stories.length >= 10) return;
    const $el = $(el);
    const $link = $el.find('a').first();
    let url = $link.attr('href');

    if (!url) return;
    if (url.startsWith('/')) url = 'https://www.economist.com' + url;

    const headline = $link.text().trim().replace(/\s+/g, ' ');
    if (headline.length < 10 || headline.length > 200) return;
    if (seen.has(url)) return;
    seen.add(url);

    stories.push({ headline, url, source: 'Economist' });
  });

  // Strategy 2: Article cards/teasers
  if (stories.length < 3) {
    $('article, div[class*="teaser"], div[class*="card"]').each((i, el) => {
      if (stories.length >= 10) return;
      const $el = $(el);
      const $link = $el.find('a[href*="/"]').first();
      let url = $link.attr('href');

      if (!url) return;
      if (url.startsWith('/')) url = 'https://www.economist.com' + url;
      if (!url.includes('economist.com')) return;
      if (seen.has(url)) return;

      // Try to find headline in h2, h3, or link text
      let headline = $el.find('h2, h3, h4').first().text().trim();
      if (!headline) headline = $link.text().trim();
      headline = headline.replace(/\s+/g, ' ');

      if (headline.length < 10 || headline.length > 200) return;
      seen.add(url);

      stories.push({ headline, url, source: 'Economist' });
    });
  }

  // Strategy 3: World in Brief bullet points (bold lead text)
  if (stories.length < 3) {
    $('p').each((i, el) => {
      if (stories.length >= 10) return;
      const $el = $(el);

      // Look for paragraphs with bold opening (typical World in Brief style)
      const $bold = $el.find('strong, b').first();
      if (!$bold.length) return;

      const boldText = $bold.text().trim();
      if (boldText.length < 10) return;

      const fullText = $el.text().trim().replace(/\s+/g, ' ');
      if (fullText.length < 30 || fullText.length > 400) return;

      const $link = $el.find('a').first();
      let url = $link.attr('href');
      if (!url) url = 'https://www.economist.com/the-world-in-brief';
      else if (url.startsWith('/')) url = 'https://www.economist.com' + url;

      if (seen.has(boldText)) return;
      seen.add(boldText);

      // Use bold text as headline, or truncated full text
      const headline = boldText.length > 20 ? boldText.slice(0, 150) : fullText.slice(0, 150);
      stories.push({ headline, url, source: 'Economist' });
    });
  }

  // Strategy 4: Any headline links as fallback
  if (stories.length < 3) {
    $('h2 a, h3 a, a[class*="headline"]').each((i, el) => {
      if (stories.length >= 10) return;
      const $el = $(el);
      let url = $el.attr('href');

      if (!url) return;
      if (url.startsWith('/')) url = 'https://www.economist.com' + url;
      if (!url.includes('economist.com')) return;
      if (seen.has(url)) return;

      const headline = $el.text().trim().replace(/\s+/g, ' ');
      if (headline.length < 10 || headline.length > 200) return;
      seen.add(url);

      stories.push({ headline, url, source: 'Economist' });
    });
  }

  return { lead: stories[0] || null, top: stories.slice(0, 5) };
}

function parseReutersHomepage(html) {
  const $ = cheerio.load(html);
  const stories = [];
  const seen = new Set();

  // Reuters has a mix of structures, look for headline patterns
  $('[data-testid*="Headline"] a, h3 a, h2 a').each((i, el) => {
    if (stories.length >= 10) return;
    const $el = $(el);
    let url = $el.attr('href');
    if (!url) return;

    if (url.startsWith('/')) url = 'https://www.reuters.com' + url;
    if (!url.includes('reuters.com')) return;

    const headline = $el.text().trim().replace(/\s+/g, ' ');
    if (headline.length < 10 || headline.length > 200) return;
    if (seen.has(url)) return;
    seen.add(url);

    stories.push({ headline, url, source: 'Reuters' });
  });

  return { lead: stories[0] || null, top: stories.slice(0, 5) };
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

// ============================================
// ALL SOURCES (fetched in parallel)
// ============================================

const ALL_SOURCES = [
  // NYT
  { id: 'nyt_homepage', type: 'nyt', url: 'https://www.nytimes.com/', name: 'Homepage' },
  { id: 'nyt_us', type: 'nyt_section', url: 'https://www.nytimes.com/section/us', name: 'U.S.' },
  { id: 'nyt_politics', type: 'nyt_section', url: 'https://www.nytimes.com/section/politics', name: 'Politics' },
  { id: 'nyt_latam', type: 'nyt_section', url: 'https://www.nytimes.com/section/world/americas', name: 'Latin America' },
  { id: 'nyt_europe', type: 'nyt_section', url: 'https://www.nytimes.com/section/world/europe', name: 'Europe' },
  { id: 'nyt_asia', type: 'nyt_section', url: 'https://www.nytimes.com/section/world/asia', name: 'Asia' },
  { id: 'nyt_mideast', type: 'nyt_section', url: 'https://www.nytimes.com/section/world/middleeast', name: 'Middle East' },
  { id: 'nyt_africa', type: 'nyt_section', url: 'https://www.nytimes.com/section/world/africa', name: 'Africa' },
  { id: 'nyt_business', type: 'nyt_section', url: 'https://www.nytimes.com/section/business', name: 'Business' },
  { id: 'nyt_tech', type: 'nyt_section', url: 'https://www.nytimes.com/section/technology', name: 'Technology' },

  // International homepages (for cross-source lead comparison)
  // Key sources: UK editions for non-US perspective
  { id: 'bbc_homepage', type: 'bbc_homepage', url: 'https://www.bbc.co.uk/news', name: 'BBC' },
  { id: 'guardian_homepage', type: 'guardian_homepage', url: 'https://www.theguardian.com/uk', name: 'Guardian' },
  { id: 'economist_homepage', type: 'economist_homepage', url: 'https://www.economist.com/the-world-in-brief', name: 'Economist' },
  // Additional international sources
  { id: 'aljazeera_homepage', type: 'aljazeera_homepage', url: 'https://www.aljazeera.com/', name: 'Al Jazeera' },
  { id: 'reuters_homepage', type: 'reuters_homepage', url: 'https://www.reuters.com/', name: 'Reuters' },

  // RSS feeds
  { id: 'reuters', type: 'rss', url: 'https://news.google.com/rss/search?q=when:24h+allinurl:reuters.com&ceid=US:en&hl=en-US&gl=US', name: 'Reuters' },
  { id: 'ap', type: 'rss', url: 'https://news.google.com/rss/search?q=when:24h+allinurl:apnews.com&ceid=US:en&hl=en-US&gl=US', name: 'AP' },
  { id: 'bbc', type: 'rss', url: 'http://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC World' },
  { id: 'wsj', type: 'rss', url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml', name: 'WSJ World' },
  { id: 'wsj_markets', type: 'rss', url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', name: 'WSJ Markets' },
  { id: 'bloomberg', type: 'rss', url: 'https://feeds.bloomberg.com/markets/news.rss', name: 'Bloomberg Markets' },
  { id: 'bloomberg_politics', type: 'rss', url: 'https://feeds.bloomberg.com/politics/news.rss', name: 'Bloomberg Politics' },
  { id: 'guardian', type: 'rss', url: 'https://www.theguardian.com/world/rss', name: 'Guardian World' },
  { id: 'aljazeera', type: 'rss', url: 'https://www.aljazeera.com/xml/rss/all.xml', name: 'Al Jazeera' },
  { id: 'washpost', type: 'rss', url: 'https://feeds.washingtonpost.com/rss/world', name: 'Washington Post' },
  { id: 'economist', type: 'rss', url: 'https://news.google.com/rss/search?q=when:7d+allinurl:economist.com&ceid=US:en&hl=en-US&gl=US', name: 'Economist' },
  { id: 'scmp', type: 'rss', url: 'https://www.scmp.com/rss/91/feed', name: 'SCMP' },
  { id: 'timesofisrael', type: 'rss', url: 'https://www.timesofisrael.com/feed/', name: 'Times of Israel' },
  { id: 'afp', type: 'rss', url: 'https://www.france24.com/en/rss', name: 'AFP/France24' }
];

async function scrapeAll() {
  console.log('Fetching all sources in parallel...');

  // Fetch everything at once
  const results = await Promise.all(
    ALL_SOURCES.map(async (source) => {
      try {
        const html = await fetch(source.url);
        return { ...source, html, error: null };
      } catch (e) {
        return { ...source, html: null, error: e.message };
      }
    })
  );

  // Process results
  const nyt = { lead: null, live: [], primary: [], secondary: [], timestamp: new Date().toISOString() };
  const secondary = { timestamp: new Date().toISOString() };
  const internationalLeads = { timestamp: new Date().toISOString() };
  const seen = new Set();

  for (const result of results) {
    if (result.error) {
      console.log(`  ✗ ${result.name}: ${result.error}`);
      continue;
    }

    if (result.type === 'nyt') {
      const hp = parseHomepage(result.html);
      nyt.lead = hp.lead;
      nyt.live = hp.live;
      hp.headlines.slice(0, 10).forEach(h => {
        if (!seen.has(h.url)) {
          seen.add(h.url);
          nyt.primary.push(h);
        }
      });
      console.log(`  ✓ ${result.name}`);
    }
    else if (result.type === 'nyt_section') {
      const headlines = parseSection(result.html, result.name);
      headlines.slice(0, 5).forEach(h => {
        if (!seen.has(h.url)) {
          seen.add(h.url);
          nyt.secondary.push(h);
        }
      });
      console.log(`  ✓ ${result.name}`);
    }
    else if (result.type === 'bbc_homepage') {
      const parsed = parseBBCHomepage(result.html);
      internationalLeads.bbc = { lead: parsed.lead, top: parsed.top };
      console.log(`  ✓ ${result.name} (lead: ${parsed.lead?.headline?.slice(0, 40) || 'none'}...)`);
    }
    else if (result.type === 'guardian_homepage') {
      const parsed = parseGuardianHomepage(result.html);
      internationalLeads.guardian = { lead: parsed.lead, top: parsed.top };
      console.log(`  ✓ ${result.name} (lead: ${parsed.lead?.headline?.slice(0, 40) || 'none'}...)`);
    }
    else if (result.type === 'economist_homepage') {
      const parsed = parseEconomistWorldInBrief(result.html);
      internationalLeads.economist = { lead: parsed.lead, top: parsed.top };
      console.log(`  ✓ ${result.name} (lead: ${parsed.lead?.headline?.slice(0, 40) || 'none'}...)`);
    }
    else if (result.type === 'aljazeera_homepage') {
      const parsed = parseAlJazeeraHomepage(result.html);
      internationalLeads.aljazeera = { lead: parsed.lead, top: parsed.top };
      console.log(`  ✓ ${result.name} (lead: ${parsed.lead?.headline?.slice(0, 40) || 'none'}...)`);
    }
    else if (result.type === 'reuters_homepage') {
      const parsed = parseReutersHomepage(result.html);
      internationalLeads.reuters = { lead: parsed.lead, top: parsed.top };
      console.log(`  ✓ ${result.name} (lead: ${parsed.lead?.headline?.slice(0, 40) || 'none'}...)`);
    }
    else if (result.type === 'rss') {
      const items = parseRSS(result.html);
      const key = result.id.replace('_markets', '').replace('_politics', '');
      if (!secondary[key]) secondary[key] = [];
      secondary[key].push(...items.slice(0, 8).map(item => ({
        ...item,
        source: result.name
      })));
      console.log(`  ✓ ${result.name} (${items.length} items)`);
    }
  }

  return { nyt, secondary, internationalLeads };
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

  const { nyt, secondary, internationalLeads } = await scrapeAll();

  const briefing = {
    nyt,
    secondary,
    internationalLeads,
    generated: new Date().toISOString(),
    source: 'github-actions'
  };

  fs.writeFileSync('briefing.json', JSON.stringify(briefing, null, 2));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('');
  console.log('='.repeat(50));
  console.log('RESULTS');
  console.log('='.repeat(50));
  console.log(`NYT Lead: ${nyt.lead?.headline || 'None'}`);
  console.log(`NYT Live: ${nyt.live.length} | Primary: ${nyt.primary.length} | Secondary: ${nyt.secondary.length}`);
  console.log(`RSS sources: ${Object.keys(secondary).length - 1}`);

  // Log international leads for comparison
  const intlSources = ['bbc', 'guardian', 'economist'];
  console.log('\nInternational Leads (UK editions):');
  intlSources.forEach(src => {
    const lead = internationalLeads[src]?.lead;
    console.log(`  ${src.toUpperCase()}: ${lead?.headline?.slice(0, 50) || 'None'}${lead?.headline?.length > 50 ? '...' : ''}`);
  });
  console.log(`Time: ${elapsed}s`);
  console.log('');

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
