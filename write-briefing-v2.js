#!/usr/bin/env node
/**
 * Briefing 2.0 — 3-pass chain (Write → Edit → Revise)
 *
 * Drop-in replacement for write-briefing.js with editorial quality layers.
 * Reads briefing.json, makes 3 sequential API calls, outputs briefing.md + index.html.
 *
 * Pass 1 (Write):  Generate draft from headline data
 * Pass 2 (Edit):   Fact-check, proofread, enforce style rules
 * Pass 3 (Revise): Apply edits, produce final briefing
 *
 * ~3-5x token cost of v1, ~2-3x wall clock time.
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 */

const https = require('https');
const fs = require('fs');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

// ============================================
// CLAUDE API CALL
// ============================================

function callClaude(prompt, maxTokens = 2000) {
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
// CROSS-SOURCE LEAD ANALYSIS
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
  'midterm', 'primary', 'caucus', 'electoral', 'swing state',
  'poll', 'approval rating'
];

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
  const usScore = US_DOMESTIC_KEYWORDS.filter(kw => lower.includes(kw)).length;
  const intlScore = INTERNATIONAL_KEYWORDS.filter(kw => lower.includes(kw)).length;
  return usScore > 0 && usScore >= intlScore;
}

function extractTopicSignature(headline) {
  if (!headline) return [];
  const lower = headline.toLowerCase();
  const topics = [];
  const allKeywords = [...US_DOMESTIC_KEYWORDS, ...INTERNATIONAL_KEYWORDS];
  allKeywords.forEach(kw => {
    if (lower.includes(kw)) topics.push(kw);
  });
  return topics;
}

function findCommonTopics(leads) {
  const topicCounts = {};
  leads.forEach(lead => {
    if (!lead?.headline) return;
    const topics = extractTopicSignature(lead.headline);
    topics.forEach(topic => {
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
    });
  });
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

  if (analysis.nytLead) {
    analysis.nytIsUSCentric = isUSCentric(analysis.nytLead.headline);
  }

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
      if (keySources.includes(src)) {
        keyLeadsList.push(lead);
      }
    }
  });

  analysis.commonTopics = findCommonTopics(keyLeadsList);

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
// BUILD DATA CONTEXT (shared across passes)
// ============================================

function buildDataContext(condensed) {
  // Format international sources as a readable list with source names and URLs
  // This is the key data that enables non-NYT links in the briefing
  let intlSection = '';
  for (const [source, items] of Object.entries(condensed.internationalSources)) {
    intlSection += `\n${source.toUpperCase()}:\n`;
    items.forEach(item => {
      intlSection += `- ${item.title}`;
      if (item.link) intlSection += `\n  URL: ${item.link}`;
      if (item.source) intlSection += ` [${item.source}]`;
      intlSection += '\n';
    });
  }

  return `LEAD STORY:
${JSON.stringify(condensed.lead, null, 2)}

LIVE COVERAGE:
${JSON.stringify(condensed.live, null, 2)}

TOP HEADLINES:
${JSON.stringify(condensed.primary, null, 2)}

STORIES BY REGION (use these for Around the World section):
${JSON.stringify(condensed.byRegion, null, 2)}

INTERNATIONAL SOURCES (MUST USE — these are your primary non-NYT sources for Around the World):
${intlSection}

INTERNATIONAL HOMEPAGE LEADS (what BBC/Guardian/Al Jazeera/Reuters are featuring):
${JSON.stringify(condensed.internationalLeads, null, 2)}`;
}

// ============================================
// PASS 1: WRITE
// ============================================

