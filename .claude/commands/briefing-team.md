Launch an agent team to produce a high-quality daily news briefing.

Create an agent team for producing a daily news briefing (Briefing 2.0):

- **Researcher**: Gather today's top stories using the project's existing
  source hierarchy:

  PRIMARY: New York Times homepage + section pages (U.S., Politics, World
  regions, Business, Tech) — this is the backbone of the briefing.

  INTERNATIONAL BENCHMARKS: BBC UK (bbc.co.uk/news), Guardian UK
  (theguardian.com/uk), Al Jazeera, Reuters, and The Economist World in
  Brief (may require login — skip if unavailable).

  RSS ROUNDOUT: AP, WSJ, Bloomberg, Washington Post, SCMP, Times of
  Israel, AFP/France24 — ~14 feeds for wire coverage, markets, and
  regional depth.

  Run the cross-source lead analysis per CLAUDE.md: compare the NYT lead
  against BBC/Guardian/Economist leads using the US_DOMESTIC_KEYWORDS
  list. If NYT leads with a US-domestic story but 2+ international
  sources lead with something different, flag the discrepancy and note
  the international alternative. Watch for false positives (e.g., "Trump"
  in international context like "Iran responds to Trump" is not
  US-domestic).

  Write findings to `briefing-v2/research-notes.md`: organized by tier,
  with headline, source, key facts, and the lead analysis result. Create
  one task per source tier for visibility.

- **Writer**: After the researcher finishes, read
  `briefing-v2/research-notes.md` and write a conversational briefing to
  `briefing-v2/briefing-draft.md`. Tone: informed friend catching you up
  over coffee. Cover 5-7 major stories, 2-3 paragraphs each. Follow all
  style rules in CLAUDE.md — especially never use "'s" as a contraction
  for "is" (possessive is fine). If the lead analysis found a non-US
  international story leading 2+ benchmarks, open with that story instead
  of the NYT lead.

- **Primary Editor**: After the writer produces a draft, review
  `briefing-v2/briefing-draft.md` against `briefing-v2/research-notes.md`.
  Your job is line-level quality:
  (1) Fact-check: every claim, number, name, and attribution must be
      traceable to `briefing-v2/research-notes.md`. Flag anything
      unverifiable or embellished.
  (2) Proofread: grammar, spelling, punctuation, awkward phrasing.
  (3) Style enforcement: no "'s" contractions for "is" (possessive OK),
      per CLAUDE.md.
  (4) Source fidelity: no hallucinated details, no conflation of
      separate stories, no editorializing beyond what the sources say.
  Send specific line-level feedback to the writer for revisions. Allow
  up to 2 revision rounds. Only pass the draft to the Senior Editor
  once fact-checking and proofreading are clean.

- **Senior Editor**: After the Primary Editor clears the draft, do a
  final assessment of `briefing-v2/briefing-draft.md`. Your job is
  big-picture quality:
  (1) Lead story: is the lead justified by the cross-source analysis?
      Would a different story better serve the reader?
  (2) Story selection: are the right 5-7 stories represented? Any major
      story from the research missing? Any story not worth the space?
  (3) International balance: is the briefing US-centric when it
      shouldn't be? Do international perspectives come through?
  (4) Tone and flow: does it read like one coherent briefing, not a
      list of summaries? Is the conversational tone consistent?
  (5) Final verdict: approve, or send back to the Writer with
      high-level direction (not line edits — that is the Primary
      Editor's job).
  If sending back, allow 1 final revision round.

Dependencies: Researcher must finish before Writer starts. Writer draft
goes to Primary Editor first. Primary Editor clears before Senior Editor
reviews. Break work into 5-6 tasks per teammate for visibility. Use plan
approval for the Writer so the lead can review the outline before
drafting begins.

Output files (all under `briefing-v2/`):
- `research-notes.md` — Researcher output
- `briefing-draft.md` — Writer drafts (overwritten each revision)
- `briefing-final.md` — Senior Editor-approved final briefing
