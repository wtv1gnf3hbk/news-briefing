Run the Briefing 2.0 pipeline (Option B: 3-pass editorial chain).

1. First run `node generate-briefing.js` to scrape all sources into briefing.json
2. Then run `node write-briefing-v2.js` to produce the briefing via 3 passes (write → edit → revise)
3. Report the output: show the final briefing.md contents and timing from the console output
