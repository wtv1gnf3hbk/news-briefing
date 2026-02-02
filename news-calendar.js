#!/usr/bin/env node
/**
 * News Calendar - Extract upcoming events from news coverage
 *
 * Pulls out dates, deadlines, and scheduled events mentioned in today's news.
 * Useful for staying ahead of what's coming.
 *
 * Usage:
 *   node news-calendar.js              # Show upcoming events
 *   node news-calendar.js --week       # Focus on this week
 *   node news-calendar.js --month      # Show the month ahead
 */

const https = require('https');
const fs = require('fs');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY');
  process.exit(1);
}

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
          if (json.error) reject(new Error(json.error.message));
          else resolve(json.content[0].text);
        } catch (e) {
          reject(new Error('API parse error'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(90000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    req.write(body);
    req.end();
  });
}

function loadBriefingData() {
  return JSON.parse(fs.readFileSync('briefing.json', 'utf8'));
}

function gatherAllHeadlines(briefing) {
  const headlines = [];

  // NYT
  if (briefing.nyt?.lead?.headline) {
    headlines.push({ source: 'NYT', text: briefing.nyt.lead.headline });
  }
  briefing.nyt?.primary?.forEach(item => {
    if (item.headline) headlines.push({ source: 'NYT', text: item.headline });
  });
  briefing.nyt?.secondary?.forEach(item => {
    if (item.headline) headlines.push({ source: 'NYT', text: item.headline });
  });

  // Wire services
  Object.entries(briefing.secondary || {}).forEach(([source, items]) => {
    items?.forEach(item => {
      if (item.title) headlines.push({ source: source.toUpperCase(), text: item.title });
    });
  });

  // International leads
  Object.entries(briefing.internationalLeads || {}).forEach(([source, data]) => {
    if (data?.lead?.headline) {
      headlines.push({ source: source.toUpperCase(), text: data.lead.headline });
    }
    data?.top?.forEach(item => {
      if (item.headline) headlines.push({ source: source.toUpperCase(), text: item.headline });
    });
  });

  return headlines;
}

async function extractCalendarEvents(headlines, timeframe) {
  const today = new Date().toISOString().split('T')[0];

  const prompt = `You are an intelligence analyst extracting upcoming events from news coverage.

TODAY'S DATE: ${today}

NEWS HEADLINES:
${headlines.map(h => `[${h.source}] ${h.text}`).join('\n')}

TASK: Extract all upcoming events, deadlines, and scheduled happenings mentioned or implied in these headlines.

Look for:
- Elections and votes
- Earnings reports and economic data releases
- Policy deadlines (tariffs taking effect, legislation deadlines)
- International summits and meetings
- Court dates and legal deadlines
- Product launches
- Central bank decisions
- Treaties or agreements taking effect

${timeframe === 'week' ? 'Focus on events in the next 7 days.' : ''}
${timeframe === 'month' ? 'Include events up to 30 days out.' : ''}

FORMAT YOUR RESPONSE AS:

**THIS WEEK**
• [DATE or TIMEFRAME] - EVENT - Brief context (1 line)

**COMING UP**
• [DATE or TIMEFRAME] - EVENT - Brief context (1 line)

**WATCH FOR (date unknown)**
• EVENT - Why it matters

RULES:
- Only include events you can reasonably infer from the headlines
- If a headline mentions something "scheduled" or "planned" but no date, put it in WATCH FOR
- Be specific about dates when possible
- Keep context brief - one line max
- If no events found in a category, omit that category

Format for terminal output. Be concise.`;

  return await callClaude(prompt);
}

async function main() {
  const args = process.argv.slice(2);

  let timeframe = 'all';

  if (args.includes('--week')) {
    timeframe = 'week';
  } else if (args.includes('--month')) {
    timeframe = 'month';
  } else if (args.includes('--help')) {
    console.log('News Calendar - Extract upcoming events from news');
    console.log('');
    console.log('Usage:');
    console.log('  node news-calendar.js           Show all upcoming events');
    console.log('  node news-calendar.js --week    Focus on next 7 days');
    console.log('  node news-calendar.js --month   Show next 30 days');
    process.exit(0);
  }

  try {
    const briefing = loadBriefingData();
    const headlines = gatherAllHeadlines(briefing);

    console.log('');
    console.log('NEWS CALENDAR');
    console.log('═'.repeat(40));
    console.log(`Scanning ${headlines.length} headlines for upcoming events...`);
    console.log('');

    const calendar = await extractCalendarEvents(headlines, timeframe);
    console.log(calendar);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
