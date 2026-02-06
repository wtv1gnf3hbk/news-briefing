#!/usr/bin/env node
/**
 * evaluate-briefing.js - Evaluates briefing quality and records human feedback
 *
 * Automated evaluation (3 layers):
 *   node evaluate-briefing.js
 *
 * Record human feedback:
 *   node evaluate-briefing.js feedback 4 "lead was great, AW bullets too terse"
 *   node evaluate-briefing.js feedback          (interactive prompts)
 *
 * View recent history:
 *   node evaluate-briefing.js history
 */

const https = require('https');
const fs = require('fs');
const readline = require('readline');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const HISTORY_FILE = 'briefing-history.json';

// ============================================
// HISTORY MANAGEMENT
// ============================================

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function getTodayEntry(history) {
  const today = new Date().toISOString().split('T')[0];
  let entry = history.find(e => e.date === today);
  if (!entry) {
    entry = { date: today, auto_scores: null, human_feedback: null };
    history.push(entry);
  }
  return entry;
}

// ============================================
// LAYER 1: STRUCTURAL CHECKS
// ============================================

// -ing words that are commonly nouns/adjectives, not verb forms
const NOUN_ING_WORDS = new Set([
  'building', 'morning', 'evening', 'mining', 'shipping', 'housing',
  'funding', 'training', 'meeting', 'feeling', 'opening', 'landing',
  'wedding', 'ceiling', 'rating', 'setting', 'standing', 'understanding',
  'offering', 'filing', 'holding', 'listing', 'trading', 'lending',
  'parking', 'warning', 'king', 'ring', 'string', 'thing', 'wing',
  'spring', 'swing', 'bring', 'sing', 'sting', 'cling', 'fling',
  'clothing', 'pricing', 'nothing', 'something', 'everything', 'anything',
]);

