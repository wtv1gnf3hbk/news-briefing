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
const puppeteer = require('puppeteer');

// Economist credentials (from environment or fallback)
const ECONOMIST_EMAIL = process.env.ECONOMIST_EMAIL || 'ldnnewsroomsubs@nytimes.com';
const ECONOMIST_PASSWORD = process.env.ECONOMIST_PASSWORD || 'NYTNews2025';

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

  // Helper to add a story if valid
  const addStory = (headline, url) => {
    if (!url || !headline) return false;
    if (url.startsWith('/')) url = 'https://www.theguardian.com' + url;
    if (!url.includes('theguardian.com')) return false;
    if (url.includes('/live/') || url.includes('/video/') || url.includes('/gallery/')) return false;

    headline = headline.trim().replace(/\s+/g, ' ');
    if (headline.length < 10 || headline.length > 200) return false;
    if (seen.has(url)) return false;
    seen.add(url);

    stories.push({ headline, url, source: 'Guardian' });
    return true;
  };

  // Strategy 1: Look for data-link-name="article" which Guardian uses for story links
  $('a[data-link-name="article"]').each((i, el) => {
    if (stories.length >= 10) return;
    const $el = $(el);
    const url = $el.attr('href');
    // Get headline from nested span or the link text itself
    let headline = $el.find('.fc-item__title, .js-headline-text, [data-testid="headline"]').text()
                   || $el.text();
    addStory(headline, url);
  });

  // Strategy 2: Look for fc-item containers (Guardian's "fronts container" pattern)
  if (stories.length < 3) {
    $('.fc-item__title a, .fc-item__link').each((i, el) => {
      if (stories.length >= 10) return;
      const $el = $(el);
      const url = $el.attr('href');
      const headline = $el.text();
      addStory(headline, url);
    });
  }

  // Strategy 3: Look for dcr (dotcom-rendering) headline patterns
  if (stories.length < 3) {
    $('[data-testid="headline"] a, [data-component="headline"] a').each((i, el) => {
      if (stories.length >= 10) return;
      const $el = $(el);
      const url = $el.attr('href');
      const headline = $el.text();
      addStory(headline, url);
    });
  }

  // Strategy 4: Fallback to h2/h3 links but be more selective
  if (stories.length < 3) {
    $('h2 a, h3 a').each((i, el) => {
      if (stories.length >= 10) return;
      const $el = $(el);
      const url = $el.attr('href');
      const headline = $el.text();
      addStory(headline, url);
    });
  }

  // Strategy 5: Look for any link with article-like URL pattern
  if (stories.length < 3) {
    $('a[href*="/2026/"], a[href*="/2025/"]').each((i, el) => {
      if (stories.length >= 10) return;
      const $el = $(el);
      const url = $el.attr('href');
      // Only if the link has substantial text (likely a headline)
      const headline = $el.text();
      if (headline.length >= 20) {
        addStory(headline, url);
      }
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

  // Helper to add a story
  const addStory = (text, url) => {
    if (!text) return false;
    text = text.trim().replace(/\s+/g, ' ');
    if (text.length < 20 || text.length > 400) return false;

    // Dedupe by first 50 chars
    const key = text.slice(0, 50).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);

    if (!url) url = 'https://www.economist.com/the-world-in-brief';
    else if (url.startsWith('/')) url = 'https://www.economist.com' + url;

    const headline = text.slice(0, 200);
    stories.push({ headline, url, source: 'Economist' });
    return true;
  };

  // Strategy 1: Look for "gobbets" - Economist's term for brief news items
  // They use article or div containers with specific classes
  $('[data-testid*="gobbet"], .css-gobbet, [class*="gobbet"], [class*="Gobbet"]').each((i, el) => {
    if (stories.length >= 10) return;
    const $el = $(el);
    const text = $el.text();
    const url = $el.find('a').first().attr('href');
    addStory(text, url);
  });

  // Strategy 2: Look for article elements within the world-in-brief content
  if (stories.length < 3) {
    $('article p, [role="article"] p').each((i, el) => {
      if (stories.length >= 10) return;
      const $el = $(el);
      const text = $el.text();
      // World in Brief items typically start with bold/strong country or topic
      if ($el.find('strong, b').length > 0 || text.match(/^[A-Z][a-z]+('s)?\s/)) {
        const url = $el.find('a').first().attr('href');
        addStory(text, url);
      }
    });
  }

  // Strategy 3: Look for paragraphs that start with bold text (classic pattern)
  if (stories.length < 3) {
    $('p').each((i, el) => {
      if (stories.length >= 10) return;
      const $el = $(el);
      const $strong = $el.find('strong, b').first();
      if ($strong.length && $strong.text().length > 3) {
        const text = $el.text();
        const url = $el.find('a').first().attr('href');
        addStory(text, url);
      }
    });
  }

  // Strategy 4: Look for list items with substantial content
  if (stories.length < 3) {
    $('li').each((i, el) => {
      if (stories.length >= 10) return;
      const $el = $(el);
      const text = $el.text();
      // Filter out navigation items - news items are typically longer
      if (text.length >= 50) {
        const url = $el.find('a').first().attr('href');
        addStory(text, url);
      }
    });
  }

  // Strategy 5: Look for div/section with multiple paragraphs (content area)
  if (stories.length < 3) {
    $('main p, [role="main"] p, .article-body p, .content p').each((i, el) => {
      if (stories.length >= 10) return;
      const $el = $(el);
      const text = $el.text();
      // Skip short paragraphs and bylines
      if (text.length >= 60 && !text.match(/^(By |Updated |Published )/i)) {
        const url = $el.find('a').first().attr('href');
        addStory(text, url);
      }
    });
  }

  return { lead: stories[0] || null, top: stories.slice(0, 5) };
}

// Fetch Economist World in Brief with login using headless browser
async function fetchEconomistWithLogin() {
  let browser = null;
  try {
    console.log('  Launching browser for Economist...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Go directly to World in Brief
    console.log('  Navigating to World in Brief...');
    await page.goto('https://www.economist.com/the-world-in-brief', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Check if we need to log in - look for login/subscribe buttons or paywall
    const needsLogin = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('subscribe') || text.includes('log in') || text.includes('sign in') ||
             document.querySelector('[data-testid="login-button"]') ||
             document.querySelector('a[href*="login"]') ||
             document.querySelector('.paywall');
    });

    if (needsLogin) {
      console.log('  Login required, clicking login link...');

      // Try to find and click login link
      const loginClicked = await page.evaluate(() => {
        const selectors = [
          'a[href*="login"]',
          'button:contains("Log in")',
          '[data-testid="login-button"]',
          'a:contains("Log in")',
          '.login-link',
          'nav a[href*="auth"]'
        ];
        for (const sel of selectors) {
          try {
            const el = document.querySelector(sel);
            if (el) { el.click(); return true; }
          } catch(e) {}
        }
        // Try finding by text content
        const links = Array.from(document.querySelectorAll('a, button'));
        for (const link of links) {
          if (link.textContent.toLowerCase().includes('log in') ||
              link.textContent.toLowerCase().includes('sign in')) {
            link.click();
            return true;
          }
        }
        return false;
      });

      if (loginClicked) {
        await new Promise(r => setTimeout(r, 2000));
      }

      // Wait for login form
      console.log('  Waiting for login form...');
      await page.waitForSelector('input[type="email"], input[name="email"], #email, input[type="text"][name*="email"]', { timeout: 10000 }).catch(() => {});

      // Fill email
      const emailFilled = await page.evaluate((email) => {
        const selectors = ['input[type="email"]', 'input[name="email"]', '#email', 'input[autocomplete="email"]', 'input[type="text"]'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && (el.type === 'email' || el.name?.includes('email') || el.placeholder?.toLowerCase().includes('email'))) {
            el.value = email;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          }
        }
        return false;
      }, ECONOMIST_EMAIL);
      console.log('  Email filled:', emailFilled);

      // Fill password
      const pwdFilled = await page.evaluate((pwd) => {
        const el = document.querySelector('input[type="password"]');
        if (el) {
          el.value = pwd;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
        return false;
      }, ECONOMIST_PASSWORD);
      console.log('  Password filled:', pwdFilled);

      // Submit
      if (emailFilled && pwdFilled) {
        console.log('  Submitting login...');
        await page.evaluate(() => {
          const btn = document.querySelector('button[type="submit"], input[type="submit"]');
          if (btn) btn.click();
        });

        // Wait for navigation/login to complete
        await new Promise(r => setTimeout(r, 5000));

        // Navigate back to World in Brief if needed
        const currentUrl = page.url();
        if (!currentUrl.includes('the-world-in-brief')) {
          await page.goto('https://www.economist.com/the-world-in-brief', {
            waitUntil: 'networkidle2',
            timeout: 30000
          });
        }
      }
    }

    // Wait for content to load
    await new Promise(r => setTimeout(r, 2000));

    // Get the page HTML
    const html = await page.content();
    console.log('  Got Economist HTML, length:', html.length);

    await browser.close();
    return html;

  } catch (error) {
    console.log('  Economist fetch failed:', error.message);
    if (browser) await browser.close();
    return null;
  }
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

  // Separate Economist (needs puppeteer) from other sources
  const regularSources = ALL_SOURCES.filter(s => s.type !== 'economist_homepage');

  // Fetch regular sources in parallel
  const results = await Promise.all(
    regularSources.map(async (source) => {
      try {
        const html = await fetch(source.url);
        return { ...source, html, error: null };
      } catch (e) {
        return { ...source, html: null, error: e.message };
      }
    })
  );

  // Fetch Economist separately with login
  const economistSource = ALL_SOURCES.find(s => s.type === 'economist_homepage');
  if (economistSource) {
    try {
      const html = await fetchEconomistWithLogin();
      results.push({ ...economistSource, html, error: html ? null : 'Login failed' });
    } catch (e) {
      results.push({ ...economistSource, html: null, error: e.message });
    }
  }

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
