# News Briefing Project

## Architecture

- `generate-briefing.js` - Scrapes all news sources, outputs `briefing.json`
- `write-briefing.js` - Uses Claude API to write conversational briefing from JSON
- `.github/workflows/briefing.yml` - Daily workflow (6am ET) + manual trigger

## International Homepage Scraping

### Sources & URLs
- **BBC UK**: `https://www.bbc.co.uk/news` - Use UK edition for non-US perspective
- **Guardian UK**: `https://www.theguardian.com/uk` - UK edition, NOT .com
- **Economist**: `https://www.economist.com/the-world-in-brief` - Requires login (paywalled)
- **Al Jazeera**: `https://www.aljazeera.com/`
- **Reuters**: `https://www.reuters.com/`

### Scraper Patterns

**Guardian** - Multiple selector strategies needed:
1. `data-link-name="article"` - Guardian's tracking attribute
2. `.fc-item__title a` - fronts container pattern
3. `[data-testid="headline"]` - dcr rendering pattern
4. `h2 a, h3 a` - fallback
5. Date-based URL pattern (`/2026/`, `/2025/`)

**Economist World in Brief** - Requires puppeteer login:
1. Go to page first, detect if login needed
2. Click login link, fill form dynamically
3. Look for "gobbets" (Economist's term for brief news items)
4. Parse paragraphs with bold/strong opening text

**BBC** - Relatively stable selectors:
- `article a` with headline extraction
- `data-testid` patterns

### Puppeteer Login Flow (Economist)
```javascript
// Go to page first
await page.goto('https://www.economist.com/the-world-in-brief');

// Detect if login needed
const needsLogin = await page.evaluate(() => {
  return document.body.innerText.includes('subscribe') ||
         document.querySelector('a[href*="login"]');
});

// Click login, fill form, submit
// Use page.evaluate() to fill forms - more reliable than page.type()
```

### Environment Variables
- `ECONOMIST_EMAIL` / `ECONOMIST_PASSWORD` - GitHub secrets for Economist login
- `ANTHROPIC_API_KEY` - For write-briefing.js

## Cross-Source Lead Analysis

### US-Centric Detection Keywords
```javascript
const US_DOMESTIC_KEYWORDS = [
  'congress', 'senate', 'white house', 'biden', 'trump',
  'republican', 'democrat', 'ice', 'immigration',
  'minneapolis', 'texas', 'florida', 'california'
];
```

### Logic
- Compare NYT lead to BBC/Guardian/Economist leads
- If NYT is US-centric but 2+ UK sources lead with international story
- Suggest alternative lead in briefing

### False Positive Issue
Headlines mentioning "Trump" in international context (e.g., "Iran responds to Trump") get flagged as US-centric. Consider context-aware classification.

## GitHub Actions Notes

- Puppeteer requires `--no-sandbox` flag on ubuntu-latest
- First run slow (~6min) due to Chromium download
- npm cache helps subsequent runs

## Briefing Writing Style

### Contractions Rule
**NEVER use "'s" as a contraction for "is".**

Bad:
- "Meta's planning to spend..."
- "Amazon's cutting 16,000 jobs..."

Good:
- "Meta is planning to spend..."
- "Amazon is cutting 16,000 jobs..."

Note: "'s" for possession is fine (e.g., "Amazon's CEO", "Meta's earnings").
