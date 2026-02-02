#!/usr/bin/env node
/**
 * Source Comparison Tool
 *
 * Shows how different news outlets are covering the same story.
 * Useful for understanding editorial perspective and what's being emphasized.
 *
 * Usage:
 *   node compare-sources.js "Trump"
 *   node compare-sources.js "Ukraine"
 *   node compare-sources.js --leads  (compare today's lead stories)
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

function loadBriefingData() {
  return JSON.parse(fs.readFileSync('briefing.json', 'utf8'));
}

async function compareLeads() {
  const briefing = loadBriefingData();

  // Extract lead stories from each source
  const leads = {
    'New York Times': briefing.nyt?.lead?.headline,
    'BBC': briefing.internationalLeads?.bbc?.lead?.headline,
    'Guardian': briefing.internationalLeads?.guardian?.lead?.headline,
    'Reuters': briefing.internationalLeads?.reuters?.lead?.headline,
    'Al Jazeera': briefing.internationalLeads?.aljazeera?.lead?.headline,
    'Economist': briefing.internationalLeads?.economist?.lead?.headline,
  };

  const prompt = `Compare these lead stories from major news outlets today:

${Object.entries(leads)
  .filter(([_, headline]) => headline)
  .map(([source, headline]) => `${source}: "${headline}"`)
  .join('\n')}

ANALYZE:
1. **What's the consensus?** Are most outlets leading with the same story? If so, what is it?

2. **Who's different?** Which outlets are leading with something different? Why might that be?

3. **US vs International lens:** Is there a split between US outlets (NYT) and international outlets (BBC, Guardian) in what they consider the top story?

4. **What this tells us:** Based on what different editors chose as most important, what does this say about today's news landscape?

Keep it analytical but readable. Format for terminal output.`;

  console.log('');
  console.log('COMPARING TODAY\'S LEAD STORIES');
  console.log('═'.repeat(40));
  console.log('');

  Object.entries(leads)
    .filter(([_, headline]) => headline)
    .forEach(([source, headline]) => {
      console.log(`${source}:`);
      console.log(`  ${headline?.slice(0, 80)}${headline?.length > 80 ? '...' : ''}`);
      console.log('');
    });

  console.log('═'.repeat(40));
  console.log('');
  console.log('Analysis:');
  console.log('');

  const response = await callClaude(prompt);
  return response;
}

async function compareTopicCoverage(topic) {
  const briefing = loadBriefingData();

  // Gather all headlines mentioning the topic
  const allHeadlines = [];

  // NYT
  if (briefing.nyt?.lead?.headline?.toLowerCase().includes(topic.toLowerCase())) {
    allHeadlines.push({ source: 'NYT', headline: briefing.nyt.lead.headline, position: 'Lead' });
  }
  briefing.nyt?.primary?.forEach((item, i) => {
    if (item.headline?.toLowerCase().includes(topic.toLowerCase())) {
      allHeadlines.push({ source: 'NYT', headline: item.headline, position: `#${i + 1}` });
    }
  });

  // Wire services
  Object.entries(briefing.secondary || {}).forEach(([source, items]) => {
    items?.forEach((item, i) => {
      if (item.title?.toLowerCase().includes(topic.toLowerCase())) {
        allHeadlines.push({ source: source.toUpperCase(), headline: item.title, position: `#${i + 1}` });
      }
    });
  });

  // International leads
  Object.entries(briefing.internationalLeads || {}).forEach(([source, data]) => {
    if (data?.lead?.headline?.toLowerCase().includes(topic.toLowerCase())) {
      allHeadlines.push({ source: source.toUpperCase(), headline: data.lead.headline, position: 'Lead' });
    }
    data?.top?.forEach((item, i) => {
      if (item.headline?.toLowerCase().includes(topic.toLowerCase())) {
        allHeadlines.push({ source: source.toUpperCase(), headline: item.headline, position: `Top ${i + 1}` });
      }
    });
  });

  if (allHeadlines.length === 0) {
    console.log(`No coverage of "${topic}" found in today's sources.`);
    return '';
  }

  const prompt = `Compare how different news sources are covering "${topic}" today:

COVERAGE FOUND:
${allHeadlines.map(h => `${h.source} (${h.position}): "${h.headline}"`).join('\n')}

ANALYZE:
1. **How prominent is this story?** Which outlets are leading with it vs burying it?

2. **Framing differences:** How do different outlets frame the same story? What words or angles differ?

3. **What's emphasized:** What aspects does each source emphasize? What's left out?

4. **Political/regional lens:** Can you detect any editorial perspective in how outlets cover this?

5. **The full picture:** What would someone learn differently reading just one source vs comparing all of them?

Be specific with examples from the headlines. Format for terminal output.`;

  console.log('');
  console.log(`COMPARING COVERAGE OF: "${topic.toUpperCase()}"`);
  console.log('═'.repeat(40));
  console.log('');

  allHeadlines.forEach(h => {
    console.log(`${h.source} (${h.position}):`);
    console.log(`  ${h.headline?.slice(0, 75)}${h.headline?.length > 75 ? '...' : ''}`);
    console.log('');
  });

  console.log('═'.repeat(40));
  console.log('');
  console.log('Analysis:');
  console.log('');

  const response = await callClaude(prompt);
  return response;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log('Source Comparison Tool');
    console.log('');
    console.log('Usage:');
    console.log('  node compare-sources.js --leads         Compare lead stories across outlets');
    console.log('  node compare-sources.js "topic"         Compare coverage of a topic');
    console.log('');
    console.log('Examples:');
    console.log('  node compare-sources.js --leads');
    console.log('  node compare-sources.js "Ukraine"');
    console.log('  node compare-sources.js "Trump"');
    process.exit(0);
  }

  try {
    let response;
    if (args[0] === '--leads') {
      response = await compareLeads();
    } else {
      response = await compareTopicCoverage(args.join(' '));
    }
    console.log(response);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
