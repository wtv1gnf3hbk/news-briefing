#!/usr/bin/env node
/**
 * World's Biggest Story - identifies the single most globally significant story
 *
 * How it works:
 * 1. Analyzes headline overlap across all sources (corroboration = importance)
 * 2. Tracks story persistence over time (staying power = significance)
 * 3. Outputs a fun, contextual summary
 *
 * Run: node worlds-biggest-story.js
 * Requires: briefing.json to exist
 */

const fs = require('fs');

const HISTORY_FILE = 'biggest-story-history.json';

// ============================================
// TEXT SIMILARITY
// ============================================

function extractKeywords(text) {
  const stopwords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
    'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'that', 'this',
    'these', 'those', 'it', 'its', 'they', 'them', 'their', 'we', 'us', 'our',
    'you', 'your', 'he', 'him', 'his', 'she', 'her', 'who', 'which', 'what',
    'where', 'when', 'why', 'how', 'all', 'each', 'every', 'both', 'few',
    'more', 'most', 'other', 'some', 'such', 'no', 'not', 'only', 'same',
    'so', 'than', 'too', 'very', 'just', 'also', 'now', 'new', 'says', 'said'
  ]);

  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w));
}

function similarity(text1, text2) {
  const kw1 = new Set(extractKeywords(text1));
  const kw2 = new Set(extractKeywords(text2));
  const intersection = [...kw1].filter(w => kw2.has(w));
  const union = new Set([...kw1, ...kw2]);
  return union.size > 0 ? intersection.length / union.size : 0;
}

// ============================================
// STORY CLUSTERING
// ============================================

function clusterStories(headlines) {
  const clusters = [];
  const THRESHOLD = 0.25; // Similarity threshold for same story

  for (const item of headlines) {
    const text = item.headline || item.title;
    if (!text) continue;

    let foundCluster = false;
    for (const cluster of clusters) {
      const sim = similarity(text, cluster.representative);
      if (sim >= THRESHOLD) {
        cluster.items.push(item);
        cluster.sources.add(item.source);
        foundCluster = true;
        break;
      }
    }

    if (!foundCluster) {
      clusters.push({
        representative: text,
        items: [item],
        sources: new Set([item.source])
      });
    }
  }

  return clusters;
}

function scoreClusters(clusters) {
  return clusters.map(cluster => {
    // Base score: number of sources covering it (corroboration)
    const sourceCount = cluster.sources.size;
    const itemCount = cluster.items.length;

    // Score heavily weighted toward source diversity
    let score = sourceCount * 10 + itemCount * 2;

    // Bonus for truly global coverage (multiple wire services)
    const majorWires = ['Reuters', 'AP', 'BBC World', 'Bloomberg', 'WSJ', 'Al Jazeera'];
    const wireCount = majorWires.filter(w =>
      [...cluster.sources].some(s => s.includes(w.split(' ')[0]))
    ).length;
    if (wireCount >= 3) score += 20;

    // Bonus for NYT prominence
    if (cluster.sources.has('Lead') || cluster.sources.has('Live')) score += 15;
    if (cluster.sources.has('Homepage')) score += 5;

    return {
      ...cluster,
      score,
      sourceCount,
      itemCount
    };
  }).sort((a, b) => b.score - a.score);
}

// ============================================
// HISTORY TRACKING
// ============================================

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return { stories: [], lastUpdated: null };
  }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function updateHistory(topStory, history) {
  const today = new Date().toISOString().split('T')[0];
  const keywords = extractKeywords(topStory.representative).slice(0, 5).join(' ');

  // Check if this story was #1 recently
  let streak = 1;
  for (let i = history.stories.length - 1; i >= 0; i--) {
    const past = history.stories[i];
    if (similarity(past.keywords, keywords) > 0.4) {
      streak = past.streak + 1;
      break;
    }
    // Only look back 7 days
    if (history.stories.length - i > 7) break;
  }

  history.stories.push({
    date: today,
    headline: topStory.representative,
    keywords,
    score: topStory.score,
    sourceCount: topStory.sourceCount,
    streak
  });

  // Keep only last 30 days
  if (history.stories.length > 30) {
    history.stories = history.stories.slice(-30);
  }

  history.lastUpdated = today;
  return streak;
}

// ============================================
// OUTPUT GENERATION
// ============================================

function generateOutput(topStory, streak, sources) {
  const sourceList = [...topStory.sources].slice(0, 5).join(', ');

  let streakText = '';
  if (streak > 1) {
    const dayWord = streak === 2 ? 'day' : 'days';
    streakText = ` (${streak} ${dayWord} running)`;
  }

  let globalText = '';
  if (topStory.sourceCount >= 5) {
    globalText = 'The entire world is watching. ';
  } else if (topStory.sourceCount >= 3) {
    globalText = 'Global attention is focused here. ';
  }

  return {
    headline: topStory.representative,
    streak,
    sourceCount: topStory.sourceCount,
    sources: [...topStory.sources],
    summary: `${globalText}${topStory.sourceCount} major outlets covering this story${streakText}.`,
    items: topStory.items.slice(0, 5)
  };
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log("=".repeat(50));
  console.log("World's Biggest Story");
  console.log(new Date().toISOString());
  console.log("=".repeat(50));

  // Load briefing data
  if (!fs.existsSync('briefing.json')) {
    console.error('briefing.json not found. Run generate-briefing.js first.');
    process.exit(1);
  }

  const briefing = JSON.parse(fs.readFileSync('briefing.json', 'utf8'));

  // Collect all headlines from all sources
  const allHeadlines = [];

  // NYT sources
  if (briefing.nyt.lead) allHeadlines.push(briefing.nyt.lead);
  allHeadlines.push(...briefing.nyt.live);
  allHeadlines.push(...briefing.nyt.primary);
  allHeadlines.push(...briefing.nyt.secondary);

  // Wire services
  for (const [source, items] of Object.entries(briefing.secondary)) {
    if (source === 'timestamp') continue;
    for (const item of items) {
      allHeadlines.push({
        headline: item.title,
        url: item.link,
        source: item.source || source
      });
    }
  }

  console.log(`\nAnalyzing ${allHeadlines.length} headlines...`);

  // Cluster and score
  const clusters = clusterStories(allHeadlines);
  const scored = scoreClusters(clusters);

  console.log(`Found ${clusters.length} distinct story clusters`);

  if (scored.length === 0) {
    console.log('No stories found');
    process.exit(1);
  }

  // Load history and check streak
  const history = loadHistory();
  const topStory = scored[0];
  const streak = updateHistory(topStory, history);
  saveHistory(history);

  // Generate output
  const output = generateOutput(topStory, streak, allHeadlines);

  // Save to file
  fs.writeFileSync('biggest-story.json', JSON.stringify(output, null, 2));

  console.log('\n' + '='.repeat(50));
  console.log("TODAY'S BIGGEST STORY");
  console.log('='.repeat(50));
  console.log(`\n📰 ${output.headline}`);
  console.log(`\n${output.summary}`);
  console.log(`\nSources: ${output.sources.join(', ')}`);

  if (streak > 1) {
    console.log(`\n🔥 This story has dominated headlines for ${streak} consecutive days`);
  }

  // Show runners up
  console.log('\n' + '-'.repeat(50));
  console.log('RUNNERS UP:');
  scored.slice(1, 4).forEach((story, i) => {
    console.log(`${i + 2}. ${story.representative} (${story.sourceCount} sources)`);
  });

  console.log('\n✅ Saved to biggest-story.json');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
