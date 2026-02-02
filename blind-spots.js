#!/usr/bin/env node
/**
 * Blind Spot Detector - What stories might you be missing?
 *
 * Identifies important stories you might overlook based on:
 * - International coverage that differs from US media
 * - Topics adjacent to your interests
 * - Stories that "fell off" but still matter
 *
 * Usage:
 *   node blind-spots.js                        # General blind spot check
 *   node blind-spots.js --profile=investor     # Based on your profile
 *   node blind-spots.js --international        # US vs international gap
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

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

function loadProfile(profileName) {
  const profilePath = path.join(__dirname, 'profiles', `${profileName}.json`);
  try {
    return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch (e) {
    // Try with example- prefix
    try {
      const examplePath = path.join(__dirname, 'profiles', `example-${profileName}.json`);
      return JSON.parse(fs.readFileSync(examplePath, 'utf8'));
    } catch (e2) {
      return null;
    }
  }
}

function loadWatchlist() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlist.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

async function detectInternationalBlindSpots(briefing) {
  // Compare US coverage (NYT) vs international (BBC, Guardian, Al Jazeera)
  const usLeads = {
    lead: briefing.nyt?.lead?.headline,
    primary: briefing.nyt?.primary?.slice(0, 5).map(i => i.headline)
  };

  const intlLeads = {};
  ['bbc', 'guardian', 'aljazeera', 'reuters', 'economist'].forEach(source => {
    const data = briefing.internationalLeads?.[source];
    if (data) {
      intlLeads[source] = {
        lead: data.lead?.headline,
        top: data.top?.slice(0, 3).map(i => i.headline)
      };
    }
  });

  const prompt = `You are an intelligence analyst identifying blind spots in US news coverage.

US COVERAGE (NYT):
Lead: ${usLeads.lead || 'N/A'}
Top stories:
${usLeads.primary?.map((h, i) => `${i + 1}. ${h}`).join('\n') || 'N/A'}

INTERNATIONAL COVERAGE:
${Object.entries(intlLeads).map(([source, data]) => {
  return `\n${source.toUpperCase()}:\nLead: ${data.lead || 'N/A'}${data.top?.length ? `\nTop:\n${data.top.map((h, i) => `  ${i + 1}. ${h}`).join('\n')}` : ''}`;
}).join('\n')}

TASK: Identify blind spots - stories that international outlets consider important but US coverage is missing or underplaying.

FORMAT:

**WHAT THE US ISN'T LEADING WITH**
Stories that 2+ international outlets lead with but aren't in NYT's top stories.
For each: Why might this matter to US readers? (1-2 sentences)

**DIFFERENT FRAMING**
Same story, different angle - where are international outlets framing something differently than US media?

**REGIONAL STORIES TO WATCH**
Stories that might not seem relevant to US audiences but have implications for US interests.

RULES:
- Focus on genuine gaps, not just different selection
- Explain why each blind spot matters
- Be specific about the difference
- Skip if there are no meaningful blind spots today

Format for terminal output.`;

  return await callClaude(prompt);
}

async function detectProfileBlindSpots(briefing, profile, watchlist) {
  // Build context about what user cares about
  const userContext = [];

  if (profile) {
    userContext.push(`Role: ${profile.role || 'general'}`);
    if (profile.priorities) {
      userContext.push(`Priorities: ${Object.entries(profile.priorities).map(([k, v]) => `${k}(${v})`).join(', ')}`);
    }
    if (profile.activeThreads) {
      userContext.push(`Active threads: ${profile.activeThreads.join(', ')}`);
    }
  }

  if (watchlist) {
    const items = [
      ...(watchlist.topics || []),
      ...(watchlist.companies || []),
      ...(watchlist.people || []),
      ...(watchlist.regions || [])
    ];
    if (items.length) {
      userContext.push(`Watchlist: ${items.join(', ')}`);
    }
  }

  // Gather all headlines
  const headlines = [];
  if (briefing.nyt?.lead?.headline) headlines.push(briefing.nyt.lead.headline);
  briefing.nyt?.primary?.forEach(i => headlines.push(i.headline));
  briefing.nyt?.secondary?.slice(0, 10).forEach(i => headlines.push(i.headline));

  Object.values(briefing.secondary || {}).forEach(items => {
    items?.slice(0, 5).forEach(i => headlines.push(i.title));
  });

  Object.values(briefing.internationalLeads || {}).forEach(data => {
    if (data?.lead?.headline) headlines.push(data.lead.headline);
    data?.top?.slice(0, 3).forEach(i => headlines.push(i.headline));
  });

  const prompt = `You are an intelligence analyst helping identify blind spots in news consumption.

USER PROFILE:
${userContext.length ? userContext.join('\n') : 'No specific profile (general interest)'}

TODAY'S HEADLINES:
${headlines.slice(0, 40).map((h, i) => `${i + 1}. ${h}`).join('\n')}

TASK: Identify stories this user might overlook but shouldn't - based on their profile and interests.

**ADJACENT TO YOUR INTERESTS**
Stories you might skip but actually connect to things you care about.
- [Story] → [Why it connects to your interests]

**OUTSIDE YOUR USUAL LENS**
Important stories in categories you typically don't track but should know about today.

**SECOND-ORDER EFFECTS**
Stories that might not seem relevant at first but could impact your areas of focus.
- [Story] → [The second-order effect to watch]

${profile?.role ? `\n**AS A ${profile.role.toUpperCase()}**\nSpecifically for your role, what might you be missing?` : ''}

RULES:
- Be genuinely helpful, not alarmist
- Connect dots the user might miss
- Explain the "so what" briefly
- If their interests are well-covered today, say so

Format for terminal output.`;

  return await callClaude(prompt);
}

async function main() {
  const args = process.argv.slice(2);

  let mode = 'general';
  let profileName = null;

  args.forEach(arg => {
    if (arg === '--international' || arg === '-i') {
      mode = 'international';
    } else if (arg.startsWith('--profile=')) {
      profileName = arg.split('=')[1];
      mode = 'profile';
    } else if (arg === '--help') {
      console.log('Blind Spot Detector - What stories might you be missing?');
      console.log('');
      console.log('Usage:');
      console.log('  node blind-spots.js                  General blind spot check');
      console.log('  node blind-spots.js --international  US vs international gaps');
      console.log('  node blind-spots.js --profile=NAME   Based on your profile');
      console.log('');
      console.log('Profiles:');
      console.log('  investor  - Macro investor perspective');
      console.log('  policy    - Policy/government perspective');
      console.log('');
      console.log('Also uses watchlist.json if present.');
      process.exit(0);
    }
  });

  try {
    const briefing = loadBriefingData();

    console.log('');
    if (mode === 'international') {
      console.log('BLIND SPOT CHECK: US vs INTERNATIONAL');
    } else if (mode === 'profile') {
      console.log(`BLIND SPOT CHECK: ${profileName?.toUpperCase() || 'PERSONALIZED'}`);
    } else {
      console.log('BLIND SPOT CHECK');
    }
    console.log('═'.repeat(40));
    console.log('');

    let response;
    if (mode === 'international') {
      response = await detectInternationalBlindSpots(briefing);
    } else {
      const profile = profileName ? loadProfile(profileName) : null;
      const watchlist = loadWatchlist();

      if (profileName && !profile) {
        console.log(`Warning: Profile "${profileName}" not found, using general analysis.`);
        console.log('');
      }

      response = await detectProfileBlindSpots(briefing, profile, watchlist);
    }

    console.log(response);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
