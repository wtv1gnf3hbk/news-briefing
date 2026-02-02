# News Briefing Project

## Architecture

- `generate-briefing.js` - Scrapes all news sources, outputs `briefing.json`
- `write-briefing.js` - Uses Claude API to write conversational briefing from JSON
- `write-intelligence-briefing.js` - PDB-style intelligence briefing with fact-checking
- `.github/workflows/briefing.yml` - Daily workflow (6am ET) + manual trigger

## Intelligence Briefing System

### Philosophy
This is a "democratized intelligence briefing" - think Presidential Daily Brief, not news summary. The difference: a news summary says "here's what happened." An intelligence briefing says "here's what matters, why it matters, and what to watch for."

### Output Structure
```
OPENER - 1-2 sentences, the single most important thing
THE LEAD - 1 short paragraph, what happened + why it matters
WHAT ELSE - 3-4 bullets, one line each
WATCH THIS WEEK - 2-3 bullets, forward-looking
```

### Fact-Checking Pipeline
The intelligence briefing runs through multiple validation layers:

1. **Draft Generation** - Initial briefing from source data
2. **Fact Check (up to 3 attempts)** - Compares output against source headlines
   - Flags factual errors (changing "president-elect" to "after taking office")
   - Allows analysis/interpretation (that's the point)
   - Catches banned phrases
3. **Style Check** - Verifies no style violations slipped through
4. **Regeneration** - If errors found, regenerates while preserving tone

### User Profiles
Optional personalization via JSON config:
```javascript
{
  "role": "macro investor",
  "priorities": { "markets": "high", "geopolitics": "high" },
  "activeThreads": ["Fed rate cycle", "China property stress"],
  "format": { "length": "standard" }
}
```

Usage: `node write-intelligence-briefing.js --config=profiles/my-profile.json`

### Banned Phrases
These are automatically flagged by fact-checker:
- "This comes as..."
- "...raises questions about..."
- "...amid..."
- "...in the wake of..."
- "...remains to be seen..."
- "...could potentially..."
- "...strategic interests..."
- "...geopolitical implications..."

### Multimodal Output Formats
The intelligence briefing generates multiple output formats:

| File | Format | Length | Use Case |
|------|--------|--------|----------|
| `intelligence-headline.txt` | Plain text | 30s read | Push notification, glanceable |
| `intelligence-briefing.md` | Markdown | 2min read | Standard daily briefing |
| `intelligence-deep.md` | Markdown | 10min read | Deep analysis, weekend read |
| `intelligence-email.txt` | Plain text | 2min read | Email newsletter format |
| `intelligence-slack.txt` | Plain text | 1min read | Slack/Teams message |
| `intelligence-sms.txt` | Plain text | 160 chars | SMS alert |
| `intelligence-briefing.html` | HTML | 2min read | Web embed, styled |
| `intelligence-dashboard.html` | HTML | Visual | Dashboard display, dark mode |
| `intelligence-briefing.mp3` | Audio | 2-3min | TTS via ElevenLabs |

### Audio Generation (TTS)
Requires `ELEVENLABS_API_KEY` environment variable.
- Voice: Rachel (professional, clear)
- Model: eleven_turbo_v2_5
- Output: intelligence-briefing.mp3

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

## Interactive Query Tools

A suite of CLI tools for querying and analyzing the daily briefing data.

### query-briefing.js
Interactive Q&A against today's news data.
```bash
node query-briefing.js                    # Interactive mode
node query-briefing.js "what happened?"   # Single query
```
Query types: catch-up, topic, meeting prep, source comparison.

### explain-headline.js
Get context on a headline or screenshot.
```bash
node explain-headline.js "UAE takes stake in Trump crypto"
```
Returns: story context, why it matters, other coverage, related stories.

### meeting-prep.js
Generate a focused briefing for an upcoming meeting.
```bash
node meeting-prep.js --who "investors" --topic "AI" --time 5
```
Returns: quick context, key facts, their perspective, talking points.

### compare-sources.js
Compare how different outlets cover the same story.
```bash
node compare-sources.js --leads           # Compare lead stories
node compare-sources.js "Ukraine"         # Compare topic coverage
```
Analyzes: consensus, framing differences, US vs international lens.

### watchlist.js
Track specific topics, companies, people across news sources.
```bash
node watchlist.js                         # Run watchlist check
node watchlist.js --add "Tesla"           # Add item
node watchlist.js --list                  # Show watchlist
```
Persists to `watchlist.json`. Generates personalized alerts.

### news-calendar.js
Extract upcoming events from news coverage.
```bash
node news-calendar.js                     # All upcoming events
node news-calendar.js --week              # Next 7 days
```
Extracts: elections, earnings, policy deadlines, summits.

### contrarian-view.js
Alternative perspectives on today's news.
```bash
node contrarian-view.js                   # Challenge today's leads
node contrarian-view.js "tariffs"         # Contrarian on topic
```
Surfaces underrepresented viewpoints without being conspiratorial.

### blind-spots.js
Identify stories you might be missing.
```bash
node blind-spots.js                       # General check
node blind-spots.js --international       # US vs intl gaps
node blind-spots.js --profile=investor    # Based on profile
```
Uses watchlist.json and profiles/ for personalization.

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
