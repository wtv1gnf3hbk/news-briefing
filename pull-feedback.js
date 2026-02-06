#!/usr/bin/env node
/**
 * pull-feedback.js - Pulls pending human feedback from Cloudflare Worker KV
 * into briefing-history.json, then clears the pending queue.
 *
 * Called by GitHub Actions before write-briefing.js so feedback
 * from the webpage is available for prompt injection.
 *
 * Requires: FEEDBACK_WORKER_URL and FEEDBACK_TOKEN env vars
 */

const https = require('https');
const fs = require('fs');

const WORKER_BASE = process.env.FEEDBACK_WORKER_URL || 'https://briefing-refresh.adampasick.workers.dev';
const FEEDBACK_TOKEN = process.env.FEEDBACK_TOKEN;
const HISTORY_FILE = 'briefing-history.json';

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const mod = parsedUrl.protocol === 'https:' ? https : require('http');

    mod.get(url, { headers: { 'User-Agent': 'briefing-pull-feedback' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Bad JSON: ' + data.slice(0, 200)));
        }
      });
    }).on('error', reject);
  });
}

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

async function main() {
  if (!FEEDBACK_TOKEN) {
    console.log('No FEEDBACK_TOKEN set, skipping feedback pull');
    return;
  }

  console.log('Pulling pending feedback from worker...');

  try {
    const result = await fetchJSON(`${WORKER_BASE}/feedback/latest?token=${FEEDBACK_TOKEN}`);

    if (!result.success || !result.feedback) {
      console.log('No pending feedback');
      return;
    }

    const pending = result.feedback;
    const dates = Object.keys(pending);

    if (dates.length === 0) {
      console.log('No pending feedback');
      return;
    }

    console.log(`Found feedback for ${dates.length} date(s): ${dates.join(', ')}`);

    const history = loadHistory();

    for (const date of dates) {
      const fb = pending[date];
      let entry = history.find(e => e.date === date);
      if (!entry) {
        entry = { date, auto_scores: null, human_feedback: null };
        history.push(entry);
      }
      entry.human_feedback = {
        score: fb.score,
        notes: fb.notes || '',
        recorded_at: fb.recorded_at,
        source: 'web'
      };
      console.log(`  ${date}: ${fb.score}/5 ${fb.notes ? '"' + fb.notes.slice(0, 50) + '"' : ''}`);
    }

    // Sort by date
    history.sort((a, b) => a.date.localeCompare(b.date));
    saveHistory(history);
    console.log(`Updated ${HISTORY_FILE}`);

    // Clear pending queue
    await fetchJSON(`${WORKER_BASE}/feedback/clear?token=${FEEDBACK_TOKEN}`);
    console.log('Cleared pending feedback queue');

  } catch (e) {
    console.error(`Failed to pull feedback: ${e.message}`);
    // Non-fatal - continue with pipeline
  }
}

main();
