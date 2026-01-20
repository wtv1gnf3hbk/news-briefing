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
// MAIN
// ============================================

async function main() {
  console.log('Reading briefing.json...');
  const briefing = JSON.parse(fs.readFileSync('briefing.json', 'utf8'));

  // Build a condensed version for the prompt (to save tokens)
  const condensed = {
    lead: briefing.nyt.lead,
    live: briefing.nyt.live.slice(0, 3),
    primary: briefing.nyt.primary.slice(0, 8),
    secondary: briefing.nyt.secondary.slice(0, 15),
    wire: {
      reuters: briefing.secondary.reuters?.slice(0, 3) || [],
      ap: briefing.secondary.ap?.slice(0, 3) || [],
      bbc: briefing.secondary.bbc?.slice(0, 3) || [],
      bloomberg: briefing.secondary.bloomberg?.slice(0, 3) || []
    }
  };

  const prompt = `You are writing a morning news briefing for Adam, an NYT journalist who writes "The World" newsletter (international news).

Write a conversational briefing based on this headline data. Follow these rules EXACTLY:

FORMAT:
- Start with "Good morning Adam. Here's the state of play:"
- 2-3 paragraphs on the lead/top stories (synthesize, don't just list)
- "**Business/Tech**" section with 3-4 bullet points
- "**Around the World**" section with bullets for: Latin America, Europe, Asia, Middle East, Africa (one story each)

STYLE:
- Conversational, like chatting with a well-informed friend
- Warm but not jokey. Use contractions.
- Lead with context/stakes, not just headlines
- Full sentences, not headline fragments

LINKS (CRITICAL):
- Use markdown links: [link text](url)
- Link text must be MAX 3 WORDS
- GOOD: "The [Fed raised rates](url) yesterday"
- BAD: "[Federal Reserve announces rate increase](url)"
- Every bullet must have at least one link

ATTRIBUTION:
- For non-NYT stories, attribute: "per Reuters", "BBC reports", etc.

Here's the data:

LEAD STORY:
${JSON.stringify(condensed.lead, null, 2)}

LIVE COVERAGE:
${JSON.stringify(condensed.live, null, 2)}

TOP HEADLINES:
${JSON.stringify(condensed.primary, null, 2)}

SECTION HEADLINES (by region/topic):
${JSON.stringify(condensed.secondary, null, 2)}

WIRE SERVICES:
${JSON.stringify(condensed.wire, null, 2)}

Write the briefing now. Keep it concise but comprehensive.`;

  console.log('Calling Claude API...');
  const startTime = Date.now();

  try {
    const briefingText = await callClaude(prompt);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Claude responded in ${elapsed}s`);

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
  <div class="timestamp">Generated ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET</div>
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
