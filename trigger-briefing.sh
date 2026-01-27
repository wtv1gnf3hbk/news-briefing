#!/bin/bash
# Trigger the briefing workflow on GitHub Actions
# Requires: GITHUB_PAT environment variable with Actions:write permission

if [ -z "$GITHUB_PAT" ]; then
  echo "Error: GITHUB_PAT environment variable not set"
  echo ""
  echo "Create a token at:"
  echo "  github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens"
  echo ""
  echo "Required permissions:"
  echo "  - Repository: wtv1gnf3hbk/news-briefing"
  echo "  - Actions: Read and write"
  exit 1
fi

echo "Triggering briefing workflow..."

response=$(curl -s -w "\n%{http_code}" -X POST \
  -H "Authorization: token $GITHUB_PAT" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/repos/wtv1gnf3hbk/news-briefing/actions/workflows/briefing.yml/dispatches \
  -d '{"ref":"main"}')

http_code=$(echo "$response" | tail -n1)

if [ "$http_code" = "204" ]; then
  echo "✅ Workflow triggered successfully!"
  echo ""
  echo "View progress: https://github.com/wtv1gnf3hbk/news-briefing/actions"
  echo "Briefing will be live at: https://wtv1gnf3hbk.github.io/news-briefing/"
else
  echo "❌ Failed to trigger workflow (HTTP $http_code)"
  echo "$response" | head -n -1
fi
