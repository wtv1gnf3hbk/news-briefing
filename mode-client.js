#!/usr/bin/env node
/**
 * Mode Analytics API Client
 *
 * Fetches report data from Mode for newsletter analytics.
 *
 * Setup:
 * 1. Create API token at: Mode → Workspace Settings → Features → API Keys
 * 2. Set environment variables:
 *    export MODE_TOKEN="your-token"
 *    export MODE_SECRET="your-secret"
 *    export MODE_WORKSPACE="nytimes"
 *
 * Usage:
 *    node mode-client.js                     # Fetch default report
 *    node mode-client.js <report_token>      # Fetch specific report
 *
 * Report URL format: https://app.mode.com/nytimes/reports/935f63aaed8f
 *                    The report_token is: 935f63aaed8f
 */

const https = require('https');
const fs = require('fs');

// Configuration
const MODE_TOKEN = process.env.MODE_TOKEN;
const MODE_SECRET = process.env.MODE_SECRET;
const MODE_WORKSPACE = process.env.MODE_WORKSPACE || 'nytimes';

// Default report (The World newsletter analytics)
const DEFAULT_REPORT = '935f63aaed8f';

// ============================================
// API UTILITIES
// ============================================

function modeRequest(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    if (!MODE_TOKEN || !MODE_SECRET) {
      reject(new Error('Missing MODE_TOKEN or MODE_SECRET environment variables'));
      return;
    }

    const auth = Buffer.from(`${MODE_TOKEN}:${MODE_SECRET}`).toString('base64');

    const options = {
      hostname: 'app.mode.com',
      path: `/api/${MODE_WORKSPACE}${path}`,
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 401) {
          reject(new Error('Authentication failed - check MODE_TOKEN and MODE_SECRET'));
        } else if (res.statusCode === 404) {
          reject(new Error(`Not found: ${path}`));
        } else if (res.statusCode >= 400) {
          reject(new Error(`API error ${res.statusCode}: ${data}`));
        } else {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data); // Return raw if not JSON
          }
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

function modeRequestCSV(path) {
  return new Promise((resolve, reject) => {
    if (!MODE_TOKEN || !MODE_SECRET) {
      reject(new Error('Missing MODE_TOKEN or MODE_SECRET environment variables'));
      return;
    }

    const auth = Buffer.from(`${MODE_TOKEN}:${MODE_SECRET}`).toString('base64');

    const options = {
      hostname: 'app.mode.com',
      path: `/api/${MODE_WORKSPACE}${path}`,
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'text/csv'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`API error ${res.statusCode}`));
        } else {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

// ============================================
// REPORT FUNCTIONS
// ============================================

async function getReportInfo(reportToken) {
  console.log(`Fetching report info: ${reportToken}`);
  return await modeRequest(`/reports/${reportToken}`);
}

async function getLatestRun(reportToken) {
  console.log(`Fetching latest run for report: ${reportToken}`);
  const runs = await modeRequest(`/reports/${reportToken}/runs`);

  if (!runs._embedded || !runs._embedded.report_runs || runs._embedded.report_runs.length === 0) {
    throw new Error('No runs found for this report');
  }

  return runs._embedded.report_runs[0];
}

async function getRunResults(reportToken, runToken, format = 'json') {
  console.log(`Fetching results for run: ${runToken}`);
  const ext = format === 'csv' ? 'csv' : 'json';

  if (format === 'csv') {
    return await modeRequestCSV(`/reports/${reportToken}/runs/${runToken}/results/content.csv`);
  } else {
    return await modeRequest(`/reports/${reportToken}/runs/${runToken}/results/content.json`);
  }
}

async function getQueryResults(reportToken, runToken, queryRunToken, format = 'json') {
  console.log(`Fetching query results: ${queryRunToken}`);
  const ext = format === 'csv' ? 'csv' : 'json';
  const path = `/reports/${reportToken}/runs/${runToken}/query_runs/${queryRunToken}/results/content.${ext}`;

  if (format === 'csv') {
    return await modeRequestCSV(path);
  } else {
    return await modeRequest(path);
  }
}

async function listQueries(reportToken, runToken) {
  console.log(`Listing queries for run: ${runToken}`);
  const run = await modeRequest(`/reports/${reportToken}/runs/${runToken}`);

  if (!run._embedded || !run._embedded.query_runs) {
    return [];
  }

  return run._embedded.query_runs.map(qr => ({
    token: qr.token,
    query_token: qr.query_token,
    state: qr.state,
    created_at: qr.created_at
  }));
}

// ============================================
// MAIN
// ============================================

async function main() {
  const reportToken = process.argv[2] || DEFAULT_REPORT;

  console.log('='.repeat(50));
  console.log('Mode Analytics Client');
  console.log('='.repeat(50));
  console.log(`Workspace: ${MODE_WORKSPACE}`);
  console.log(`Report: ${reportToken}`);
  console.log('');

  try {
    // Get report metadata
    const report = await getReportInfo(reportToken);
    console.log(`Report Name: ${report.name}`);
    console.log(`Description: ${report.description || '(none)'}`);
    console.log(`Created: ${report.created_at}`);
    console.log(`Last Run: ${report.last_run_at || 'Never'}`);
    console.log('');

    // Get latest run
    const latestRun = await getLatestRun(reportToken);
    console.log(`Latest Run Token: ${latestRun.token}`);
    console.log(`Run State: ${latestRun.state}`);
    console.log(`Run Created: ${latestRun.created_at}`);
    console.log('');

    if (latestRun.state !== 'succeeded') {
      console.log('⚠️  Latest run did not succeed, cannot fetch results');
      return;
    }

    // List queries in the report
    const queries = await listQueries(reportToken, latestRun.token);
    console.log(`Queries in Report: ${queries.length}`);
    queries.forEach((q, i) => {
      console.log(`  ${i + 1}. ${q.token} (state: ${q.state})`);
    });
    console.log('');

    // Fetch first query results as sample
    if (queries.length > 0) {
      const firstQuery = queries[0];
      console.log('Fetching first query results...');
      const results = await getQueryResults(reportToken, latestRun.token, firstQuery.token, 'json');

      // Save to file
      const outputFile = `mode-data-${reportToken}.json`;
      fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
      console.log(`✅ Saved to ${outputFile}`);

      // Show preview
      if (Array.isArray(results) && results.length > 0) {
        console.log(`\nPreview (${results.length} rows):`);
        console.log(JSON.stringify(results.slice(0, 3), null, 2));
      }
    }

    console.log('\n✅ Done');

  } catch (err) {
    console.error('❌ Error:', err.message);

    if (err.message.includes('MODE_TOKEN')) {
      console.log('\nSetup required:');
      console.log('  export MODE_TOKEN="your-token"');
      console.log('  export MODE_SECRET="your-secret"');
      console.log('\nGet your token at:');
      console.log('  Mode → Workspace Settings → Features → API Keys');
    }

    process.exit(1);
  }
}

module.exports = {
  modeRequest,
  getReportInfo,
  getLatestRun,
  getRunResults,
  getQueryResults,
  listQueries
};

// Run if called directly
if (require.main === module) {
  main();
}
