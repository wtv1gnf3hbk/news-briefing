#!/usr/bin/env node
/**
 * Calls Claude API to write a conversational briefing from briefing.json
 * Outputs briefing.md (markdown) which index.html will display
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

function callClaude(prompt) {
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

// ============================================
// FEEDBACK MEMORY
// ============================================

function getRecentFeedback() {
  try {
    const history = JSON.parse(fs.readFileSync('briefing-history.json', 'utf8'));
    const recent = history
      .filter(e => e.human_feedback || e.auto_scores?.feedback)
      .slice(-7);

    if (recent.length === 0) return '';

    const lines = [];

    // Human feedback takes priority
    const humanEntries = recent.filter(e => e.human_feedback);
    if (humanEntries.length > 0) {
      lines.push('RECENT FEEDBACK FROM ADAM (pay close attention):');
      humanEntries.slice(-5).forEach(e => {
        const f = e.human_feedback;
        lines.push(`- [${e.date}, ${f.score}/5]: ${f.notes || 'no notes'}`);
        if (f.keep) lines.push(`  Keep doing: ${f.keep}`);
        if (f.fix) lines.push(`  Fix: ${f.fix}`);
      });
    }

    // LLM judge feedback as supplement
    const judgeEntries = recent
      .filter(e => e.auto_scores?.feedback && !e.human_feedback)
      .slice(-3);
    if (judgeEntries.length > 0) {
      lines.push('RECENT QUALITY NOTES:');
      judgeEntries.forEach(e => {
        lines.push(`- [${e.date}]: ${e.auto_scores.feedback}`);
      });
    }

    return lines.length > 0 ? '\n' + lines.join('\n') + '\n' : '';
  } catch {
    return '';
  }
}

// ============================================
// QUICK STRUCTURAL SANITY CHECK (for retry logic)
// ============================================

function quickSanityCheck(text) {
  const issues = [];

  if (!text.startsWith("Good morning. Here's the state of play:")) {
    issues.push('Missing greeting');
  }
  if (!text.includes('**Business/Tech**')) {
    issues.push('Missing Business/Tech section');
  }
  if (!text.includes('**Around the World**')) {
    issues.push('Missing Around the World section');
  }
  const regions = ['Latin America', 'Europe', 'Asia', 'Middle East', 'Africa'];
  const missing = regions.filter(r => !text.includes(`**${r}**`));
  if (missing.length > 0) {
    issues.push(`Missing regions: ${missing.join(', ')}`);
  }

  return { pass: issues.length === 0, issues };
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
  // Use KEY sources (UK editions) for the comparison
  if (analysis.nytIsUSCentric && keyLeadsList.length >= 2) {
    // Count how many KEY sources are NOT leading with US news
    const nonUSLeads = keyLeadsList.filter(lead => !isUSCentric(lead.headline));

    if (nonUSLeads.length >= 2) {
      // Find the most common non-US topic
      const nonUSTopics = findCommonTopics(nonUSLeads);

      if (nonUSTopics.length > 0) {
        // Find the lead that best represents the common topic
        const topTopic = nonUSTopics[0].topic;
        const bestLead = nonUSLeads.find(lead =>
          lead.headline.toLowerCase().includes(topTopic)
        ) || nonUSLeads[0];

        analysis.suggestedLead = {
          headline: bestLead.headline,
          url: bestLead.url,
          source: bestLead.source,
          topic: topTopic,
          consensusCount: nonUSTopics[0].count
        };

        analysis.reasoning = `NYT leads with US domestic news ("${analysis.nytLead.headline.slice(0, 50)}..."), ` +
          `but ${nonUSLeads.length} of ${keyLeadsList.length} key UK sources (BBC, Guardian, Economist) are leading with non-US stories. ` +
          `Common international topic: "${topTopic}" (${nonUSTopics[0].count} sources).`;
      }
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
  if (leadAnalysis.suggestedLead) {
    console.log(`\n⚡ SUGGESTED ALTERNATIVE LEAD:`);
    console.log(`   "${leadAnalysis.suggestedLead.headline}"`);
    console.log(`   Source: ${leadAnalysis.suggestedLead.source}`);
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

  const condensed = {
    lead: briefing.nyt.lead,
    live: briefing.nyt.live.slice(0, 3),
    primary: briefing.nyt.primary.slice(0, 8),
    byRegion: byRegion,
    wire: {
      reuters: briefing.secondary.reuters?.slice(0, 3) || [],
      ap: briefing.secondary.ap?.slice(0, 3) || [],
      bbc: briefing.secondary.bbc?.slice(0, 3) || [],
      bloomberg: briefing.secondary.bloomberg?.slice(0, 3) || []
    },
    // Add international homepage leads for context
    internationalLeads: briefing.internationalLeads || {}
  };

  // Build lead guidance based on analysis
  let leadGuidance = '';
  if (leadAnalysis.suggestedLead) {
    leadGuidance = `
IMPORTANT - LEAD STORY GUIDANCE:
The NYT is leading with a US-centric domestic story, but key UK news outlets (BBC, Guardian, Economist) are prominently featuring a different global story. For this international news briefing, you should:

1. LEAD with the international story that other outlets are featuring: "${leadAnalysis.suggestedLead.headline}"
   Source: ${leadAnalysis.suggestedLead.source}
   URL: ${leadAnalysis.suggestedLead.url}

2. THEN cover the NYT's US story as secondary/context, noting it's dominating US coverage

3. Look for NYT coverage of the international lead story in the regional sections or wire services to augment your lead

This ensures the briefing prioritizes globally significant news over US-centric stories.
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

  // Pull in recent feedback to inform today's briefing
  const feedbackMemory = getRecentFeedback();
  if (feedbackMemory) {
    console.log('=== FEEDBACK MEMORY ===');
    console.log(feedbackMemory.trim());
    console.log('=======================\n');
  }

  const prompt = `You are writing a morning news briefing for Adam, an NYT journalist who writes "The World" newsletter (international news).

Write a conversational briefing based on this headline data. Follow these rules EXACTLY:
${leadGuidance}${feedbackMemory}
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
- NEVER use the word "amid" - it's lazy jargon. Find a better way to connect ideas.- NEVER use em-dashes or hyphens to join two independent clauses. Write separate sentences instead.

LINKS (CRITICAL):
- Use markdown links: [link text](url)
- Link text must be MAX 3 WORDS
- GOOD: "The [Fed raised rates](url) yesterday"
- BAD: "[Federal Reserve announces rate increase](url)"
- Every bullet must have at least one link

ATTRIBUTION:
- For non-NYT stories, vary your attribution language: "Reuters reports", "according to Bloomberg", "the BBC notes", "per AP" (use "per X" only once in the entire briefing)
- Don't over-attribute - if it's clearly sourced from the link, you don't always need to say where it came from

Here's the data:

LEAD STORY:
${JSON.stringify(condensed.lead, null, 2)}

LIVE COVERAGE:
${JSON.stringify(condensed.live, null, 2)}

TOP HEADLINES:
${JSON.stringify(condensed.primary, null, 2)}

STORIES BY REGION (use these for Around the World section):
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
    let elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Claude responded in ${elapsed}s`);

    // Sanity check - retry once if structural issues
    const sanity = quickSanityCheck(briefingText);
    if (!sanity.pass) {
      console.log(`Sanity check failed: ${sanity.issues.join(', ')}`);
      console.log('Retrying with explicit format reminder...');

      const retryPrompt = prompt + `\n\nIMPORTANT REMINDER: Your previous attempt had these issues: ${sanity.issues.join('; ')}. Fix them in this attempt.`;
      const retryStart = Date.now();
      briefingText = await callClaude(retryPrompt);
      elapsed = ((Date.now() - retryStart) / 1000).toFixed(1);
      console.log(`Retry responded in ${elapsed}s`);

      const recheck = quickSanityCheck(briefingText);
      if (!recheck.pass) {
        console.log(`Retry still has issues: ${recheck.issues.join(', ')} - using best attempt`);
      } else {
        console.log('Retry passed sanity check');
      }
    } else {
      console.log('Passed structural sanity check');
    }

    // Save markdown
    fs.writeFileSync('briefing.md', briefingText);
    console.log('Saved briefing.md');

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
  </style>
</head>
<body>
  <div class="timestamp">Generated ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET · <a href="#" onclick="refreshBriefing(); return false;">Refresh</a></div>
  <script>
    async function refreshBriefing() {
      const link = event.target;
      link.textContent = 'Refreshing...';
      link.style.pointerEvents = 'none';
      try {
        const res = await fetch('https://briefing-refresh.adampasick.workers.dev/refresh');
        const data = await res.json();
        if (data.success) {
          link.textContent = 'Triggered! Reloading in 60s...';
          setTimeout(() => location.reload(), 60000);
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

  <!-- Audio Player -->
  <div id="audio-player" style="margin-bottom: 24px; padding: 16px; background: #f0f0f0; border-radius: 8px;">
    <div style="display: flex; align-items: center; gap: 12px;">
      <button id="play-btn" onclick="toggleAudio()" style="
        width: 48px; height: 48px; border-radius: 50%; border: none;
        background: #1a1a1a; color: white; cursor: pointer;
        font-size: 18px; display: flex; align-items: center; justify-content: center;
      ">&#9658;</button>
      <div style="flex: 1;">
        <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-weight: 600; font-size: 0.9rem;">
          Listen to today's briefing
        </div>
        <div id="voice-info" style="font-size: 0.8rem; color: #666;">Loading...</div>
      </div>
    </div>
    <audio id="briefing-audio" src="podcast.mp3" preload="metadata"></audio>
  </div>
  <script>
    const audio = document.getElementById('briefing-audio');
    const playBtn = document.getElementById('play-btn');
    const voiceInfo = document.getElementById('voice-info');
    audio.addEventListener('loadedmetadata', () => {
      const duration = Math.round(audio.duration);
      const mins = Math.floor(duration / 60);
      const secs = duration % 60;
      voiceInfo.textContent = mins + ':' + secs.toString().padStart(2, '0');
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

  <!-- Feedback Widget -->
  <div id="feedback-widget" style="margin-top: 40px; padding-top: 24px; border-top: 1px solid #ddd;">
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 0.9rem; color: #666; margin-bottom: 12px;">
      How was today's briefing?
    </div>
    <div id="feedback-buttons" style="display: flex; gap: 8px; margin-bottom: 12px;">
      ${[1,2,3,4,5].map(n => `<button onclick="submitFeedback(${n})" style="
        width: 40px; height: 40px; border-radius: 8px; border: 1px solid #ccc;
        background: #fff; cursor: pointer; font-size: 16px;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      " onmouseover="this.style.background='#f0f0f0'" onmouseout="this.style.background='#fff'">${n}</button>`).join('\n      ')}
    </div>
    <textarea id="feedback-notes" placeholder="Notes (optional)" style="
      width: 100%; height: 60px; padding: 8px; border: 1px solid #ccc; border-radius: 8px;
      font-family: Georgia, serif; font-size: 0.85rem; resize: vertical; display: none;
    "></textarea>
    <div id="feedback-status" style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 0.85rem; color: #666;"></div>
  </div>
  <script>
    let selectedScore = null;
    const feedbackDate = '${new Date().toISOString().split('T')[0]}';

    function submitFeedback(score) {
      selectedScore = score;
      // Highlight selected button
      document.querySelectorAll('#feedback-buttons button').forEach((btn, i) => {
        btn.style.background = (i + 1 === score) ? '#1a1a1a' : '#fff';
        btn.style.color = (i + 1 === score) ? '#fff' : '#1a1a1a';
      });
      // Show notes field
      document.getElementById('feedback-notes').style.display = 'block';
      // Auto-submit after short delay (user can add notes first)
      clearTimeout(window._feedbackTimeout);
      window._feedbackTimeout = setTimeout(sendFeedback, 3000);
    }

    async function sendFeedback() {
      if (!selectedScore) return;
      const notes = document.getElementById('feedback-notes').value;
      const status = document.getElementById('feedback-status');
      status.textContent = 'Sending...';

      try {
        const params = new URLSearchParams({ score: selectedScore, date: feedbackDate });
        if (notes) params.set('notes', notes);
        const res = await fetch('https://briefing-refresh.adampasick.workers.dev/feedback?' + params);
        const data = await res.json();
        if (data.success) {
          status.textContent = 'Thanks! Score: ' + selectedScore + '/5';
          document.getElementById('feedback-notes').style.display = 'none';
        } else {
          status.textContent = 'Saved locally. Score: ' + selectedScore + '/5';
        }
      } catch (e) {
        status.textContent = 'Saved locally. Score: ' + selectedScore + '/5';
      }
      // Disable further submissions
      document.querySelectorAll('#feedback-buttons button').forEach(btn => {
        btn.disabled = true;
        btn.style.cursor = 'default';
      });
    }

    // Submit on notes blur too
    document.getElementById('feedback-notes').addEventListener('blur', () => {
      clearTimeout(window._feedbackTimeout);
      sendFeedback();
    });
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
