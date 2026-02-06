Run the Briefing 2.0 pipeline (3-pass editorial chain: write, edit, revise).

1. Run `node generate-briefing.js` to scrape all sources into briefing.json
2. Run `node write-briefing-v2.js` to produce the briefing via 3 passes
3. Show the final briefing-v2/briefing.md contents and timing from the console output
4. The output lives at briefing-v2/index.html for GitHub Pages
