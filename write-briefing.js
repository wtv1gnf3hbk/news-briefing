#!/usr/bin/env node
/**
 * Calls Claude API to write a conversational briefing from briefing.json
 * Outputs briefing.md (markdown) which index.html will display
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Load universal style rules from shared file (single-sourced from nyt-concierge)
const styleRulesPath = path.join(__dirname, 'style-rules-prompt.txt');
const styleRules = fs.readFileSync(styleRulesPath, 'utf8').trim();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

// ============================================
// CLAUDE API CALL
// ============================================

function callClaudeOnce(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
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

// Retry wrapper — handles transient 529 (Overloaded) errors
// from the Anthropic API. Waits 15s, 30s, 60s between retries.
async function callClaude(prompt) {
  const MAX_RETRIES = 3;
  const BACKOFF = [15000, 30000, 60000];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callClaudeOnce(prompt);
    } catch (err) {
      const isRetryable = err.message.includes('Overloaded') ||
                          err.message.includes('timeout') ||
                          err.message.includes('529');
      if (!isRetryable || attempt === MAX_RETRIES) throw err;

      const wait = BACKOFF[attempt] || 60000;
      console.log(`  ⚠ ${err.message} — retrying in ${wait / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// ============================================
// LINK DIVERSITY CODE GATE
// Ported from russell-briefing/write-briefing.js.
// After the Writer returns a draft, checks if any single domain exceeds
// 30% of all links. If so, does ONE retry with explicit feedback telling
// the Writer which domains to diversify. This is a safety net — the prompt
// rule should prevent most violations, but LLMs are unreliable self-checkers.
// ============================================

function analyzeLinkDiversity(markdown) {
  // Extract all markdown links: [text](url)
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  const domains = {};
  let total = 0;
  let match;

  while ((match = linkRegex.exec(markdown)) !== null) {
    try {
      const hostname = new URL(match[2]).hostname.replace(/^www\./, '');
      domains[hostname] = (domains[hostname] || 0) + 1;
      total++;
    } catch (e) { /* skip malformed URLs */ }
  }

  return { domains, total };
}

