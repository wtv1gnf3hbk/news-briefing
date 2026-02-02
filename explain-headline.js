#!/usr/bin/env node
/**
 * Headline Explainer / Screenshot Context
 *
 * Paste a headline or screenshot text, get context from today's sources.
 *
 * Usage:
 *   node explain-headline.js "UAE firm takes stake in Trump crypto"
 *   echo "headline text" | node explain-headline.js
 */

const https = require('https');
const fs = require('fs');
const readline = require('readline');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY');
  process.exit(1);
}

function callClaude(prompt, maxTokens = 1000) {
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
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    req.write(body);
    req.end();
  });
}

function loadBriefingData() {
  const briefing = JSON.parse(fs.readFileSync('briefing.json', 'utf8'));
  let writtenBriefing = '';
  try {
    writtenBriefing = fs.readFileSync('intelligence-briefing.md', 'utf8');
  } catch (e) {}
  return { briefing, writtenBriefing };
}

async function explainHeadline(headlineText) {
  const { briefing, writtenBriefing } = loadBriefingData();

  const sourceData = JSON.stringify({
    lead: briefing.nyt?.lead,
    primary: briefing.nyt?.primary?.slice(0, 12),
    secondary: briefing.nyt?.secondary?.slice(0, 15),
    wire: {
      reuters: briefing.secondary?.reuters?.slice(0, 5),
      bbc: briefing.secondary?.bbc?.slice(0, 5),
      bloomberg: briefing.secondary?.bloomberg?.slice(0, 5),
      ap: briefing.secondary?.ap?.slice(0, 5),
    },
    internationalLeads: briefing.internationalLeads
  }, null, 2);

  const prompt = `You are a news context assistant. Someone just saw this headline/text and wants to understand it better.

HEADLINE/TEXT THEY SAW:
"${headlineText}"

TODAY'S NEWS DATA:
${sourceData}

TODAY'S INTELLIGENCE BRIEFING:
${writtenBriefing}

YOUR TASK:
1. WHAT'S THE STORY: Briefly explain what this headline is about (2-3 sentences)
2. CONTEXT: What's the background? Why does this matter? (2-3 sentences)
3. OTHER COVERAGE: How are other sources covering this? Any different angles? (1-2 sentences)
4. RELATED: Any related stories in today's news they should know about? (1-2 bullet points, or "None" if nothing relevant)

Keep it concise - this should be a quick explainer, not an essay. Format for terminal output.

If the headline isn't in today's news data, say so and provide what context you can from general knowledge.`;

  console.log('');
  console.log('Looking up context...');
  console.log('');

  const response = await callClaude(prompt);
  return response;
}

async function main() {
  let headlineText = process.argv.slice(2).join(' ');

  // If no argument, check for piped input
  if (!headlineText && !process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    const lines = [];
    for await (const line of rl) {
      lines.push(line);
    }
    headlineText = lines.join(' ').trim();
  }

  if (!headlineText) {
    console.log('Usage: node explain-headline.js "headline text"');
    console.log('   or: echo "headline" | node explain-headline.js');
    process.exit(1);
  }

  try {
    const response = await explainHeadline(headlineText);
    console.log(response);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
