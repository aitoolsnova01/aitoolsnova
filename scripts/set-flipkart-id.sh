#!/usr/bin/env bash
# Flipkart affiliate ID set karne ke liye.
# Usage:  bash scripts/set-flipkart-id.sh YOUR_REAL_AFFID
set -e
NEW="$1"
if [ -z "$NEW" ]; then
  echo "Usage: bash scripts/set-flipkart-id.sh YOUR_REAL_AFFID"
  echo "Flipkart Affiliate dashboard se apna tracking ID lein."
  exit 1
fi
COUNT=$(grep -rl 'affid=aitoolsnova' --include=*.html . | wc -l)
grep -rl 'affid=aitoolsnova' --include=*.html . | xargs sed -i "s/affid=aitoolsnova\b/affid=${NEW}/g"
# generator me bhi update
sed -i "s/affid=aitoolsnova\b/affid=${NEW}/g" scripts/generate-blog.mjs 2>/dev/null || true
echo "✅ Updated $COUNT files + blog generator to affid=${NEW}"
echo "Ab commit karein:  git add -A && git commit -m 'chore: set real Flipkart affiliate ID' && git push"
