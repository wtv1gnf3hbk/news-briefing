#!/usr/bin/env node
/**
 * Interactive Query Interface for Intelligence Briefing
 *
 * Ask questions about today's news:
 *   node query-briefing.js "what happened with Ukraine?"
 *   node query-briefing.js "catch me up on markets"
 *   node query-briefing.js "prepare me for a meeting about AI"
 */

const https = require('https');
const fs = require('fs');
const readline = require('readline');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY');
  process.exit(1);
}

// ============================================
// CLAUDE API
// ============================================

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

// ============================================
// LOAD DATA
// ============================================

function loadBriefingData() {
  const briefing = JSON.parse(fs.readFileSync('briefing.json', 'utf8'));

  // Also load the written briefing if available
  let writtenBriefing = '';
  try {
    writtenBriefing = fs.readFileSync('intelligence-briefing.md', 'utf8');
  } catch (e) {}

  return { briefing, writtenBriefing };
}

// ============================================
// QUERY TYPES
// ============================================

function detectQueryType(query) {
  const lower = query.toLowerCase();

  if (lower.includes('catch me up') || lower.includes('what did i miss')) {
    return 'catchup';
  }
  if (lower.includes('prepare me') || lower.includes('meeting about') || lower.includes('brief me on')) {
    return 'prep';
  }
  if (lower.includes('what happened') || lower.includes('news about') || lower.includes('update on')) {
    return 'topic';
  }
  if (lower.includes('compare') || lower.includes('different sources') || lower.includes('disagreement')) {
    return 'sources';
  }
  return 'general';
}

// ============================================
// BUILD PROMPTS
// ============================================

function buildQueryPrompt(query, data, queryType) {
  const { briefing, writtenBriefing } = data;

  const sourceData = JSON.stringify({
    lead: briefing.nyt?.lead,
    primary: briefing.nyt?.primary?.slice(0, 10),
    secondary: briefing.nyt?.secondary?.slice(0, 15),
    wire: {
      reuters: briefing.secondary?.reuters?.slice(0, 5),
      bbc: briefing.secondary?.bbc?.slice(0, 5),
      bloomberg: briefing.secondary?.bloomberg?.slice(0, 5),
    },
    internationalLeads: briefing.internationalLeads
  }, null, 2);

  const baseContext = `You are an intelligence briefing assistant. Answer questions about today's news based on the source data below.

TODAY'S BRIEFING:
${writtenBriefing}

RAW SOURCE DATA:
${sourceData}

RULES:
- Be concise but substantive
- Only state facts from the data - don't invent
- Add brief analysis when helpful
- If asked about something not in the data, say so
- Format for terminal output (no markdown links)
`;

  switch (queryType) {
    case 'catchup':
      return `${baseContext}

USER QUERY: ${query}

Give a 30-second verbal catch-up. What are the 2-3 most important things they need to know? Be direct and conversational.`;

    case 'prep':
      return `${baseContext}

USER QUERY: ${query}

The user needs to prepare for a meeting or conversation. Extract relevant context from today's news that would help them appear informed. Focus on:
1. Key facts they should know
2. Recent developments
3. What different sources are saying
4. Any controversies or open questions

Keep it brief but useful.`;

    case 'topic':
      return `${baseContext}

USER QUERY: ${query}

Find all relevant information about this topic in today's news. Synthesize across sources. Note if sources have different angles or facts.`;

    case 'sources':
      return `${baseContext}

USER QUERY: ${query}

Compare how different sources covered this. Note:
- What's the NYT leading with vs BBC vs Guardian?
- Any disagreements or different emphasis?
- What might explain the differences?`;

    default:
      return `${baseContext}

USER QUERY: ${query}

Answer the question based on today's news data.`;
  }
}

// ============================================
// MAIN
// ============================================

async function answerQuery(query) {
  const data = loadBriefingData();
  const queryType = detectQueryType(query);
  const prompt = buildQueryPrompt(query, data, queryType);

  console.log('');
  console.log('Thinking...');
  console.log('');

  const response = await callClaude(prompt);
  return response;
}

async function interactiveMode() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('╔════════════════════════════════════════╗');
  console.log('║     INTELLIGENCE BRIEFING QUERY        ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');
  console.log('Ask about today\'s news. Examples:');
  console.log('  "catch me up"');
  console.log('  "what happened with Ukraine?"');
  console.log('  "prepare me for a meeting about crypto"');
  console.log('  "how are different sources covering Trump?"');
  console.log('');
  console.log('Type "exit" to quit.');
  console.log('');

  const askQuestion = () => {
    rl.question('> ', async (query) => {
      if (query.toLowerCase() === 'exit' || query.toLowerCase() === 'quit') {
        console.log('Goodbye.');
        rl.close();
        return;
      }

      if (!query.trim()) {
        askQuestion();
        return;
      }

      try {
        const response = await answerQuery(query);
        console.log(response);
        console.log('');
      } catch (e) {
        console.log(`Error: ${e.message}`);
      }

      askQuestion();
    });
  };

  askQuestion();
}

async function main() {
  // Check for command line query
  const query = process.argv.slice(2).join(' ');

  if (query) {
    // One-shot mode
    try {
      const response = await answerQuery(query);
      console.log(response);
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  } else {
    // Interactive mode
    await interactiveMode();
  }
}

main();
