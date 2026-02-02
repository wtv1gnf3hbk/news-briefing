#!/usr/bin/env node
/**
 * Intelligence Briefing Generator
 *
 * Produces a PDB-style intelligence briefing, not a news summary.
 * The difference: "here's what matters, why, what it connects to, and what to watch for"
 *
 * Usage: node write-intelligence-briefing.js [--config path/to/config.json]
 * Output: intelligence-briefing.md, intelligence-briefing.html
 */

const https = require('https');
const fs = require('fs');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

// ============================================
// DEFAULT USER PROFILE
// Can be overridden with --config flag
// ============================================

const DEFAULT_PROFILE = {
  name: null,  // Optional - for personalized greeting
  role: 'senior professional',  // Shapes what "matters" means

  // Topics of interest - weighted by priority
  priorities: {
    geopolitics: 'high',      // Great power competition, alliances, conflicts
    markets: 'medium',        // Financial markets, central banks, macro
    tech: 'medium',           // AI, semiconductors, platforms
    energy: 'medium',         // Oil, gas, renewables, transition
    trade: 'high',            // Supply chains, tariffs, agreements
  },

  // Regions to emphasize
  regions: {
    'Asia': 'high',
    'Europe': 'high',
    'Middle East': 'medium',
    'Latin America': 'medium',
    'Africa': 'low',
  },

  // What are you tracking? Ongoing situations to connect to
  activeThreads: [
    // Example: "Fed rate decision cycle"
    // Example: "Taiwan Strait tensions"
    // Example: "Ukraine counteroffensive"
  ],

  // Briefing preferences
  format: {
    length: 'standard',  // 'brief' (2 min), 'standard' (5-7 min), 'deep' (15 min)
    includeWatchFor: true,
    includeAroundWorld: true,
  }
};

// ============================================
// LOAD USER PROFILE
// ============================================

function loadProfile() {
  const configArg = process.argv.find(arg => arg.startsWith('--config='));
  if (configArg) {
    const configPath = configArg.split('=')[1];
    try {
      const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return { ...DEFAULT_PROFILE, ...userConfig };
    } catch (e) {
      console.warn(`Could not load config from ${configPath}, using defaults`);
    }
  }
  return DEFAULT_PROFILE;
}

// ============================================
// CLAUDE API
// ============================================

function callClaude(prompt, maxTokens = 3000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(json.error.message));
          } else {
            resolve(json.content[0].text);
          }
        } catch (e) {
          reject(new Error('Failed to parse API response: ' + data.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error('API timeout'));
    });

    req.write(body);
    req.end();
  });
}

// ============================================
// CROSS-SOURCE ANALYSIS
// (Imported logic from write-briefing.js)
// ============================================

const US_DOMESTIC_KEYWORDS = [
  'congress', 'senate', 'house of representatives', 'capitol hill',
  'white house', 'oval office', 'biden', 'trump', 'republican', 'democrat',
  'gop', 'dnc', 'rnc', 'scotus', 'supreme court', 'fbi', 'doj', 'cia',
  'homeland security', 'ice', 'border patrol', 'immigration',
  'governor', 'mayor', 'state legislature',
  'minneapolis', 'texas', 'florida', 'california', 'new york',
  'medicaid', 'medicare', 'obamacare', 'social security',
  'gun control', 'abortion', 'roe v wade',
  'midterm', 'primary', 'caucus', 'electoral', 'swing state'
];

const INTERNATIONAL_KEYWORDS = [
  'ukraine', 'russia', 'putin', 'kyiv', 'moscow', 'nato',
  'china', 'beijing', 'xi jinping', 'taiwan',
  'middle east', 'israel', 'gaza', 'palestinian', 'hamas', 'hezbollah',
  'iran', 'tehran', 'nuclear',
  'eu', 'european union', 'brussels', 'eurozone', 'ecb',
  'un', 'united nations', 'security council',
  'climate', 'cop', 'paris agreement',
  'africa', 'asia', 'latin america', 'south america'
];

function isUSCentric(headline) {
  if (!headline) return false;
  const lower = headline.toLowerCase();
  const usScore = US_DOMESTIC_KEYWORDS.filter(kw => lower.includes(kw)).length;
  const intlScore = INTERNATIONAL_KEYWORDS.filter(kw => lower.includes(kw)).length;
  return usScore > 0 && usScore >= intlScore;
}

