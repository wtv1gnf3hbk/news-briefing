#!/usr/bin/env node
/**
 * Contrarian View - Alternative perspectives on today's news
 *
 * Challenges the consensus narrative by presenting counter-arguments
 * and perspectives that might be underrepresented in mainstream coverage.
 *
 * Usage:
 *   node contrarian-view.js                    # Challenge today's lead stories
 *   node contrarian-view.js "tariffs"          # Contrarian take on specific topic
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

async function generateContrarianOnLeads(briefing) {
  // Get lead stories from multiple sources
  const leads = {
    'NYT': briefing.nyt?.lead?.headline,
    'BBC': briefing.internationalLeads?.bbc?.lead?.headline,
    'Guardian': briefing.internationalLeads?.guardian?.lead?.headline,
    'Reuters': briefing.internationalLeads?.reuters?.lead?.headline,
    'Al Jazeera': briefing.internationalLeads?.aljazeera?.lead?.headline,
  };

  const prompt = `You are a thoughtful contrarian analyst. Your job is to challenge consensus narratives - not to be contrary for its own sake, but to surface perspectives and considerations that mainstream coverage might underweight.

TODAY'S LEAD STORIES:
${Object.entries(leads)
  .filter(([_, h]) => h)
  .map(([source, headline]) => `${source}: "${headline}"`)
  .join('\n')}

TASK: Provide contrarian perspectives on the biggest stories of the day.

For each major story:

1. **The Consensus** - What's the mainstream take? (1 sentence)
2. **The Contrarian View** - What's the alternative perspective? (2-3 sentences)
3. **Worth Considering** - Why might the contrarian view have merit? (1-2 sentences)

RULES:
- Be intellectually honest - don't strawman the consensus or the contrarian view
- The goal is to broaden thinking, not to be provocative
- Contrarian doesn't mean conspiracy - use legitimate counter-arguments
- Consider: economic vs political framing, short vs long term, different stakeholder perspectives
- Acknowledge when the consensus might be right but there's still value in the alternative lens
- Skip stories where there's no meaningful contrarian take

Format for terminal output. Cover 2-3 stories max.`;

  return await callClaude(prompt);
}

async function generateContrarianOnTopic(briefing, topic) {
  // Gather all mentions of the topic
  const mentions = [];

  const searchIn = (text, source) => {
    if (!text) return;
    if (text.toLowerCase().includes(topic.toLowerCase())) {
      mentions.push({ source, text });
    }
  };

  // Search all sources
  if (briefing.nyt?.lead?.headline) {
    searchIn(briefing.nyt.lead.headline, 'NYT Lead');
  }
  briefing.nyt?.primary?.forEach((item, i) => {
    searchIn(item.headline, `NYT #${i + 1}`);
  });

  Object.entries(briefing.secondary || {}).forEach(([source, items]) => {
    items?.forEach((item, i) => {
      searchIn(item.title, source.toUpperCase());
    });
  });

  Object.entries(briefing.internationalLeads || {}).forEach(([source, data]) => {
    if (data?.lead?.headline) {
      searchIn(data.lead.headline, `${source.toUpperCase()} Lead`);
    }
    data?.top?.forEach(item => {
      searchIn(item.headline, source.toUpperCase());
    });
  });

  if (mentions.length === 0) {
    return `No coverage of "${topic}" found in today's news to analyze.`;
  }

  const prompt = `You are a thoughtful contrarian analyst. Your job is to challenge consensus narratives on a specific topic.

TOPIC: "${topic}"

TODAY'S COVERAGE:
${mentions.map(m => `[${m.source}] ${m.text}`).join('\n')}

TASK: Provide a contrarian analysis of the coverage of "${topic}".

STRUCTURE:

**HOW IT'S BEING FRAMED**
What's the dominant narrative across these headlines? (2-3 sentences)

**THE CONTRARIAN TAKE**
What's missing from this framing? What alternative perspective deserves consideration? (3-4 sentences)

**QUESTIONS THE COVERAGE ISN'T ASKING**
- [Question 1]
- [Question 2]
- [Question 3]

**WHO BENEFITS FROM THE CONSENSUS FRAMING?**
Brief analysis (2 sentences)

**THE STEELMAN**
The best argument for why the mainstream framing might actually be correct. (2 sentences)

RULES:
- Be intellectually rigorous
- Contrarian ≠ conspiracy
- Surface legitimate alternative perspectives, stakeholders, timeframes
- Acknowledge complexity

Format for terminal output.`;

  return await callClaude(prompt);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    console.log('Contrarian View - Alternative perspectives on news');
    console.log('');
    console.log('Usage:');
    console.log('  node contrarian-view.js              Challenge today\'s lead stories');
    console.log('  node contrarian-view.js "topic"      Contrarian take on specific topic');
    console.log('');
    console.log('Examples:');
    console.log('  node contrarian-view.js "tariffs"');
    console.log('  node contrarian-view.js "AI regulation"');
    console.log('  node contrarian-view.js "Fed rates"');
    process.exit(0);
  }

  try {
    const briefing = loadBriefingData();
    const topic = args.join(' ');

    console.log('');
    if (topic) {
      console.log(`CONTRARIAN VIEW: "${topic.toUpperCase()}"`);
    } else {
      console.log('CONTRARIAN VIEW: TODAY\'S LEADS');
    }
    console.log('═'.repeat(40));
    console.log('');

    let response;
    if (topic) {
      response = await generateContrarianOnTopic(briefing, topic);
    } else {
      response = await generateContrarianOnLeads(briefing);
    }

    console.log(response);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
