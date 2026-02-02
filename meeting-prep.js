#!/usr/bin/env node
/**
 * Meeting Prep Briefing
 *
 * Generate a quick briefing before a meeting based on:
 * - Who you're meeting with (person, company, country)
 * - What topic you're discussing
 * - How much time you have
 *
 * Usage:
 *   node meeting-prep.js --who "German trade delegation" --topic "tariffs"
 *   node meeting-prep.js --who "OpenAI" --topic "AI investment"
 *   node meeting-prep.js --topic "Middle East" --time 2
 */

const https = require('https');
const fs = require('fs');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY');
  process.exit(1);
}

function callClaude(prompt, maxTokens = 1500) {
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

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { who: null, topic: null, time: 5 };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--who' && args[i + 1]) {
      result.who = args[++i];
    } else if (args[i] === '--topic' && args[i + 1]) {
      result.topic = args[++i];
    } else if (args[i] === '--time' && args[i + 1]) {
      result.time = parseInt(args[++i]) || 5;
    }
  }

  return result;
}

function loadBriefingData() {
  const briefing = JSON.parse(fs.readFileSync('briefing.json', 'utf8'));
  let writtenBriefing = '';
  try {
    writtenBriefing = fs.readFileSync('intelligence-briefing.md', 'utf8');
  } catch (e) {}
  return { briefing, writtenBriefing };
}

async function generateMeetingPrep(who, topic, timeMinutes) {
  const { briefing, writtenBriefing } = loadBriefingData();

  const sourceData = JSON.stringify({
    lead: briefing.nyt?.lead,
    primary: briefing.nyt?.primary?.slice(0, 12),
    secondary: briefing.nyt?.secondary?.slice(0, 20),
    wire: {
      reuters: briefing.secondary?.reuters?.slice(0, 6),
      bbc: briefing.secondary?.bbc?.slice(0, 6),
      bloomberg: briefing.secondary?.bloomberg?.slice(0, 6),
      wsj: briefing.secondary?.wsj?.slice(0, 6),
    },
    internationalLeads: briefing.internationalLeads
  }, null, 2);

  let contextDescription = '';
  if (who && topic) {
    contextDescription = `Meeting with ${who} about ${topic}`;
  } else if (who) {
    contextDescription = `Meeting with ${who}`;
  } else if (topic) {
    contextDescription = `Discussion about ${topic}`;
  } else {
    contextDescription = `General meeting prep`;
  }

  const prompt = `You are preparing someone for a meeting. They have ${timeMinutes} minutes to read this.

MEETING CONTEXT: ${contextDescription}

TODAY'S NEWS DATA:
${sourceData}

TODAY'S INTELLIGENCE BRIEFING:
${writtenBriefing}

YOUR TASK:
Create a focused meeting prep briefing. Structure it as:

**QUICK CONTEXT** (30 seconds)
What's the most important thing to know right now related to this meeting? One paragraph.

**KEY FACTS** (${Math.max(1, Math.floor(timeMinutes / 2))} points)
Bullet points of specific facts from today's news relevant to the meeting. Things they might be asked about or should reference.

**WHAT THEY'RE LIKELY THINKING**
If meeting with a person/organization/country, what's their perspective based on recent news? What might they bring up?

**TALKING POINTS**
2-3 things the reader could mention to seem informed on current events related to this topic.

**WATCH OUT FOR**
Any sensitive topics or potential landmines in today's news they should be aware of?

Keep it scannable and actionable. This is a ${timeMinutes}-minute prep, not a research report.
Format for terminal output (no markdown links).`;

  console.log('');
  console.log(`Generating meeting prep: ${contextDescription}`);
  console.log(`Reading time: ~${timeMinutes} minutes`);
  console.log('');

  const response = await callClaude(prompt);
  return response;
}

async function main() {
  const { who, topic, time } = parseArgs();

  if (!who && !topic) {
    console.log('Meeting Prep Generator');
    console.log('');
    console.log('Usage:');
    console.log('  node meeting-prep.js --who "person/org/country" --topic "subject" --time N');
    console.log('');
    console.log('Examples:');
    console.log('  node meeting-prep.js --who "German delegation" --topic "trade"');
    console.log('  node meeting-prep.js --who "OpenAI" --time 3');
    console.log('  node meeting-prep.js --topic "Middle East" --time 10');
    process.exit(0);
  }

  try {
    const response = await generateMeetingPrep(who, topic, time);
    console.log(response);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