function analyzeSourceAgreement(briefing) {
  const analysis = {
    nytLead: briefing.nyt?.lead,
    leads: {},
    agreement: 'unknown',
    conflictNote: null
  };

  // Collect all leads
  const sources = ['bbc', 'guardian', 'economist', 'reuters', 'aljazeera'];
  sources.forEach(src => {
    const lead = briefing.internationalLeads?.[src]?.lead;
    if (lead) {
      analysis.leads[src] = {
        headline: lead.headline,
        url: lead.url
      };
    }
  });

  // Check for topic agreement/disagreement
  const nytTopics = extractTopics(analysis.nytLead?.headline);
  const otherTopics = Object.values(analysis.leads).map(l => extractTopics(l.headline));

  // Simple agreement check: do most sources share a topic?
  const topicCounts = {};
  otherTopics.flat().forEach(t => {
    topicCounts[t] = (topicCounts[t] || 0) + 1;
  });

  const dominantTopic = Object.entries(topicCounts)
    .sort((a, b) => b[1] - a[1])[0];

  if (dominantTopic && dominantTopic[1] >= 2) {
    if (nytTopics.includes(dominantTopic[0])) {
      analysis.agreement = 'aligned';
    } else {
      analysis.agreement = 'divergent';
      analysis.conflictNote = `NYT leads with "${analysis.nytLead?.headline?.slice(0, 50)}..." while ${dominantTopic[1]} international sources lead with ${dominantTopic[0]}-related stories`;
    }
  }

  return analysis;
}

function extractTopics(headline) {
  if (!headline) return [];
  const lower = headline.toLowerCase();
  return [...US_DOMESTIC_KEYWORDS, ...INTERNATIONAL_KEYWORDS]
    .filter(kw => lower.includes(kw));
}

// ============================================
// BUILD INTELLIGENCE PROMPT
// ============================================

function buildPrompt(briefing, profile) {
  const sourceAnalysis = analyzeSourceAgreement(briefing);

  // Build context about what sources agree/disagree on
  let sourceContext = '';
  if (sourceAnalysis.agreement === 'divergent') {
    sourceContext = `
SOURCE DISAGREEMENT NOTE:
${sourceAnalysis.conflictNote}
When sources disagree on what's most important, this is itself valuable intelligence. Acknowledge the divergence and help the reader understand why different outlets prioritize differently.
`;
  }

  // Build priority context from profile
  const highPriorities = Object.entries(profile.priorities)
    .filter(([_, level]) => level === 'high')
    .map(([topic]) => topic);

  const priorityContext = highPriorities.length > 0
    ? `The reader particularly cares about: ${highPriorities.join(', ')}. Weight these topics accordingly.`
    : '';

  // Build active threads context
  const threadsContext = profile.activeThreads?.length > 0
    ? `The reader is actively tracking these ongoing situations: ${profile.activeThreads.join('; ')}. Connect today's news to these threads when relevant.`
    : '';

  // Condense briefing data
  const regions = ['Latin America', 'Europe', 'Asia', 'Middle East', 'Africa', 'U.S.', 'Politics', 'Business', 'Technology'];
  const byRegion = {};
  regions.forEach(r => {
    byRegion[r] = briefing.nyt.secondary.filter(h => h.source === r).slice(0, 3);
  });

  const condensed = {
    lead: briefing.nyt.lead,
    live: briefing.nyt.live.slice(0, 3),
    primary: briefing.nyt.primary.slice(0, 10),
    byRegion: byRegion,
    wire: {
      reuters: briefing.secondary.reuters?.slice(0, 4) || [],
      ap: briefing.secondary.ap?.slice(0, 4) || [],
      bbc: briefing.secondary.bbc?.slice(0, 4) || [],
      bloomberg: briefing.secondary.bloomberg?.slice(0, 4) || [],
      wsj: briefing.secondary.wsj?.slice(0, 4) || [],
    },
    internationalLeads: briefing.internationalLeads || {}
  };

  // Determine length instructions
  let lengthInstructions = '';
  switch (profile.format?.length) {
    case 'brief':
      lengthInstructions = 'Keep this BRIEF - under 500 words total. Executive summary only. No Around the World section.';
      break;
    case 'deep':
      lengthInstructions = 'This is a DEEP DIVE briefing. Be comprehensive. Include more analysis, more connections, more context. 1500+ words is appropriate.';
      break;
    default:
      lengthInstructions = 'Standard length: 700-1000 words. Comprehensive but not exhaustive.';
  }

  return `You are writing a short, sharp intelligence briefing. Not a news summary. Not an essay.

Your reader is busy. They want to know: what matters, why, and what's next. That's it.

${sourceContext}
${priorityContext}
${threadsContext}

## FORMAT

**OPENER** (1-2 sentences max)
"Good morning." + the single most important thing happening right now. One sentence.

**THE LEAD** (1 short paragraph)
The main story. What happened, why it matters, done. No throat-clearing. No "this comes as" or "this raises questions about." Just the point.

**WHAT ELSE** (3-4 bullets, one line each)
Other stories worth knowing. Format: **Bold headline**: one sentence explaining why it matters. That's it.

**WATCH THIS WEEK** (2-3 bullets, one line each)
What's coming. Same format.

## RULES

**Get the facts right.** CRITICAL: Only state facts that are in the source data. Use the exact phrasing from headlines. If the headline says "president-elect," write "while Trump was president-elect" - do not change it to "after taking office" or "timing unclear." If you don't know something, don't mention it at all. Never say "unclear" or "unknown" - just omit what you don't know and state what you do know.

**No repeats.** Each story appears once. If something is in THE LEAD, it is not in WHAT ELSE. If it is in WHAT ELSE, it is not in WATCH THIS WEEK.

**Be short.** If a sentence doesn't add new information, cut it. Target 400 words total.

**Be plain.** Write like you talk. No "geopolitical implications" or "strategic interests" or "raises questions about." Just say what you mean.

**Be direct.** Don't hedge. "This is bad for X" not "This could potentially have negative implications for X."

**Have a point of view.** Don't just report. Say what it means. But your opinion must be grounded in facts from the data, not invented context.

**One idea per sentence.** Short sentences. No semicolons. No em-dashes joining clauses.

## BANNED PHRASES
- "This comes as..."
- "...raises questions about..."
- "...amid..."
- "...signals..."
- "...in the wake of..."
- "...remains to be seen..."
- "...could potentially..."
- "...strategic interests..."
- "...geopolitical implications..."

## LINKS
- Markdown: [2-3 words](url)
- Every bullet needs one link
- Never use "'s" as contraction for "is"

## SOURCE ATTRIBUTION

- Vary language: "Reuters reports", "according to Bloomberg", "the FT notes"
- Use "per X" only once in the entire briefing
- Do not over-attribute when the link makes it clear
- When sources conflict, name both: "Reuters says X, but the WSJ reports Y"

---

HERE IS TODAY'S DATA:

LEAD STORY:
${JSON.stringify(condensed.lead, null, 2)}

LIVE COVERAGE:
${JSON.stringify(condensed.live, null, 2)}

TOP HEADLINES:
${JSON.stringify(condensed.primary, null, 2)}

STORIES BY REGION:
${JSON.stringify(condensed.byRegion, null, 2)}

WIRE SERVICES:
${JSON.stringify(condensed.wire, null, 2)}

INTERNATIONAL HOMEPAGE LEADS (what BBC/Guardian/Economist/Reuters/Al Jazeera are featuring):
${JSON.stringify(condensed.internationalLeads, null, 2)}

---

Write the intelligence briefing now.`;
}