function runStructuralChecks(briefingText) {
  const checks = [];

  // 1. Opens with greeting
  checks.push({
    name: 'greeting',
    pass: briefingText.startsWith("Good morning. Here's the state of play:"),
    detail: 'Must start with "Good morning. Here\'s the state of play:"'
  });

  // 2. Has Business/Tech section
  checks.push({
    name: 'business_tech_section',
    pass: briefingText.includes('**Business/Tech**'),
    detail: 'Must have **Business/Tech** section'
  });

  // 3. Has Around the World section
  checks.push({
    name: 'around_the_world_section',
    pass: briefingText.includes('**Around the World**'),
    detail: 'Must have **Around the World** section'
  });

  // 4. Regional bullets
  const regions = ['Latin America', 'Europe', 'Asia', 'Middle East', 'Africa'];
  const missingRegions = regions.filter(r => !briefingText.includes(`**${r}**`));
  checks.push({
    name: 'regional_bullets',
    pass: missingRegions.length === 0,
    detail: missingRegions.length > 0
      ? `Missing regions: ${missingRegions.join(', ')}`
      : 'All 5 regions present'
  });

  // 5. Every bullet has at least one link
  const bulletLines = briefingText.split('\n').filter(l =>
    l.trim().startsWith('\u2022') || l.trim().match(/^[-•]\s/)
  );
  const bulletsWithoutLinks = bulletLines.filter(l => !l.match(/\[([^\]]+)\]\(([^)]+)\)/));
  checks.push({
    name: 'bullet_links',
    pass: bulletsWithoutLinks.length === 0,
    detail: bulletsWithoutLinks.length > 0
      ? `${bulletsWithoutLinks.length} bullet(s) missing links`
      : `All ${bulletLines.length} bullets have links`
  });

  // 6. Link text <= 3 words
  const linkTexts = [...briefingText.matchAll(/\[([^\]]+)\]\(/g)].map(m => m[1]);
  const longLinkTexts = linkTexts.filter(t => t.split(/\s+/).length > 3);
  checks.push({
    name: 'link_text_length',
    pass: longLinkTexts.length === 0,
    detail: longLinkTexts.length > 0
      ? `${longLinkTexts.length} link(s) >3 words: "${longLinkTexts[0]}"`
      : `All ${linkTexts.length} link texts \u22643 words`
  });

  // 7. No "'s" contraction for "is" on proper nouns/names (detect Name's + gerund)
  // "it's", "that's", "there's", "here's", "what's", "who's" are fine - standard contractions
  const PRONOUN_CONTRACTIONS = new Set([
    "it's", "that's", "there's", "here's", "what's", "who's",
    "he's", "she's", "this's", "which's", "where's", "how's",
    "everyone's", "everything's", "something's", "nothing's",
    "one's", "let's",
  ]);
  const isContractionMatches = [...briefingText.matchAll(/(\w+)'s\s+(\w+ing)\b/gi)]
    .filter(m => !NOUN_ING_WORDS.has(m[2].toLowerCase()))
    .filter(m => !PRONOUN_CONTRACTIONS.has(m[0].split(/\s/)[0].toLowerCase()));
  checks.push({
    name: 'no_is_contraction',
    pass: isContractionMatches.length === 0,
    detail: isContractionMatches.length > 0
      ? `Found 's-as-is: "${isContractionMatches[0][0]}"`
      : "No 's-as-is contractions found"
  });

  // 8. No "amid"
  const amidMatch = briefingText.match(/\bamid\b/gi);
  checks.push({
    name: 'no_amid',
    pass: !amidMatch,
    detail: amidMatch ? 'Found "amid" in text' : 'No "amid" found'
  });

  // 9. No em-dash joining clauses
  const emDashCount = (briefingText.match(/\u2014/g) || []).length;
  checks.push({
    name: 'no_em_dash',
    pass: emDashCount === 0,
    detail: emDashCount > 0 ? `Found ${emDashCount} em-dash(es)` : 'No em-dashes found'
  });

  // 10. Word count in range
  const wordCount = briefingText.split(/\s+/).filter(w => w.length > 0).length;
  checks.push({
    name: 'word_count',
    pass: wordCount >= 300 && wordCount <= 900,
    detail: `${wordCount} words (target: 300-900)`
  });

  const allPass = checks.every(c => c.pass);
  const failures = checks.filter(c => !c.pass);

  return { allPass, checks, failures, wordCount };
}

// ============================================
// LAYER 2: SOURCE INTEGRITY CHECKS
// ============================================

function runSourceIntegrityChecks(briefingText, briefingJson) {
  const checks = [];

  // Extract all URLs from briefing.md
  const mdUrls = [...briefingText.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map(m => m[2]);

  // Extract all URLs from briefing.json (recursive)
  const jsonUrls = new Set();
  function extractUrls(obj) {
    if (!obj) return;
    if (typeof obj === 'string' && (obj.startsWith('http://') || obj.startsWith('https://'))) {
      jsonUrls.add(obj);
    }
    if (typeof obj === 'object') {
      if (obj.url) jsonUrls.add(obj.url);
      if (obj.link) jsonUrls.add(obj.link);
      if (Array.isArray(obj)) obj.forEach(extractUrls);
      else Object.values(obj).forEach(extractUrls);
    }
  }
  extractUrls(briefingJson);

  // 1. All URLs exist in source data
  const unknownUrls = mdUrls.filter(u => !jsonUrls.has(u));
  checks.push({
    name: 'urls_from_source',
    pass: unknownUrls.length === 0,
    detail: unknownUrls.length > 0
      ? `${unknownUrls.length} URL(s) not in briefing.json`
      : `All ${mdUrls.length} URLs verified in source data`
  });

  // 2. Link count in range
  checks.push({
    name: 'link_count',
    pass: mdUrls.length >= 6 && mdUrls.length <= 25,
    detail: `${mdUrls.length} links (target: 6-25)`
  });

  // 3. Source attribution variety
  const attributionPatterns = [
    { name: 'Reuters', pattern: /reuters\s+(reports?|says?|notes?)/i },
    { name: 'Bloomberg', pattern: /bloomberg\s+(reports?|says?|notes?)/i },
    { name: 'BBC', pattern: /(bbc|guardian)\s+(reports?|notes?|says?)/i },
    { name: 'according_to', pattern: /according\s+to\s+\w+/i },
    { name: 'per_X', pattern: /per\s+(ap|reuters|bloomberg|bbc|the\s+\w+)/i },
  ];
  const usedAttributions = attributionPatterns.filter(p => p.pattern.test(briefingText));
  checks.push({
    name: 'attribution_variety',
    pass: usedAttributions.length >= 1,
    detail: `${usedAttributions.length} attribution pattern(s): ${usedAttributions.map(a => a.name).join(', ') || 'none'}`
  });

  // 4. Non-NYT sources referenced
  const hasNonNYT = /\b(reuters|bloomberg|bbc|guardian|ap\b|al jazeera|economist)/i.test(briefingText);
  checks.push({
    name: 'non_nyt_sources',
    pass: hasNonNYT,
    detail: hasNonNYT ? 'References non-NYT sources' : 'Only NYT sources referenced'
  });

  const allPass = checks.every(c => c.pass);
  const failures = checks.filter(c => !c.pass);

  return { allPass, checks, failures };
}

// ============================================
// LAYER 3: LLM JUDGE
// ============================================

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
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
          reject(new Error('Failed to parse API response: ' + data.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('API timeout'));
    });
    req.write(body);
    req.end();
  });
}

