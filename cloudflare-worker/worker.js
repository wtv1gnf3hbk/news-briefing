/**
 * Cloudflare Worker to proxy GitHub Actions workflow dispatch
 *
 * Deploy with:
 *   npx wrangler deploy
 *
 * Set the secret:
 *   npx wrangler secret put GITHUB_TOKEN
 */

const GITHUB_REPO = 'wtv1gnf3hbk/news-briefing';
const WORKFLOW_FILE = 'briefing.yml';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Shared helper: trigger the GitHub Actions workflow
async function triggerWorkflow(env) {
  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'news-briefing-worker'
      },
      body: JSON.stringify({ ref: 'main' })
    }
  );
  return response;
}

export default {
  // HTTP handler (refresh button, status checks)
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // POST /trigger - Trigger the workflow
      if (path === '/trigger' && request.method === 'POST') {
        const response = await triggerWorkflow(env);

        if (!response.ok) {
          const text = await response.text();
          return new Response(JSON.stringify({ error: 'Failed to trigger workflow', details: text }), {
            status: response.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // GET /runs - Get latest workflow run
      if (path === '/runs' && request.method === 'GET') {
        const response = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1`,
          {
            headers: {
              'Accept': 'application/vnd.github+json',
              'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'news-briefing-worker'
            }
          }
        );
        const data = await response.json();
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // GET /status/:runId - Get run status
      if (path.startsWith('/status/') && request.method === 'GET') {
        const runId = path.split('/')[2];
        const response = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/actions/runs/${runId}`,
          {
            headers: {
              'Accept': 'application/vnd.github+json',
              'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'news-briefing-worker'
            }
          }
        );
        const data = await response.json();
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Health check
      if (path === '/' || path === '/health') {
        return new Response(JSON.stringify({ status: 'ok', repo: GITHUB_REPO }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response('Not found', { status: 404, headers: corsHeaders });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  },

  // Cron handler — Cloudflare calls this on schedule
  async scheduled(event, env, ctx) {
    const response = await triggerWorkflow(env);
    if (!response.ok) {
      const text = await response.text();
      console.error(`Cron trigger failed: ${response.status} ${text}`);
    } else {
      console.log(`Cron trigger succeeded for ${GITHUB_REPO}`);
    }
  }
};