function buildWritePrompt(leadGuidance, dataContext) {
  return `You are writing a morning news briefing for Adam, an NYT journalist who writes "The World" newsletter (international news).

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
- GOOD bullet: "AstraZeneca's planning to ditch Nasdaq for the NYSE next month - a rare transatlantic switch that says something about where the action is"
- Be specific about geopolitical frameworks - say "NATO" not "transatlantic relations", say "EU" not "Europe" when referring to the institution, name specific alliances and organizations
- NEVER use the word "amid" - it's lazy jargon. Find a better way to connect ideas.
- NEVER use em-dashes or hyphens to join two independent clauses. Write separate sentences instead.
- NEVER use "'s" as a contraction for "is" (e.g., write "Meta is planning" not "Meta's planning"). Possessive "'s" is fine (e.g., "Meta's earnings").

LINKS (CRITICAL):
- Use markdown links: [link text](url)
- Link text must be MAX 3 WORDS
- GOOD: "The [Fed raised rates](url) yesterday"
- BAD: "[Federal Reserve announces rate increase](url)"
- Every bullet must have at least one link

ATTRIBUTION (CRITICAL):
- When linking to a non-NYT source, you MUST attribute it: "according to BBC", "Al Jazeera reports", "per Reuters", "the Guardian notes"
- Vary your attribution language (use "per X" only once in the entire briefing)
- If the link goes to nytimes.com, attribution is optional. If it goes anywhere else, attribution is MANDATORY.

SOURCE DIVERSITY (MANDATORY):
- At least 3 bullets in Around the World MUST link to non-NYT sources (BBC, Guardian, Al Jazeera, SCMP, AFP, France24, Times of Israel, etc.)
- The INTERNATIONAL SOURCES section below has headlines with real URLs from these outlets — USE THEM
- Do NOT default to NYT links when a good international source link is available for the same story
- If the lead story cites a non-NYT source (like Al Jazeera for Iran talks), attribute it explicitly in the text

Here's the data:

${dataContext}

Write the briefing now. Keep it concise but comprehensive.`;
}

// ============================================
// PASS 2: EDIT
// ============================================

function buildEditPrompt(draft, dataContext) {
  return `You are a primary editor reviewing a news briefing draft. Your job is line-level quality control.

Review the draft below against the source data, then produce a numbered list of specific issues found. Check EVERY one of these:

1. FACT-CHECK: Is every claim, number, name, and attribution traceable to the source data below? Flag anything that appears embellished, conflated, or unsupported.

2. STYLE - CONTRACTIONS: Search for any use of "'s" as a contraction for "is" (e.g., "Trump's planning", "Meta's going"). Possessive "'s" is fine (e.g., "Trump's policy", "Meta's earnings"). List every violation with the exact text.

3. STYLE - "AMID": Flag any use of the word "amid".

4. STYLE - EM-DASHES: Flag any em-dash (—) or hyphen (-) used to join two independent clauses.

5. LINKS: Check that (a) every link text is MAX 3 words, and (b) every bullet point has at least one markdown link.

6. TONE: Flag any bullet that reads like a dry headline summary rather than a conversational thought.

7. COVERAGE: Are all 5 regions represented in Around the World? (Latin America, Europe, Asia, Middle East, Africa)

8. SOURCE DIVERSITY (BLOCKING): Extract every markdown link URL from the draft. Count how many link to non-nytimes.com domains. AT LEAST 3 links in the entire briefing must go to non-NYT sources (BBC, Guardian, Al Jazeera, SCMP, AFP, etc.). If the quota is not met, list which international source stories from the data below should replace NYT links. This is a BLOCKING issue — the briefing cannot publish without source diversity.

9. ATTRIBUTION: For every non-NYT link, check that there is explicit source attribution nearby ("according to BBC", "Al Jazeera reports", "per Reuters", "the Guardian notes"). Flag any non-NYT link that is missing attribution text. The reader must know when a link goes to another outlet.

SOURCE DATA:
${dataContext}

DRAFT TO REVIEW:
${draft}

List every issue found, with exact quotes and specific fixes. If no issues found for a category, say "Clean." Be thorough — this is the quality gate before publication.`;
}

// ============================================
// PASS 3: REVISE
// ============================================

function buildRevisePrompt(draft, editFeedback) {
  return `You are revising a news briefing based on editorial feedback. Apply every fix listed below to produce the final, clean briefing.

RULES:
- Apply all fixes from the editorial feedback
- Do not add new content beyond what the fixes require
- Do not remove content unless the feedback specifically says to
- Preserve the overall structure and tone
- Output ONLY the final briefing text — no commentary, no "here is the revised version", just the briefing itself

CURRENT DRAFT:
${draft}

EDITORIAL FEEDBACK:
${editFeedback}

Output the final revised briefing now.`;
}

// ============================================
// HTML GENERATION (same as v1)
// ============================================