async function runLLMJudge(briefingText, briefingJson) {
  // Build condensed summary of what was available
  const nytLead = briefingJson.nyt?.lead?.headline || 'none';
  const primaryCount = briefingJson.nyt?.primary?.length || 0;
  const secondaryCount = briefingJson.nyt?.secondary?.length || 0;
  const rssSourceCount = Object.keys(briefingJson.secondary || {})
    .filter(k => k !== 'timestamp').length;

  const intlLeads = {};
  ['bbc', 'guardian', 'economist', 'aljazeera', 'reuters'].forEach(src => {
    const lead = briefingJson.internationalLeads?.[src]?.lead;
    if (lead) intlLeads[src] = lead.headline;
  });

  // List some of the top available stories for the judge to compare against
  const availableStories = [];
  if (briefingJson.nyt?.primary) {
    availableStories.push(...briefingJson.nyt.primary.slice(0, 6).map(h =>
      `[NYT] ${h.headline}`
    ));
  }
  if (briefingJson.nyt?.secondary) {
    availableStories.push(...briefingJson.nyt.secondary.slice(0, 8).map(h =>
      `[NYT ${h.source}] ${h.headline}`
    ));
  }
  ['reuters', 'ap', 'bbc', 'bloomberg'].forEach(src => {
    const items = briefingJson.secondary?.[src] || [];
    items.slice(0, 2).forEach(item => {
      availableStories.push(`[${src.toUpperCase()}] ${item.title || item.headline || ''}`);
    });
  });

  const prompt = `You are a senior editor evaluating a morning news briefing. The briefing is written for an NYT journalist who covers international news ("The World" newsletter).

Score it on these 6 dimensions (1-5 each). Be honest and critical.

1. STORY SELECTION: Given the available stories, did the briefing pick the most important ones? Did it miss anything obviously significant?
2. SYNTHESIS: Does it connect stories across sources and provide context, or just restate headlines?
3. GLOBAL BALANCE: Does it give proportional coverage to the world, not just US news?
4. CONVERSATIONAL TONE: Does it sound like a knowledgeable colleague chatting over coffee? Is the writing alive, or does it read like a wire service?
5. INFORMATION DENSITY: Is every sentence earning its place? No filler, no padding, no vague hand-waving?
6. LEAD QUALITY: Does the opening draw you in and set stakes, or does it just state what happened?

WHAT WAS AVAILABLE TO WRITE FROM:
- NYT lead: "${nytLead}"
- ${primaryCount} primary NYT headlines, ${secondaryCount} regional/secondary NYT stories
- ${rssSourceCount} wire service feeds (Reuters, AP, BBC, Bloomberg, etc.)
- International leads: ${JSON.stringify(intlLeads)}
- Top available stories:
${availableStories.slice(0, 20).map(s => '  ' + s).join('\n')}

BRIEFING TO EVALUATE:
${briefingText}

Respond in EXACTLY this JSON format, no other text:
{
  "story_selection": {"score": N, "note": "one sentence"},
  "synthesis": {"score": N, "note": "one sentence"},
  "global_balance": {"score": N, "note": "one sentence"},
  "conversational_tone": {"score": N, "note": "one sentence"},
  "information_density": {"score": N, "note": "one sentence"},
  "lead_quality": {"score": N, "note": "one sentence"},
  "total": N,
  "feedback": "2-3 sentences of specific, actionable feedback for the writer to improve next time"
}`;

  const response = await callClaude(prompt);

  // Parse JSON (handle possible markdown code blocks)
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Judge did not return valid JSON');

  const scores = JSON.parse(jsonMatch[0]);

  // Validate structure
  const dims = ['story_selection', 'synthesis', 'global_balance',
    'conversational_tone', 'information_density', 'lead_quality'];
  for (const d of dims) {
    if (!scores[d]?.score) throw new Error(`Missing dimension: ${d}`);
  }

  // Recalculate total to be safe
  scores.total = dims.reduce((sum, d) => sum + scores[d].score, 0);

  return scores;
}