async function enforceLinkDiversity(draft, originalPrompt) {
  const { domains, total } = analyzeLinkDiversity(draft);
  const MAX_SHARE = 0.30;

  if (total === 0) return draft; // no links to check

  // Find domains that exceed 30%
  const violations = [];
  for (const [domain, count] of Object.entries(domains)) {
    const share = count / total;
    if (share > MAX_SHARE) {
      violations.push({ domain, count, share: (share * 100).toFixed(0) });
    }
  }

  // Log the distribution either way
  console.log(`\nLink diversity check (${total} links):`);
  const sorted = Object.entries(domains).sort((a, b) => b[1] - a[1]);
  for (const [domain, count] of sorted) {
    const pct = ((count / total) * 100).toFixed(0);
    const flag = (count / total) > MAX_SHARE ? ' ⚠ OVER 30%' : '';
    console.log(`  ${domain}: ${count}/${total} (${pct}%)${flag}`);
  }

  if (violations.length === 0) {
    console.log('  ✓ Diversity check passed');
    return draft;
  }

  // Build targeted retry prompt
  const violationDesc = violations
    .map(v => `${v.domain} has ${v.count}/${total} links (${v.share}%)`)
    .join(', ');
  const otherSources = ['apnews.com', 'reuters.com', 'bbc.com', 'bloomberg.com', 'theguardian.com', 'aljazeera.com']
    .filter(d => !violations.some(v => v.domain.includes(d.replace('.com', ''))))
    .join(', ');

  console.log(`\n  ⚠ Diversity violation: ${violationDesc}`);
  console.log('  Retrying with diversity feedback...');

  // news-briefing uses a single combined prompt (no separate system prompt),
  // so we append diversity feedback directly to the original prompt string.
  const diversityFeedback = `\n\nIMPORTANT CORRECTION: Your previous draft violated the link diversity rule. ${violationDesc}. No single domain should exceed 30% of links. In Around the World, at least 2 bullets must use non-NYT sources. The story data includes wire stories from ${otherSources} — actively use them. Rewrite the briefing now.`;

  try {
    const retryDraft = await callClaude(originalPrompt + diversityFeedback);

    // Check if retry actually improved things
    const retry = analyzeLinkDiversity(retryDraft);
    const stillBad = Object.entries(retry.domains).some(([_, c]) => c / retry.total > MAX_SHARE);

    if (stillBad) {
      console.log('  ⚠ Retry still has diversity issues — using retry anyway (closer to target)');
    } else {
      console.log('  ✓ Retry passed diversity check');
    }

    // Log retry distribution
    for (const [domain, count] of Object.entries(retry.domains).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${domain}: ${count}/${retry.total} (${((count / retry.total) * 100).toFixed(0)}%)`);
    }

    return retryDraft;
  } catch (e) {
    console.warn('  Diversity retry failed — using original draft:', e.message);
    return draft;
  }
}

// ============================================
// CROSS-SOURCE LEAD ANALYSIS
// ============================================

// Keywords that suggest US-centric domestic news
const US_DOMESTIC_KEYWORDS = [
  'congress', 'senate', 'house of representatives', 'capitol hill',
  'white house', 'oval office', 'biden', 'trump', 'republican', 'democrat',
  'gop', 'dnc', 'rnc', 'scotus', 'supreme court', 'fbi', 'doj', 'cia',
  'homeland security', 'ice', 'border patrol', 'immigration',
  'governor', 'mayor', 'state legislature',
  'minneapolis', 'texas', 'florida', 'california', 'new york',
  // US domestic policy
  'medicaid', 'medicare', 'obamacare', 'social security',
  'gun control', 'abortion', 'roe v wade',
  // US politics/elections
  'midterm', 'primary', 'caucus', 'electoral', 'swing state',
  'poll', 'approval rating'
];

// Keywords suggesting international/global news
const INTERNATIONAL_KEYWORDS = [
  'ukraine', 'russia', 'putin', 'kyiv', 'moscow', 'nato',
  'china', 'beijing', 'xi jinping', 'taiwan',
  'middle east', 'israel', 'gaza', 'palestinian', 'hamas', 'hezbollah',
  'iran', 'tehran', 'nuclear',
  'eu', 'european union', 'brussels', 'eurozone',
  'un', 'united nations', 'security council',
  'climate', 'cop', 'paris agreement',
  'africa', 'asia', 'latin america', 'south america',
  'refugee', 'migrant', 'mediterranean',
  'syria', 'assad', 'taliban', 'afghanistan'
];

function isUSCentric(headline) {
  if (!headline) return false;
  const lower = headline.toLowerCase();

  // Check for US domestic keywords
  const usScore = US_DOMESTIC_KEYWORDS.filter(kw => lower.includes(kw)).length;
  const intlScore = INTERNATIONAL_KEYWORDS.filter(kw => lower.includes(kw)).length;

  // US-centric if more US keywords than international, or US keywords with no international
  return usScore > 0 && usScore >= intlScore;
}

function extractTopicSignature(headline) {
  if (!headline) return [];
  const lower = headline.toLowerCase();
  const topics = [];

  // Extract key topic markers
  const allKeywords = [...US_DOMESTIC_KEYWORDS, ...INTERNATIONAL_KEYWORDS];
  allKeywords.forEach(kw => {
    if (lower.includes(kw)) topics.push(kw);
  });

  return topics;
}

function findCommonTopics(leads) {
  // Count topic occurrences across leads
  const topicCounts = {};

  leads.forEach(lead => {
    if (!lead?.headline) return;
    const topics = extractTopicSignature(lead.headline);
    topics.forEach(topic => {
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
    });
  });

  // Find topics that appear in 2+ sources
  return Object.entries(topicCounts)
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([topic, count]) => ({ topic, count }));
}

function analyzeLeadStories(briefing) {
  const analysis = {
    nytLead: briefing.nyt?.lead || null,
    nytIsUSCentric: false,
    internationalLeads: {},
    commonTopics: [],
    suggestedLead: null,
    reasoning: ''
  };

  // Check if NYT lead is US-centric
  if (analysis.nytLead) {
    analysis.nytIsUSCentric = isUSCentric(analysis.nytLead.headline);
  }

  // Gather international leads
  // Key sources for comparison: UK editions (BBC, Guardian, Economist)
  // Additional sources: Al Jazeera, Reuters (still scraped but not primary comparison)
  const keySources = ['bbc', 'guardian', 'economist'];
  const additionalSources = ['aljazeera', 'reuters'];
  const intlSources = [...keySources, ...additionalSources];
  const intlLeadsList = [];
  const keyLeadsList = [];

  intlSources.forEach(src => {
    const lead = briefing.internationalLeads?.[src]?.lead;
    if (lead) {
      analysis.internationalLeads[src] = {
        headline: lead.headline,
        url: lead.url,
        isUSCentric: isUSCentric(lead.headline),
        isKeySource: keySources.includes(src)
      };
      intlLeadsList.push(lead);
      // Track key sources separately for comparison
      if (keySources.includes(src)) {
        keyLeadsList.push(lead);
      }
    }
  });

  // Find common topics among KEY international sources (BBC, Guardian, Economist)
  analysis.commonTopics = findCommonTopics(keyLeadsList);

  // Determine if we should suggest a different lead
  // LOGIC: If NYT lead is US-domestic AND 2+ key international sources are NOT
  // leading with US news, override the lead. We do NOT require the international
  // outlets to agree on a topic — they just need to not be US-centric.
  if (analysis.nytIsUSCentric && keyLeadsList.length >= 2) {
    const nonUSLeads = keyLeadsList.filter(lead => !isUSCentric(lead.headline));

    if (nonUSLeads.length >= 2) {
      // Provide ALL non-US leads and let Claude pick the strongest
      analysis.suggestedLeads = nonUSLeads.map(lead => ({
        headline: lead.headline,
        url: lead.url,
        source: lead.source
      }));

      // Also check for topic consensus (bonus signal, not required)
      const nonUSTopics = findCommonTopics(nonUSLeads);
      if (nonUSTopics.length > 0) {
        analysis.consensusTopic = nonUSTopics[0].topic;
      }

      analysis.reasoning = `NYT leads with US domestic news ("${analysis.nytLead.headline.slice(0, 50)}..."), ` +
        `but ${nonUSLeads.length} of ${keyLeadsList.length} key international sources are NOT leading with US stories. ` +
        `International leads: ${nonUSLeads.map(l => l.source).join(', ')}.` +
        (analysis.consensusTopic ? ` Shared topic: "${analysis.consensusTopic}".` : ' No shared topic — let Claude pick the strongest.');
    }
  }

  return analysis;
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('Reading briefing.json...');
  const briefing = JSON.parse(fs.readFileSync('briefing.json', 'utf8'));

  // Analyze lead stories across sources
  const leadAnalysis = analyzeLeadStories(briefing);
  console.log('\n=== LEAD ANALYSIS ===');
  console.log(`NYT Lead: ${leadAnalysis.nytLead?.headline?.slice(0, 60) || 'None'}...`);
  console.log(`NYT is US-centric: ${leadAnalysis.nytIsUSCentric}`);
  console.log(`International leads found: ${Object.keys(leadAnalysis.internationalLeads).length}`);
  if (leadAnalysis.suggestedLeads && leadAnalysis.suggestedLeads.length > 0) {
    console.log(`\n⚡ LEAD OVERRIDE TRIGGERED:`);
    leadAnalysis.suggestedLeads.forEach(l => {
      console.log(`   ${l.source}: "${l.headline}"`);
    });
    console.log(`   Reason: ${leadAnalysis.reasoning}`);
  }
  console.log('=====================\n');

  // Build a condensed version for the prompt (to save tokens)
  // Extract regional stories explicitly
  const regions = ['Latin America', 'Europe', 'Asia', 'Middle East', 'Africa', 'U.S.', 'Politics', 'Business', 'Technology'];
  const byRegion = {};
  regions.forEach(r => {
    byRegion[r] = briefing.nyt.secondary.filter(h => h.source === r).slice(0, 3);
  });

  // ---- Recency filter ----
  // Tag each RSS story with hoursAgo and drop anything > 24h.
  // Ported from russell-briefing/write-briefing.js where this prevented
  // the exact same stale-story bug (Sudan "hallmarks of genocide" etc.).
  // Stories without a parseable pubDate are kept but sorted to the end.
  const now = new Date();

  function tagRecency(storyList) {
    return (storyList || []).map(s => {
      if (s.pubDate || s.date) {
        const pubDate = new Date(s.pubDate || s.date);
        const hoursAgo = isNaN(pubDate.getTime()) ? null : (now - pubDate) / (1000 * 60 * 60);
        return { ...s, hoursAgo: hoursAgo !== null ? Math.round(hoursAgo * 10) / 10 : null };
      }
      return { ...s, hoursAgo: null };
    });
  }

  function filterRecent(storyList, maxHours = 24) {
    const tagged = tagRecency(storyList);
    const fresh = tagged.filter(s => s.hoursAgo === null || s.hoursAgo <= maxHours);
    const stale = tagged.length - fresh.length;
    if (stale > 0) console.log(`  Filtered out ${stale} stories older than ${maxHours}h`);
    // Sort: newest first (null ages go to end)
    return fresh.sort((a, b) => {
      if (a.hoursAgo === null) return 1;
      if (b.hoursAgo === null) return -1;
      return a.hoursAgo - b.hoursAgo;
    });
  }

  // Apply recency filter to all RSS-sourced stories (wire services).
  // NYT homepage scrapes and international homepage scrapes don't carry pubDate
  // so they pass through unfiltered.
  console.log('Applying recency filter (24h max)...');
  const filteredWire = {
    reuters: filterRecent(briefing.secondary.reuters || [], 24).slice(0, 3),
    ap: filterRecent(briefing.secondary.ap || [], 24).slice(0, 3),
    bbc: filterRecent(briefing.secondary.bbc || [], 24).slice(0, 3),
    bloomberg: filterRecent(briefing.secondary.bloomberg || [], 24).slice(0, 3)
  };

  // Strip stories with unresolved Google News redirect URLs.
  // When Puppeteer fails to launch (common in CI), the URL resolver returns
  // empty and these stories keep their news.google.com/rss/articles/... URLs.
  // Readers can't open those links, and validate-draft.js flags them as errors.
  // Better to drop them from the data so the Writer can't use them.
  function stripGoogleNewsUrls(storyList) {
    const before = storyList.length;
    const clean = storyList.filter(s => {
      const url = s.link || s.url || '';
      return !url.includes('news.google.com/rss/articles/');
    });
    const dropped = before - clean.length;
    if (dropped > 0) console.log(`  Dropped ${dropped} stories with unresolved Google News URLs`);
    return clean;
  }

  // Apply to all wire sources
  for (const [src, stories] of Object.entries(filteredWire)) {
    filteredWire[src] = stripGoogleNewsUrls(stories);
  }

  // Also filter byRegion stories — NYT section pages sometimes carry pubDate
  const filteredByRegion = {};
  regions.forEach(r => {
    filteredByRegion[r] = filterRecent(byRegion[r], 24);
  });

  // ---- Merge wire stories into regional buckets ----
  // The Writer defaults to NYT data for "Around the World" because byRegion is
  // neatly organized by region. Wire stories (AP, Reuters, BBC, Bloomberg) are
  // passed separately and get ignored, causing all-NYT link patterns that fail
  // the link diversity validator (Check 1: min 2 non-NYT in Around the World).
  //
  // Fix: tag wire stories with approximate regions via keyword matching and
  // inject them into filteredByRegion so the Writer has non-NYT options per region.
  const REGION_KEYWORDS = {
    'Latin America': ['brazil', 'mexico', 'colombia', 'venezuela', 'argentina', 'chile', 'peru', 'cuba', 'caribbean', 'latin america', 'south america', 'central america', 'lula', 'milei', 'bogota', 'buenos aires', 'lima', 'santiago', 'panama', 'ecuador', 'bolivia', 'honduras', 'guatemala', 'nicaragua', 'el salvador', 'haiti', 'dominican'],
    'Europe': ['france', 'germany', 'uk', 'britain', 'london', 'paris', 'berlin', 'eu ', 'european union', 'nato', 'ukraine', 'russia', 'moscow', 'kyiv', 'poland', 'spain', 'italy', 'macron', 'scholz', 'starmer', 'brussels', 'rome', 'madrid', 'portugal', 'sweden', 'norway', 'finland', 'denmark', 'netherlands', 'belgium', 'czech', 'romania', 'hungary', 'greece', 'serbia', 'kosovo', 'moldova', 'baltic', 'zelensky', 'putin'],
    'Asia': ['china', 'japan', 'korea', 'india', 'taiwan', 'beijing', 'tokyo', 'delhi', 'modi', 'xi jinping', 'asean', 'south china sea', 'pacific', 'indonesia', 'philippines', 'singapore', 'vietnam', 'thailand', 'myanmar', 'bangladesh', 'pakistan', 'afghanistan', 'sri lanka', 'nepal', 'cambodia', 'laos', 'malaysia', 'australia', 'new zealand', 'hong kong'],
    'Middle East': ['israel', 'gaza', 'iran', 'saudi', 'iraq', 'syria', 'lebanon', 'hamas', 'hezbollah', 'netanyahu', 'tehran', 'middle east', 'yemen', 'houthi', 'west bank', 'palestinian', 'jordan', 'qatar', 'uae', 'dubai', 'bahrain', 'oman', 'kuwait', 'turkey', 'ankara', 'erdogan', 'kurdish'],
    'Africa': ['africa', 'nigeria', 'kenya', 'south africa', 'ethiopia', 'sudan', 'congo', 'sahel', 'morocco', 'egypt', 'cairo', 'african union', 'tunisia', 'algeria', 'libya', 'somalia', 'uganda', 'tanzania', 'mozambique', 'ghana', 'senegal', 'mali', 'niger', 'chad', 'rwanda', 'zimbabwe']
  };

  let wireStoriesInjected = 0;
  for (const [sourceName, stories] of Object.entries(filteredWire)) {
    for (const story of stories) {
      const text = ((story.title || story.headline || '') + ' ' + (story.description || '')).toLowerCase();
      for (const [region, keywords] of Object.entries(REGION_KEYWORDS)) {
        if (keywords.some(kw => text.includes(kw))) {
          if (!filteredByRegion[region]) filteredByRegion[region] = [];
          // Inject with wire flag so the prompt can identify non-NYT options
          filteredByRegion[region].push({
            ...story,
            source: `${story.source || sourceName} (wire)`,
            isWire: true
          });
          wireStoriesInjected++;
          break; // First region match wins — avoid double-counting
        }
      }
      // Stories that don't match any region stay in the flat WIRE SERVICES section
    }
  }
  if (wireStoriesInjected > 0) {
    console.log(`  Injected ${wireStoriesInjected} wire stories into regional buckets`);
  }

  const condensed = {
    lead: briefing.nyt.lead,
    live: briefing.nyt.live.slice(0, 3),
    primary: briefing.nyt.primary.slice(0, 8),
    byRegion: filteredByRegion,
    wire: filteredWire,
    // Add international homepage leads for context
    internationalLeads: briefing.internationalLeads || {}
  };

  // Build lead guidance based on analysis
  let leadGuidance = '';
  if (leadAnalysis.suggestedLeads && leadAnalysis.suggestedLeads.length > 0) {
    // NYT is US-centric, international outlets disagree — override the lead
    const leadsListText = leadAnalysis.suggestedLeads.map(l =>
      `- ${l.source}: "${l.headline}" (${l.url})`
    ).join('\n');

    leadGuidance = `
CRITICAL - LEAD STORY OVERRIDE:
This is an INTERNATIONAL news briefing. The NYT is leading with US domestic politics ("${leadAnalysis.nytLead.headline.slice(0, 60)}..."), but major international outlets are NOT leading with that story.

Here's what they're leading with instead:
${leadsListText}

YOU MUST:
1. LEAD with the strongest international story from the list above (pick the one with the biggest global stakes)
2. US domestic politics should NEVER lead this briefing unless it has direct global consequences (sanctions, treaties, military action, trade wars). Congressional voting restrictions, partisan maneuvering, and domestic policy fights belong later in the briefing, not at the top.
3. Include the NYT's US story later as a secondary item, not the lead.
4. Look for NYT coverage of the international lead story in the regional sections to augment your lead with NYT links.
`;
  } else if (Object.keys(leadAnalysis.internationalLeads).length > 0) {
    leadGuidance = `
CONTEXT - INTERNATIONAL LEAD STORIES:
Here's what other major outlets are leading with (for context):
${Object.entries(leadAnalysis.internationalLeads).map(([src, data]) =>
  `- ${src.toUpperCase()}: "${data.headline}"`
).join('\n')}

The NYT lead aligns with international coverage, so proceed normally.
`;
  }

  const prompt = `You are writing a morning news briefing for Adam, an NYT journalist who writes "The World" newsletter (international news).

Write a conversational briefing based on this headline data. Follow these rules EXACTLY:
${leadGuidance}
FORMAT:
- Start with "Good morning. Here's the state of play:" (no name, just greeting)
- 2-3 paragraphs on the lead/top stories (synthesize, don't just list)
- "**Business/Tech**" section with 3-4 bullet points
- "**Around the World**" section with bullets for: Latin America, Europe, Asia, Middle East, Africa (one story each - ALWAYS include a real story for each region, never say "limited coverage")

STYLE:
- Conversational throughout, like chatting with a well-informed friend
- Warm but not jokey. Use contractions.
- Lead with context/stakes, not just headlines
- Full sentences, not headline fragments
- BULLETS MUST BE CONVERSATIONAL TOO - write them as complete thoughts with context, not just "Headline happened, per Source"
- BAD bullet: "AstraZeneca is switching from Nasdaq to NYSE, per Reuters"
- GOOD bullet: "AstraZeneca is planning to ditch Nasdaq for the NYSE next month, a rare transatlantic switch that says something about where the action is"
${styleRules}

BRIEFING-SPECIFIC RULES:
- Use contractions freely (except 's for is/has per the style rules above).
- Be specific about geopolitical frameworks — say "NATO" not "transatlantic relations", say "EU" not "Europe" when referring to the institution, name specific alliances and organizations.

RECENCY:
- Wire service stories include an "hoursAgo" field showing how old they are.
- For all sections, strongly prefer stories from the last 12 hours.
- Stories older than 18 hours should only appear if they are genuinely major and no fresher coverage exists.
- A 2-hour-old story beats a 20-hour-old story unless the older one is seismic.
- If a story has no hoursAgo field, treat it as current (it came from a homepage scrape, not RSS).

LINKS (CRITICAL):
- Use markdown links: [link text](url)
- Link text must be MAX 3 WORDS
- GOOD: "The [Fed raised rates](url) yesterday"
- BAD: "[Federal Reserve announces rate increase](url)"
- Every bullet must have at least one link

ATTRIBUTION:
- For non-NYT stories, vary your attribution language: "Reuters reports", "according to Bloomberg", "the BBC notes", "per AP" (use "per X" only once in the entire briefing)
- Don't over-attribute - if it's clearly sourced from the link, you don't always need to say where it came from
- ATTRIBUTION-URL BINDING: When you attribute a story, the source name MUST match the domain of the URL you link. If you link apnews.com, write "AP" not "Reuters". Each story in the data has a "source" field — use it.

AROUND THE WORLD LINK DIVERSITY (CRITICAL):
- At least 2 of the 5 regional bullets MUST link to non-NYT sources (AP, Reuters, BBC, Bloomberg, etc.).
- Wire stories are included in the STORIES BY REGION data below — look for items with "(wire)" in the source field. Use them.
- If the data for a region only has NYT links, check WIRE SERVICES for a story from that region to use instead.

Here's the data:

LEAD STORY:
${JSON.stringify(condensed.lead, null, 2)}

LIVE COVERAGE:
${JSON.stringify(condensed.live, null, 2)}

TOP HEADLINES:
${JSON.stringify(condensed.primary, null, 2)}

STORIES BY REGION (for Around the World — includes NYT + wire stories; use at least 2 non-NYT):
${JSON.stringify(condensed.byRegion, null, 2)}

WIRE SERVICES:
${JSON.stringify(condensed.wire, null, 2)}

INTERNATIONAL HOMEPAGE LEADS (what BBC/Guardian/Al Jazeera/Reuters are featuring):
${JSON.stringify(condensed.internationalLeads, null, 2)}

Write the briefing now. Keep it concise but comprehensive.`;

  console.log('Calling Claude API...');
  const startTime = Date.now();

  try {
    let briefingText = await callClaude(prompt);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Claude responded in ${elapsed}s`);

    // Run link diversity code gate — retries once if any domain > 30%
    briefingText = await enforceLinkDiversity(briefingText, prompt);

    // Save markdown
    fs.writeFileSync('briefing.md', briefingText);
    console.log('Saved briefing.md');

    // ISO date for feedback widget
    const isoDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Also save as HTML snippet for easy embedding
    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Morning Briefing</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Georgia, 'Times New Roman', serif;
      line-height: 1.7;
      max-width: 680px;
      margin: 0 auto;
      padding: 32px 16px;
      background: #fafafa;
      color: #1a1a1a;
    }
    .timestamp {
      font-size: 0.85rem;
      color: #666;
      margin-bottom: 24px;
    }
    h1, h2, strong {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    p { margin-bottom: 16px; }
    ul { margin: 12px 0 20px 0; padding-left: 0; list-style: none; }
    li { margin-bottom: 10px; padding-left: 16px; position: relative; }
    li::before { content: "•"; position: absolute; left: 0; color: #999; }
    a {
      color: #1a1a1a;
      text-decoration: underline;
      text-decoration-color: #999;
      text-underline-offset: 2px;
    }
    a:hover { text-decoration-color: #333; }
    strong { font-weight: 600; }
    /* Feedback section */
    .feedback-section { margin-top: 40px; padding-top: 24px; border-top: 1px solid #e0e0e0; text-align: center; }
    .feedback-prompt { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 0.85rem; color: #666; margin-bottom: 12px; }
    .feedback-buttons { display: flex; justify-content: center; gap: 12px; margin-bottom: 12px; }
    .feedback-btn { font-size: 1.4rem; padding: 8px 16px; border: 1px solid #ddd; border-radius: 8px; background: transparent; cursor: pointer; transition: background 0.15s; }
    .feedback-btn:hover { background: #f0f0f0; }
    .feedback-btn.selected { background: #e8e8e8; border-color: #999; }
    .feedback-textarea { display: none; width: 100%; max-width: 480px; margin: 12px auto; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 0.9rem; resize: vertical; }
    .feedback-submit { display: none; margin: 8px auto; padding: 6px 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 0.85rem; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer; }
    .feedback-submit:hover { background: #e8e8e8; }
    .feedback-thanks { display: none; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 0.85rem; color: #666; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="timestamp">Generated ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET · <a href="#" onclick="refreshBriefing(event); return false;">Refresh</a></div>
  <script>
    async function refreshBriefing(e) {
      var link = e.target;
      link.textContent = 'Refreshing...';
      link.style.pointerEvents = 'none';
      try {
        var res = await fetch('https://briefing-refresh.adampasick.workers.dev/refresh');
        var data = await res.json();
        if (data.success) {
          // Build takes ~3-4 min. Show countdown then force-reload.
          var secsLeft = 210;
          link.textContent = 'Building... ~3:30';
          var countdown = setInterval(function() {
            secsLeft--;
            var m = Math.floor(secsLeft / 60);
            var s = secsLeft % 60;
            link.textContent = 'Building... ' + m + ':' + s.toString().padStart(2, '0');
            if (secsLeft <= 0) {
              clearInterval(countdown);
              location.reload();
            }
          }, 1000);
          // Also reload when tab regains focus (user switched away and came back)
          document.addEventListener('visibilitychange', function handler() {
            if (!document.hidden) {
              document.removeEventListener('visibilitychange', handler);
              clearInterval(countdown);
              location.reload();
            }
          });
        } else {
          link.textContent = 'Error - try again';
          link.style.pointerEvents = 'auto';
        }
      } catch (e) {
        link.textContent = 'Error - try again';
        link.style.pointerEvents = 'auto';
      }
    }
  </script>

  <div id="content">
${briefingText
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
  .replace(/^- (.+)$/gm, '<li>$1</li>')
  .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
  .replace(/\n\n/g, '</p><p>')
  .replace(/^(.+)$/gm, (match) => {
    if (match.startsWith('<')) return match;
    return match;
  })
  .split('\n')
  .map(line => {
    if (line.startsWith('<ul>') || line.startsWith('<li>') || line.startsWith('</ul>')) return line;
    if (line.startsWith('<strong>')) return `<p>${line}</p>`;
    if (line.trim() && !line.startsWith('<')) return `<p>${line}</p>`;
    return line;
  })
  .join('\n')}
  </div>

  <div class="feedback-section" id="feedback-section" data-date="${isoDate}">
    <div class="feedback-prompt">How was today's briefing?</div>
    <div class="feedback-buttons" id="feedback-buttons">
      <button class="feedback-btn" data-reaction="thumbsup" onclick="selectReaction(this)">&#x1F44D;</button>
      <button class="feedback-btn" data-reaction="thumbsdown" onclick="selectReaction(this)">&#x1F44E;</button>
    </div>
    <textarea class="feedback-textarea" id="feedback-comment" placeholder="Optional: tell us more..." rows="3"></textarea>
    <button class="feedback-submit" id="feedback-submit" onclick="submitFeedback()">Send</button>
    <div class="feedback-thanks" id="feedback-thanks">Thanks for the feedback!</div>
  </div>

  <script>
    var FEEDBACK_URL = 'https://briefing-refresh.adampasick.workers.dev/feedback';
    var selectedReaction = null;

    (function() {
      var dateKey = document.getElementById('feedback-section').dataset.date;
      if (localStorage.getItem('feedback-sent-' + dateKey)) {
        document.getElementById('feedback-buttons').style.display = 'none';
        document.querySelector('.feedback-prompt').style.display = 'none';
        document.getElementById('feedback-thanks').style.display = 'block';
        document.getElementById('feedback-thanks').textContent = 'Feedback sent \\u2014 thank you!';
      }
    })();

    function selectReaction(btn) {
      document.querySelectorAll('.feedback-btn').forEach(function(b) { b.classList.remove('selected'); });
      btn.classList.add('selected');
      selectedReaction = btn.dataset.reaction;
      document.getElementById('feedback-comment').style.display = 'block';
      document.getElementById('feedback-submit').style.display = 'block';
    }

    async function submitFeedback() {
      if (!selectedReaction) return;
      var comment = document.getElementById('feedback-comment').value.trim();
      var dateKey = document.getElementById('feedback-section').dataset.date;
      var submitBtn = document.getElementById('feedback-submit');
      submitBtn.textContent = 'Sending...';
      submitBtn.disabled = true;
      try {
        var res = await fetch(FEEDBACK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reaction: selectedReaction, comment: comment || '', briefingDate: dateKey })
        });
        if (!res.ok) throw new Error('Server error');
        document.getElementById('feedback-buttons').style.display = 'none';
        document.getElementById('feedback-comment').style.display = 'none';
        document.getElementById('feedback-submit').style.display = 'none';
        document.querySelector('.feedback-prompt').style.display = 'none';
        document.getElementById('feedback-thanks').style.display = 'block';
        localStorage.setItem('feedback-sent-' + dateKey, '1');
      } catch (e) {
        submitBtn.textContent = 'Error \\u2014 try again';
        submitBtn.disabled = false;
      }
    }
  </script>
</body>
</html>`;

    fs.writeFileSync('index.html', htmlContent);
    console.log('Saved index.html');

    console.log('✅ Briefing written successfully');

  } catch (e) {
    console.error('❌ Failed to write briefing:', e.message);
    process.exit(1);
  }
}

main();