// ============================================
// HTML TEMPLATE
// ============================================

function generateHTML(briefingText, profile) {
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });
  const timeStr = new Date().toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Intelligence Briefing | ${dateStr}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Georgia, 'Times New Roman', serif;
      line-height: 1.7;
      max-width: 720px;
      margin: 0 auto;
      padding: 32px 20px;
      background: #fafafa;
      color: #1a1a1a;
    }
    .header {
      border-bottom: 2px solid #1a1a1a;
      padding-bottom: 16px;
      margin-bottom: 24px;
    }
    .header h1 {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #666;
      margin-bottom: 4px;
    }
    .timestamp {
      font-size: 0.85rem;
      color: #666;
    }
    p { margin-bottom: 16px; }
    ul { margin: 12px 0 20px 0; padding-left: 0; list-style: none; }
    li { margin-bottom: 12px; padding-left: 20px; position: relative; }
    li::before { content: "→"; position: absolute; left: 0; color: #999; }
    a {
      color: #1a1a1a;
      text-decoration: underline;
      text-decoration-color: #999;
      text-underline-offset: 2px;
    }
    a:hover { text-decoration-color: #333; }
    strong {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-weight: 600;
    }
    .section-header {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 0.85rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #666;
      margin-top: 28px;
      margin-bottom: 12px;
      padding-bottom: 4px;
      border-bottom: 1px solid #ddd;
    }
    .confidence-high { color: #1a1a1a; }
    .confidence-medium { color: #666; }
    .confidence-low { color: #999; font-style: italic; }

    /* Audio Player */
    .audio-player {
      margin-bottom: 24px;
      padding: 16px;
      background: #f0f0f0;
      border-radius: 8px;
    }
    .audio-controls {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .play-btn {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: none;
      background: #1a1a1a;
      color: white;
      cursor: pointer;
      font-size: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .audio-info {
      flex: 1;
    }
    .audio-title {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-weight: 600;
      font-size: 0.9rem;
    }
    .audio-duration {
      font-size: 0.8rem;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Intelligence Briefing</h1>
    <div class="timestamp">${dateStr} · ${timeStr} ET</div>
  </div>

  <div class="audio-player" id="audio-player">
    <div class="audio-controls">
      <button class="play-btn" id="play-btn" onclick="toggleAudio()">&#9658;</button>
      <div class="audio-info">
        <div class="audio-title">Listen to briefing</div>
        <div class="audio-duration" id="audio-duration">Loading...</div>
      </div>
    </div>
    <audio id="briefing-audio" src="intelligence-podcast.mp3" preload="metadata"></audio>
  </div>
  <script>
    const audio = document.getElementById('briefing-audio');
    const playBtn = document.getElementById('play-btn');
    const durationEl = document.getElementById('audio-duration');

    audio.addEventListener('loadedmetadata', () => {
      const mins = Math.floor(audio.duration / 60);
      const secs = Math.round(audio.duration % 60);
      durationEl.textContent = mins + ':' + secs.toString().padStart(2, '0');
    });
    audio.addEventListener('error', () => {
      document.getElementById('audio-player').style.display = 'none';
    });
    audio.addEventListener('ended', () => {
      playBtn.innerHTML = '&#9658;';
    });

    function toggleAudio() {
      if (audio.paused) {
        audio.play();
        playBtn.innerHTML = '&#10074;&#10074;';
      } else {
        audio.pause();
        playBtn.innerHTML = '&#9658;';
      }
    }
  </script>

  <div id="content">
${formatBriefingHTML(briefingText)}
  </div>
</body>
</html>`;
}

function formatBriefingHTML(text) {
  return text
    // Convert **Section Headers** to styled divs
    .replace(/\*\*([A-Z][A-Z\s]+)\*\*/g, '<div class="section-header">$1</div>')
    // Convert remaining **bold** to <strong>
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Convert markdown links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    // Convert bullets
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    // Wrap consecutive <li> in <ul>
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    // Convert paragraphs
    .split('\n\n')
    .map(para => {
      para = para.trim();
      if (!para) return '';
      if (para.startsWith('<ul>') || para.startsWith('<div')) return para;
      return `<p>${para}</p>`;
    })
    .join('\n');
}

// ============================================
// FACT CHECKING
// ============================================

function buildFactCheckPrompt(briefingText, sourceData) {
  return `You are a fact-checker for an intelligence briefing. Your job is to catch FACTUAL ERRORS, not to remove analysis.

## BRIEFING TO CHECK:
${briefingText}

## SOURCE HEADLINES:
${JSON.stringify(sourceData, null, 2)}

## WHAT COUNTS AS AN ERROR:

ERRORS (flag these):
- Changing facts: headline says "president-elect" but briefing says "after taking office"
- Inventing specifics: headline says "took stake" but briefing says "bought 40% stake"
- Wrong timing: headline implies one date, briefing states another
- Banned phrases: "raises questions about", "this comes as", "amid", "in the wake of", "remains to be seen", "could potentially", "strategic interests", "geopolitical implications"

NOT ERRORS (allow these):
- Analysis: "This matters because..." or "This is significant for..."
- Connecting dots: "This fits a pattern of..."
- Interpretation: "This suggests..." or "This is bad for..."
- Context the reader would know: "Trump is president" (if we're in his term)
- General knowledge: "The UAE has interests in Iran policy"

## KEY DISTINCTION:
The briefing SHOULD have analysis and point of view. Only flag claims that CONTRADICT the source data, not claims that INTERPRET it.

## RESPOND WITH:
If no factual errors, respond: PASS

If errors found:
FAIL
- [quote] → [what's wrong and why]

Only list genuine factual errors, not stylistic concerns.`;
}

async function factCheck(briefingText, briefing, maxAttempts = 3) {
  // Include ALL source data so fact-checker can verify everything
  const sourceData = {
    lead: briefing.nyt.lead,
    primary: briefing.nyt.primary.slice(0, 15),
    secondary: briefing.nyt.secondary?.slice(0, 20) || [],
    wire: {
      reuters: briefing.secondary?.reuters?.slice(0, 5) || [],
      bbc: briefing.secondary?.bbc?.slice(0, 5) || [],
      bloomberg: briefing.secondary?.bloomberg?.slice(0, 5) || [],
      ap: briefing.secondary?.ap?.slice(0, 5) || [],
    },
    internationalLeads: Object.fromEntries(
      Object.entries(briefing.internationalLeads || {}).map(([k, v]) => [k, { lead: v.lead, top: v.top?.slice(0, 3) }])
    )
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`  Fact check ${attempt}/${maxAttempts}...`);

    const checkPrompt = buildFactCheckPrompt(briefingText, sourceData);
    const result = await callClaude(checkPrompt, 1000);

    if (result.trim().startsWith('PASS')) {
      console.log(`  ✓ Passed`);
      return { passed: true, text: briefingText };
    }

    console.log(`  ✗ Issues found:`);
    const issues = result.split('\n').filter(l => l.startsWith('-'));
    issues.forEach(issue => console.log(`    ${issue}`));

    if (attempt < maxAttempts) {
      console.log(`  Regenerating...`);
      // Include the errors in a new prompt to fix them
      const fixPrompt = `The previous briefing had factual errors. Fix ONLY the specific errors listed below. Keep the sharp, analytical tone.

ERRORS TO FIX:
${result}

PREVIOUS BRIEFING:
${briefingText}

SOURCE DATA:
${JSON.stringify(sourceData, null, 2)}

INSTRUCTIONS:
- Fix the specific factual errors listed above
- Keep all the analysis and point of view - that's good
- Keep the format: OPENER, THE LEAD, WHAT ELSE, WATCH THIS WEEK
- Stay short and punchy
- Do NOT become bland or generic - keep the intelligence briefing tone

Write the corrected briefing:`;

      briefingText = await callClaude(fixPrompt, 2000);
    }
  }

  console.log(`  ⚠ Could not pass after ${maxAttempts} attempts, using last version`);
  return { passed: false, text: briefingText };
}

// ============================================
// STYLE CHECK
// ============================================

async function styleCheck(briefingText) {
  const checkPrompt = `Check this briefing for style issues. Be brief.

BRIEFING:
${briefingText}

CHECK FOR:
1. Any use of "'s" as contraction for "is" (e.g., "Trump's planning" instead of "Trump is planning")
2. Em-dashes joining independent clauses
3. Sentences over 25 words
4. Any banned phrases that slipped through

RESPOND WITH:
If clean, respond: PASS
If issues, respond: FAIL followed by bullet list of issues`;

  const result = await callClaude(checkPrompt, 500);
  return result.trim().startsWith('PASS');
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║     INTELLIGENCE BRIEFING GENERATOR    ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');

  // Load profile
  const profile = loadProfile();
  console.log(`Profile: ${profile.role}`);
  if (profile.name) console.log(`User: ${profile.name}`);
  console.log(`Format: ${profile.format?.length || 'standard'}`);
  console.log('');

  // Load briefing data
  console.log('Loading briefing.json...');
  let briefing;
  try {
    briefing = JSON.parse(fs.readFileSync('briefing.json', 'utf8'));
  } catch (e) {
    console.error('Could not read briefing.json. Run generate-briefing.js first.');
    process.exit(1);
  }

  // Analyze sources
  const sourceAnalysis = analyzeSourceAgreement(briefing);
  console.log(`NYT Lead: ${sourceAnalysis.nytLead?.headline?.slice(0, 50) || 'None'}...`);
  console.log(`Source agreement: ${sourceAnalysis.agreement}`);
  if (sourceAnalysis.conflictNote) {
    console.log(`Note: ${sourceAnalysis.conflictNote}`);
  }
  console.log('');

  // Build prompt and call Claude
  const prompt = buildPrompt(briefing, profile);

  console.log('Generating intelligence briefing...');
  const startTime = Date.now();

  try {
    let briefingText = await callClaude(prompt);
    console.log('Draft generated');
    console.log('');

    // Fact checking layer
    console.log('Running fact checks...');
    const factResult = await factCheck(briefingText, briefing);
    briefingText = factResult.text;
    console.log('');

    // Style check
    console.log('Running style check...');
    const styleOk = await styleCheck(briefingText);
    console.log(styleOk ? '  ✓ Style OK' : '  ⚠ Style issues (proceeding anyway)');
    console.log('');

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Total time: ${elapsed}s`);

    // Save outputs
    fs.writeFileSync('intelligence-briefing.md', briefingText);
    console.log('Saved: intelligence-briefing.md');

    const html = generateHTML(briefingText, profile);
    fs.writeFileSync('intelligence-briefing.html', html);
    console.log('Saved: intelligence-briefing.html');

    console.log('');
    console.log(factResult.passed ? '✅ Intelligence briefing ready' : '⚠️ Briefing ready (with warnings)');

  } catch (e) {
    console.error('❌ Failed:', e.message);
    process.exit(1);
  }
}

main();
