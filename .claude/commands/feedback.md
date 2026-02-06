Record feedback on today's briefing.

Read briefing.md and show a brief summary (first 3 lines). Then ask the user:
1. Score (1-5)
2. Any notes on what worked or didn't

Once they respond, write their feedback to briefing-history.json using the same format as `node evaluate-briefing.js feedback`. Specifically:

1. Read briefing-history.json
2. Find or create today's entry (date: YYYY-MM-DD)
3. Set human_feedback: { score, notes, recorded_at (ISO timestamp) }
4. If the user mentions anything to "keep doing", add a "keep" field
5. If the user mentions anything to "fix", add a "fix" field
6. Write the updated JSON back

Confirm what was saved. Keep it brief.
