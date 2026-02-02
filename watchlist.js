#!/usr/bin/env node
/**
 * Watchlist - Track topics, companies, and people across news sources
 *
 * Filters today's news for items matching your personal watchlist.
 * Think of it as a personalized news radar.
 *
 * Usage:
 *   node watchlist.js                     # Use default watchlist
 *   node watchlist.js --config=my.json    # Use custom watchlist
 *   node watchlist.js --add "Tesla"       # Add item to watchlist
 *   node watchlist.js --remove "Tesla"    # Remove item
 *   node watchlist.js --list              # Show current watchlist
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY');
  process.exit(1);
}

const DEFAULT_WATCHLIST_PATH = path.join(__dirname, 'watchlist.json');

const DEFAULT_WATCHLIST = {
  topics: ['Ukraine', 'AI regulation', 'Fed rates', 'climate'],
  companies: ['Apple', 'Meta', 'OpenAI', 'Tesla'],
  people: ['Trump', 'Biden', 'Musk', 'Powell'],
  regions: ['China', 'Middle East', 'Europe']
};

function loadWatchlist(configPath) {
  const watchlistPath = configPath || DEFAULT_WATCHLIST_PATH;

  try {
    return JSON.parse(fs.readFileSync(watchlistPath, 'utf8'));
  } catch (e) {
    // If no watchlist exists, create default
    if (!configPath) {
      fs.writeFileSync(DEFAULT_WATCHLIST_PATH, JSON.stringify(DEFAULT_WATCHLIST, null, 2));
      console.log('Created default watchlist at watchlist.json');
      console.log('Customize it with --add/--remove or edit directly.\n');
    }
    return DEFAULT_WATCHLIST;
  }
}

function saveWatchlist(watchlist, configPath) {
  const watchlistPath = configPath || DEFAULT_WATCHLIST_PATH;
  fs.writeFileSync(watchlistPath, JSON.stringify(watchlist, null, 2));
}

function loadBriefingData() {
  return JSON.parse(fs.readFileSync('briefing.json', 'utf8'));
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

function findMatches(briefing, watchlist) {
  const matches = [];
  const allTerms = [
    ...(watchlist.topics || []),
    ...(watchlist.companies || []),
    ...(watchlist.people || []),
    ...(watchlist.regions || [])
  ];

  const searchIn = (text, source, position) => {
    if (!text) return;
    const lowerText = text.toLowerCase();

    allTerms.forEach(term => {
      if (lowerText.includes(term.toLowerCase())) {
        matches.push({
          term,
          source,
          position,
          headline: text
        });
      }
    });
  };

  // NYT
  if (briefing.nyt?.lead?.headline) {
    searchIn(briefing.nyt.lead.headline, 'NYT', 'Lead');
  }
  briefing.nyt?.primary?.forEach((item, i) => {
    searchIn(item.headline, 'NYT', `Primary #${i + 1}`);
  });
  briefing.nyt?.secondary?.forEach((item, i) => {
    searchIn(item.headline, 'NYT', `Secondary #${i + 1}`);
  });

  // Wire services
  Object.entries(briefing.secondary || {}).forEach(([source, items]) => {
    items?.forEach((item, i) => {
      searchIn(item.title, source.toUpperCase(), `#${i + 1}`);
    });
  });

  // International leads
  Object.entries(briefing.internationalLeads || {}).forEach(([source, data]) => {
    if (data?.lead?.headline) {
      searchIn(data.lead.headline, source.toUpperCase(), 'Lead');
    }
    data?.top?.forEach((item, i) => {
      searchIn(item.headline, source.toUpperCase(), `Top #${i + 1}`);
    });
  });

  // Deduplicate by headline
  const seen = new Set();
  return matches.filter(m => {
    const key = m.headline;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function generateWatchlistBrief(matches, watchlist) {
  if (matches.length === 0) {
    return 'No items from your watchlist appeared in today\'s news.';
  }

  // Group matches by term
  const byTerm = {};
  matches.forEach(m => {
    if (!byTerm[m.term]) byTerm[m.term] = [];
    byTerm[m.term].push(m);
  });

  const prompt = `You are a personal news assistant. Based on the user's watchlist, here's what matched in today's news:

WATCHLIST:
- Topics: ${(watchlist.topics || []).join(', ') || 'none'}
- Companies: ${(watchlist.companies || []).join(', ') || 'none'}
- People: ${(watchlist.people || []).join(', ') || 'none'}
- Regions: ${(watchlist.regions || []).join(', ') || 'none'}

MATCHES FOUND:
${Object.entries(byTerm).map(([term, items]) => {
  return `\n**${term}** (${items.length} mentions):\n${items.map(i => `- [${i.source}] ${i.headline}`).join('\n')}`;
}).join('\n')}

TASK: Write a brief personalized update for this user. For each watchlist item that appeared:
1. Summarize what's happening (1-2 sentences)
2. Flag anything that's urgent or significant

Keep it conversational and scannable. Format for terminal output.
Skip any items that didn't match anything in today's news.`;

  return await callClaude(prompt);
}

function showWatchlist(watchlist) {
  console.log('');
  console.log('YOUR WATCHLIST');
  console.log('═'.repeat(40));
  console.log('');

  if (watchlist.topics?.length) {
    console.log('Topics:');
    watchlist.topics.forEach(t => console.log(`  • ${t}`));
    console.log('');
  }

  if (watchlist.companies?.length) {
    console.log('Companies:');
    watchlist.companies.forEach(c => console.log(`  • ${c}`));
    console.log('');
  }

  if (watchlist.people?.length) {
    console.log('People:');
    watchlist.people.forEach(p => console.log(`  • ${p}`));
    console.log('');
  }

  if (watchlist.regions?.length) {
    console.log('Regions:');
    watchlist.regions.forEach(r => console.log(`  • ${r}`));
    console.log('');
  }

  console.log('Edit watchlist.json directly or use --add/--remove');
}

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let configPath = null;
  let addItem = null;
  let removeItem = null;
  let showList = false;

  args.forEach(arg => {
    if (arg.startsWith('--config=')) {
      configPath = arg.split('=')[1];
    } else if (arg.startsWith('--add=')) {
      addItem = arg.split('=')[1];
    } else if (arg === '--add' && args[args.indexOf(arg) + 1]) {
      addItem = args[args.indexOf(arg) + 1];
    } else if (arg.startsWith('--remove=')) {
      removeItem = arg.split('=')[1];
    } else if (arg === '--remove' && args[args.indexOf(arg) + 1]) {
      removeItem = args[args.indexOf(arg) + 1];
    } else if (arg === '--list') {
      showList = true;
    } else if (arg === '--help') {
      console.log('Watchlist - Track topics across news sources');
      console.log('');
      console.log('Usage:');
      console.log('  node watchlist.js                     Run watchlist check');
      console.log('  node watchlist.js --list              Show current watchlist');
      console.log('  node watchlist.js --add "Tesla"       Add to topics');
      console.log('  node watchlist.js --remove "Tesla"    Remove from all lists');
      console.log('  node watchlist.js --config=my.json    Use custom config');
      process.exit(0);
    }
  });

  let watchlist = loadWatchlist(configPath);

  // Handle --add
  if (addItem) {
    if (!watchlist.topics) watchlist.topics = [];
    if (!watchlist.topics.includes(addItem)) {
      watchlist.topics.push(addItem);
      saveWatchlist(watchlist, configPath);
      console.log(`Added "${addItem}" to topics.`);
    } else {
      console.log(`"${addItem}" already in watchlist.`);
    }
    return;
  }

  // Handle --remove
  if (removeItem) {
    let removed = false;
    ['topics', 'companies', 'people', 'regions'].forEach(key => {
      if (watchlist[key]) {
        const idx = watchlist[key].findIndex(
          item => item.toLowerCase() === removeItem.toLowerCase()
        );
        if (idx !== -1) {
          watchlist[key].splice(idx, 1);
          removed = true;
        }
      }
    });

    if (removed) {
      saveWatchlist(watchlist, configPath);
      console.log(`Removed "${removeItem}" from watchlist.`);
    } else {
      console.log(`"${removeItem}" not found in watchlist.`);
    }
    return;
  }

  // Handle --list
  if (showList) {
    showWatchlist(watchlist);
    return;
  }

  // Run watchlist check
  try {
    const briefing = loadBriefingData();
    const matches = findMatches(briefing, watchlist);

    console.log('');
    console.log('WATCHLIST ALERT');
    console.log('═'.repeat(40));
    console.log(`Checking ${Object.values(watchlist).flat().length} items...`);
    console.log(`Found ${matches.length} matches in today's news.`);
    console.log('');

    if (matches.length > 0) {
      // Show raw matches first
      const byTerm = {};
      matches.forEach(m => {
        if (!byTerm[m.term]) byTerm[m.term] = [];
        byTerm[m.term].push(m);
      });

      Object.entries(byTerm).forEach(([term, items]) => {
        console.log(`${term}: ${items.length} mention${items.length > 1 ? 's' : ''}`);
      });

      console.log('');
      console.log('Generating personalized brief...');
      console.log('');

      const brief = await generateWatchlistBrief(matches, watchlist);
      console.log(brief);
    } else {
      console.log('Nothing from your watchlist in today\'s news.');
      console.log('');
      console.log('Your watchlist:');
      Object.entries(watchlist).forEach(([key, items]) => {
        if (items?.length) {
          console.log(`  ${key}: ${items.join(', ')}`);
        }
      });
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