// ============================================
// HUMAN FEEDBACK
// ============================================

async function recordFeedback(args) {
  const history = loadHistory();
  const entry = getTodayEntry(history);

  // Check if briefing exists
  if (!fs.existsSync('briefing.md')) {
    console.error('No briefing.md found. Generate a briefing first.');
    process.exit(1);
  }

  if (args.length >= 1 && !isNaN(args[0])) {
    // Direct mode: feedback <score> [notes...]
    entry.human_feedback = {
      score: parseInt(args[0]),
      notes: args.slice(1).join(' ') || '',
      recorded_at: new Date().toISOString()
    };
    saveHistory(history);
    console.log(`Saved feedback for ${entry.date}: ${args[0]}/5`);
    if (args.length > 1) console.log(`Notes: ${args.slice(1).join(' ')}`);
    return;
  }

  // Interactive mode
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  console.log('\n=== RECORD FEEDBACK ===');
  console.log(`Date: ${entry.date}\n`);

  // Show a snippet of the briefing for reference
  try {
    const briefing = fs.readFileSync('briefing.md', 'utf8');
    const preview = briefing.split('\n').slice(0, 5).join('\n');
    console.log('--- Briefing preview ---');
    console.log(preview);
    console.log('---\n');
  } catch {}

  const score = await ask('Score (1-5): ');
  const notes = await ask('Notes (what stood out, good or bad): ');
  const keep = await ask('What to keep doing (enter to skip): ');
  const fix = await ask('What to fix (enter to skip): ');
  rl.close();

  entry.human_feedback = {
    score: parseInt(score) || 3,
    notes: notes || '',
    keep: keep || null,
    fix: fix || null,
    recorded_at: new Date().toISOString()
  };

  saveHistory(history);
  console.log(`\nSaved feedback for ${entry.date}: ${entry.human_feedback.score}/5`);
}

// ============================================
// SHOW HISTORY
// ============================================

function showHistory() {
  const history = loadHistory();

  if (history.length === 0) {
    console.log('No history yet.');
    return;
  }

  console.log('=== BRIEFING HISTORY ===\n');

  // Show last 10 entries
  const recent = history.slice(-10);
  for (const entry of recent) {
    const auto = entry.auto_scores;
    const human = entry.human_feedback;

    let line = entry.date;

    if (auto?.total) {
      line += `  | auto: ${auto.total}/30`;
    }
    if (human?.score) {
      line += `  | human: ${human.score}/5`;
    }
    if (human?.notes) {
      line += `  | "${human.notes.slice(0, 60)}"`;
    }

    console.log(line);

    // Show judge feedback if present
    if (auto?.feedback) {
      console.log(`    judge: ${auto.feedback.slice(0, 80)}`);
    }
    if (human?.fix) {
      console.log(`    fix: ${human.fix}`);
    }
  }

  // Show averages
  const withAuto = history.filter(e => e.auto_scores?.total);
  const withHuman = history.filter(e => e.human_feedback?.score);

  if (withAuto.length > 0) {
    const avgAuto = withAuto.reduce((s, e) => s + e.auto_scores.total, 0) / withAuto.length;
    console.log(`\nAvg auto score: ${avgAuto.toFixed(1)}/30 (${withAuto.length} days)`);
  }
  if (withHuman.length > 0) {
    const avgHuman = withHuman.reduce((s, e) => s + e.human_feedback.score, 0) / withHuman.length;
    console.log(`Avg human score: ${avgHuman.toFixed(1)}/5 (${withHuman.length} days)`);
  }
}