function generateHTML(briefingText) {
  return `<!DOCTYPE html>
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
    li::before { content: "\\2022"; position: absolute; left: 0; color: #999; }
    a {
      color: #1a1a1a;
      text-decoration: underline;
      text-decoration-color: #999;
      text-underline-offset: 2px;
    }
    a:hover { text-decoration-color: #333; }
    strong { font-weight: 600; }
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
    if (line.startsWith('<strong>')) return '<p>' + line + '</p>';
    if (line.trim() && !line.startsWith('<')) return '<p>' + line + '</p>';
    return line;
  })
  .join('\n')}
  </div>
</body>
</html>`;
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('='.repeat(50));
  console.log('Briefing 2.0 — 3-Pass Chain');
  console.log(new Date().toISOString());
  console.log('='.repeat(50));
  console.log('');

  console.log('Reading briefing.json...');
  const briefing = JSON.parse(fs.readFileSync('briefing.json', 'utf8'));

  // Cross-source lead analysis
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

  // Condense data for prompts
  const regions = ['Latin America', 'Europe', 'Asia', 'Middle East', 'Africa', 'U.S.', 'Politics', 'Business', 'Technology'];
  const byRegion = {};
  regions.forEach(r => {
    byRegion[r] = briefing.nyt.secondary.filter(h => h.source === r).slice(0, 3);
  });

  // Build international sources from ALL secondary feeds, filtering out
  // Google News redirect URLs (they're unclickable for readers)
  const internationalSources = {};
  const skipKeys = ['timestamp'];
  for (const [source, items] of Object.entries(briefing.secondary)) {
    if (skipKeys.includes(source) || !Array.isArray(items)) continue;
    // Only keep items with real, clickable URLs (not Google News redirects)
    const usable = items
      .filter(item => item.link && !item.link.includes('news.google.com/rss/articles/'))
      .slice(0, 5);
    if (usable.length > 0) {
      internationalSources[source] = usable;
    }
  }

  const intlSourceCount = Object.keys(internationalSources).length;
  const intlItemCount = Object.values(internationalSources).flat().length;
  console.log(`  International sources with usable URLs: ${intlSourceCount} sources, ${intlItemCount} items`);

  const condensed = {
    lead: briefing.nyt.lead,
    live: briefing.nyt.live.slice(0, 3),
    primary: briefing.nyt.primary.slice(0, 8),
    byRegion: byRegion,
    internationalSources: internationalSources,
    internationalLeads: briefing.internationalLeads || {}
  };

  // Build lead guidance
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

  const dataContext = buildDataContext(condensed);
  const totalStart = Date.now();

  try {
    // ---- PASS 1: WRITE ----
    console.log('📝 Pass 1/3: Writing draft...');
    const writeStart = Date.now();
    const draft = await callClaude(buildWritePrompt(leadGuidance, dataContext));
    const writeTime = ((Date.now() - writeStart) / 1000).toFixed(1);
    console.log(`   Done in ${writeTime}s (${draft.length} chars)`);

    // ---- PASS 2: EDIT ----
    console.log('🔍 Pass 2/3: Editing draft...');
    const editStart = Date.now();
    const editFeedback = await callClaude(buildEditPrompt(draft, dataContext), 1500);
    const editTime = ((Date.now() - editStart) / 1000).toFixed(1);
    console.log(`   Done in ${editTime}s`);

    // Log edit findings for visibility
    const issueCount = (editFeedback.match(/\d+\./g) || []).length;
    console.log(`   Found ~${issueCount} items to review`);

    // ---- PASS 3: REVISE ----
    console.log('✏️  Pass 3/3: Revising...');
    const reviseStart = Date.now();
    const finalBriefing = await callClaude(buildRevisePrompt(draft, editFeedback));
    const reviseTime = ((Date.now() - reviseStart) / 1000).toFixed(1);
    console.log(`   Done in ${reviseTime}s`);

    const totalTime = ((Date.now() - totalStart) / 1000).toFixed(1);

    // Save outputs to briefing-v2/ for separate GitHub Pages URL
    fs.mkdirSync('briefing-v2', { recursive: true });
    fs.writeFileSync('briefing-v2/briefing.md', finalBriefing);
    console.log('\nSaved briefing-v2/briefing.md');

    fs.writeFileSync('briefing-v2/index.html', generateHTML(finalBriefing));
    console.log('Saved briefing-v2/index.html');

    console.log(`\n✅ Briefing 2.0 complete in ${totalTime}s (write: ${writeTime}s, edit: ${editTime}s, revise: ${reviseTime}s)`);

  } catch (e) {
    console.error('❌ Failed to write briefing:', e.message);
    process.exit(1);
  }
}

main();
