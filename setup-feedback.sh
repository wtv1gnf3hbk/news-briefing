#!/bin/bash
# setup-feedback.sh - One-time setup for the feedback system
#
# Run this once:
#   1. Log into Cloudflare: npx wrangler login
#   2. Then: bash setup-feedback.sh
#
# It will:
#   - Create KV namespace
#   - Generate a FEEDBACK_TOKEN
#   - Deploy the worker with secrets
#   - Set the GitHub secret (requires gh CLI auth)

set -e
cd "$(dirname "$0")"

echo "=== Feedback System Setup ==="
echo ""

# ---- Step 1: Check wrangler auth ----
echo "Checking Cloudflare auth..."
if ! npx wrangler whoami 2>/dev/null | grep -q "Account"; then
  echo "Not logged into Cloudflare. Running wrangler login..."
  npx wrangler login
fi
echo "Authenticated."
echo ""

# ---- Step 2: Create KV namespace ----
echo "Creating KV namespace..."
KV_OUTPUT=$(npx wrangler kv namespace create FEEDBACK 2>&1)
echo "$KV_OUTPUT"

# Extract the namespace ID
KV_ID=$(echo "$KV_OUTPUT" | grep -oP 'id = "\K[^"]+')
if [ -z "$KV_ID" ]; then
  # Maybe it already exists - try listing
  echo "Checking existing namespaces..."
  KV_ID=$(npx wrangler kv namespace list 2>&1 | grep -B1 "FEEDBACK" | grep -oP '"id":\s*"\K[^"]+')
fi

if [ -z "$KV_ID" ]; then
  echo "ERROR: Could not get KV namespace ID. Create manually:"
  echo "  npx wrangler kv namespace create FEEDBACK"
  exit 1
fi

echo "KV namespace ID: $KV_ID"
echo ""

# ---- Step 3: Update wrangler.toml ----
echo "Updating worker/wrangler.toml..."
sed -i "s/YOUR_KV_NAMESPACE_ID/$KV_ID/g" worker/wrangler.toml
sed -i "s/YOUR_KV_PREVIEW_ID/$KV_ID/g" worker/wrangler.toml
echo "Updated."
echo ""

# ---- Step 4: Generate FEEDBACK_TOKEN ----
FEEDBACK_TOKEN=$(openssl rand -hex 24)
echo "Generated FEEDBACK_TOKEN: $FEEDBACK_TOKEN"
echo ""

# ---- Step 5: Deploy worker ----
echo "Deploying worker..."
cd worker
npx wrangler deploy
echo ""

# ---- Step 6: Set worker secrets ----
echo "Setting worker secrets..."
echo "$FEEDBACK_TOKEN" | npx wrangler secret put FEEDBACK_TOKEN
echo ""

# Check if GITHUB_TOKEN secret is already set (for /refresh endpoint)
echo "Note: If /refresh needs a GITHUB_TOKEN, set it with:"
echo "  echo 'your-github-pat' | npx wrangler secret put GITHUB_TOKEN"
echo ""

cd ..

# ---- Step 7: Set GitHub secret ----
if command -v gh &> /dev/null; then
  echo "Setting FEEDBACK_TOKEN on GitHub..."
  REPO=$(git remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/' | sed 's/.*github.com[:/]\(.*\)/\1/')
  gh secret set FEEDBACK_TOKEN --body "$FEEDBACK_TOKEN" --repo "$REPO"
  echo "GitHub secret set."
else
  echo "gh CLI not found. Set the GitHub secret manually:"
  echo "  Go to: https://github.com/$(git remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/' | sed 's/.*github.com[:/]\(.*\)/\1/')/settings/secrets/actions"
  echo "  Add secret: FEEDBACK_TOKEN = $FEEDBACK_TOKEN"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Test it:"
echo "  curl 'https://briefing-refresh.adampasick.workers.dev/feedback?score=4&date=2026-02-06&notes=test'"
echo ""
echo "Save this token somewhere safe: $FEEDBACK_TOKEN"