// ============================================
// MAIN: AUTO EVALUATION
// ============================================

async function runEvaluation() {
  console.log('=== BRIEFING EVALUATION ===\n');

  // Load files
  let briefingText, briefingJson;
  try {
    briefingText = fs.readFileSync('briefing.md', 'utf8');
  } catch {
    console.error('Cannot read briefing.md');
    process.exit(1);
  }
  try {
    briefingJson = JSON.parse(fs.readFileSync('briefing.json', 'utf8'));
  } catch {
    console.error('Cannot read briefing.json');
    process.exit(1);
  }

  // Layer 1: Structural checks
  console.log('--- Structural Checks ---');
  const structural = runStructuralChecks(briefingText);
  structural.checks.forEach(c => {
    console.log(`  ${c.pass ? '\u2713' : '\u2717'} ${c.name}: ${c.detail}`);
  });
  console.log(`  Result: ${structural.allPass ? 'PASS' : 'FAIL'}\n`);

  // Layer 2: Source integrity
  console.log('--- Source Integrity ---');
  const integrity = runSourceIntegrityChecks(briefingText, briefingJson);
  integrity.checks.forEach(c => {
    console.log(`  ${c.pass ? '\u2713' : '\u2717'} ${c.name}: ${c.detail}`);
  });
  console.log(`  Result: ${integrity.allPass ? 'PASS' : 'FAIL'}\n`);

  // Layer 3: LLM judge
  let judgeScores = null;
  if (ANTHROPIC_API_KEY) {
    console.log('--- Editorial Quality (LLM Judge) ---');
    try {
      judgeScores = await runLLMJudge(briefingText, briefingJson);
      const dims = ['story_selection', 'synthesis', 'global_balance',
        'conversational_tone', 'information_density', 'lead_quality'];
      dims.forEach(d => {
        const s = judgeScores[d];
        console.log(`  ${s.score}/5 ${d}: ${s.note}`);
      });
      console.log(`\n  TOTAL: ${judgeScores.total}/30`);
      console.log(`  Feedback: ${judgeScores.feedback}`);
    } catch (e) {
      console.error(`  LLM judge failed: ${e.message}`);
    }
  } else {
    console.log('--- Skipping LLM judge (no ANTHROPIC_API_KEY) ---');
  }

  // Save to history
  const history = loadHistory();
  const entry = getTodayEntry(history);
  entry.auto_scores = {
    structural_pass: structural.allPass,
    structural_failures: structural.failures.map(f => f.name),
    source_integrity_pass: integrity.allPass,
    source_integrity_failures: integrity.failures.map(f => f.name),
    word_count: structural.wordCount,
    ...(judgeScores || {}),
    evaluated_at: new Date().toISOString()
  };
  saveHistory(history);

  console.log(`\nSaved to ${HISTORY_FILE}`);

  // Determine pass/fail
  const overallPass = structural.allPass && integrity.allPass &&
    (!judgeScores || judgeScores.total >= 22);

  if (!overallPass) {
    console.log('\nEVALUATION: NEEDS IMPROVEMENT');
    if (structural.failures.length > 0) {
      console.log(`  Structural: ${structural.failures.map(f => f.name).join(', ')}`);
    }
    if (integrity.failures.length > 0) {
      console.log(`  Integrity: ${integrity.failures.map(f => f.name).join(', ')}`);
    }
    if (judgeScores && judgeScores.total < 22) {
      console.log(`  Quality: ${judgeScores.total}/30 (threshold: 22)`);
      console.log(`  ${judgeScores.feedback}`);
    }
    process.exit(1);
  } else {
    console.log('\nEVALUATION: PASS');
    if (judgeScores) {
      console.log(`  Quality score: ${judgeScores.total}/30`);
    }
  }
}

// ============================================
// EXPORTS (for use by write-briefing.js)
// ============================================

module.exports = { runStructuralChecks, runSourceIntegrityChecks, loadHistory };

// ============================================
// CLI ENTRY POINT
// ============================================

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === 'feedback') {
    await recordFeedback(args.slice(1));
  } else if (args[0] === 'history') {
    showHistory();
  } else {
    await runEvaluation();
  }
}

// Only run CLI if this is the main script (not required as module)
if (require.main === module) {
  main();
}
