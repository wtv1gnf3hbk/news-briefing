/**
 * Cloudflare Worker: briefing-refresh.adampasick.workers.dev
 *
 * Routes:
 *   GET /refresh          - Trigger GitHub Actions workflow
 *   GET /feedback?score=N&date=YYYY-MM-DD&notes=...  - Store feedback
 *   GET /feedback/latest  - Retrieve all pending feedback (called by GitHub Action)
 *   GET /feedback/clear   - Clear pending feedback after pull (called by GitHub Action)
 *
 * KV namespace "FEEDBACK" stores entries keyed by date.
 * GitHub Action pulls pending feedback into briefing-history.json daily.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ---- /refresh (existing) ----
    if (url.pathname === '/refresh') {
      return handleRefresh(env);
    }

    // ---- /feedback (store) ----
    if (url.pathname === '/feedback' && url.searchParams.has('score')) {
      return handleFeedback(url.searchParams, env);
    }

    // ---- /feedback/latest (pull pending feedback) ----
    if (url.pathname === '/feedback/latest') {
      return handleFeedbackLatest(env, url.searchParams.get('token'), request);
    }

    // ---- /feedback/clear (clear after pull) ----
    if (url.pathname === '/feedback/clear') {
      return handleFeedbackClear(env, url.searchParams.get('token'), request);
    }

    return json({ error: 'not found' }, 404);
  },
};

// ============================================
// /refresh - trigger GitHub Actions
// ============================================

async function handleRefresh(env) {
  try {
    const token = env.GITHUB_TOKEN;
    const repo = env.GITHUB_REPO || 'adampasick/news-briefing';

    if (!token) {
      return json({ success: false, error: 'GITHUB_TOKEN not configured' }, 500);
    }

    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/briefing.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'briefing-refresh-worker',
          Accept: 'application/vnd.github.v3+json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );

    if (res.status === 204) {
      return json({ success: true });
    }
    const body = await res.text();
    return json({ success: false, status: res.status, body }, 500);
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
}

// ============================================
// /feedback?score=N&date=YYYY-MM-DD&notes=...
// ============================================

async function handleFeedback(params, env) {
  const score = parseInt(params.get('score'));
  const date = params.get('date') || new Date().toISOString().split('T')[0];
  const notes = params.get('notes') || '';

  if (!score || score < 1 || score > 5) {
    return json({ success: false, error: 'score must be 1-5' }, 400);
  }

  const entry = {
    score,
    notes,
    recorded_at: new Date().toISOString(),
  };

  // Store in KV keyed by date (overwrites if same date)
  await env.FEEDBACK.put(`feedback:${date}`, JSON.stringify(entry));

  // Also add to the pending list for GitHub Action to pull
  const pendingRaw = await env.FEEDBACK.get('pending');
  const pending = pendingRaw ? JSON.parse(pendingRaw) : {};
  pending[date] = entry;
  await env.FEEDBACK.put('pending', JSON.stringify(pending));

  return json({ success: true, date, score });
}

// ============================================
// /feedback/latest - return pending feedback
// ============================================

async function handleFeedbackLatest(env, token) {
  // Simple token auth to prevent public access to feedback data
  if (token !== env.FEEDBACK_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }

  const pendingRaw = await env.FEEDBACK.get('pending');
  const pending = pendingRaw ? JSON.parse(pendingRaw) : {};

  return json({ success: true, feedback: pending });
}

// ============================================
// /feedback/clear - clear pending after pull
// ============================================

async function handleFeedbackClear(env, token) {
  if (token !== env.FEEDBACK_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }

  await env.FEEDBACK.put('pending', JSON.stringify({}));

  return json({ success: true });
}
