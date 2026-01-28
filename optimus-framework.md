# Optimus: Newsletter Optimization Framework

## Overview
Optimus handles all testing, optimization, and analytics for "The World" newsletter.

---

## 1. Subject Line AB Testing

### Hypothesis Framework
Every subject line test should answer a specific question:

| Test Type | Question | Example A | Example B |
|-----------|----------|-----------|-----------|
| **Urgency** | Does urgency lift opens? | "Today's biggest stories" | "Breaking: Here's what you need to know" |
| **Specificity** | Does naming the story work? | "Your morning briefing" | "Minneapolis fallout reaches Congress" |
| **Curiosity gap** | Does intrigue beat clarity? | "Trump's immigration policy faces pushback" | "The moment Republicans broke with Trump" |
| **Length** | Short vs. detailed? | "The World: Jan 28" | "War in Ukraine enters new phase as Russia launches drone offensive" |
| **Personalization** | Does "you" help? | "What's happening in the world" | "What you need to know today" |
| **Numbers** | Do numbers drive clicks? | "Today's top stories" | "5 stories shaping the world today" |

### Suggested Tests (Queue)

**Test 1: Geographic Hook**
- A: "Your Tuesday briefing"
- B: "From Minneapolis to Kherson: Tuesday's biggest stories"
- Hypothesis: Specific geography creates intrigue

**Test 2: Stakes Framing**
- A: "What's happening today"
- B: "The story that could reshape immigration policy"
- Hypothesis: Stakes-based framing lifts engagement

**Test 3: Question Format**
- A: "The Minneapolis crisis continues"
- B: "Why are Republicans breaking with Trump?"
- Hypothesis: Questions create curiosity

**Test 4: Time Sensitivity**
- A: "Your morning briefing"
- B: "Before your first meeting: Today's news"
- Hypothesis: Urgency framing lifts opens

### Implementation Plan
1. Integrate with ESP's AB testing (Sailthru/Klaviyo/etc)
2. Set up Mode dashboard to track:
   - Open rate by variant
   - Click-through rate by variant
   - Time-to-open distribution
3. Run each test for 2 weeks minimum (statistical significance)
4. Log all tests in `subject-line-tests.json`

---

## 2. Link Text Optimization

### Current Approach
Links in briefing are 1-3 words per style guide: `[link text](url)`

### Tracking Plan
1. Add UTM parameters to all links: `?utm_source=briefing&utm_content=link_position_N`
2. Map link text patterns to CTR in Mode:
   - Verb-forward: "raised rates", "signed deal"
   - Noun phrases: "the report", "new policy"
   - Name-based: "Trump", "Fed"
3. Build feedback loop into write-briefing.js prompt

### Data Schema for Mode
```sql
CREATE TABLE link_performance (
  briefing_date DATE,
  link_position INT,
  link_text VARCHAR(100),
  link_url VARCHAR(500),
  link_section VARCHAR(50),  -- 'lead', 'business', 'around_the_world'
  clicks INT,
  unique_clicks INT,
  ctr DECIMAL(5,4)
);
```

---

## 3. Newsletter Heatmap

### Concept
Visual representation of where readers engage within each briefing.

### Implementation Approach

**Option A: Pixel Tracking (Recommended)**
- Insert invisible tracking pixels at key positions
- Positions: after greeting, after lead, after each section header, at footer
- Track "scroll depth" proxy via pixel loads

**Option B: Click Position Analysis**
- Map all link clicks to their position in the email
- Generate heatmap from click density
- Sections: Lead (1-3), Business (4-7), Around the World (8-12), Footer

### Heatmap Data Model
```javascript
{
  "date": "2026-01-28",
  "sections": {
    "greeting": { "position": 0, "engagement": 0.95 },
    "lead_story": { "position": 1, "engagement": 0.82 },
    "business_tech": { "position": 2, "engagement": 0.64 },
    "around_the_world": { "position": 3, "engagement": 0.58 },
    "latin_america": { "position": 3.1, "engagement": 0.52 },
    "europe": { "position": 3.2, "engagement": 0.61 },
    "asia": { "position": 3.3, "engagement": 0.48 },
    "middle_east": { "position": 3.4, "engagement": 0.55 },
    "africa": { "position": 3.5, "engagement": 0.41 }
  },
  "drop_off_point": "around_the_world",
  "avg_links_clicked": 2.3
}
```

### Visualization
- Render in Mode as vertical bar chart
- Color gradient: green (high engagement) → red (low engagement)
- Overlay on email template mockup

---

## 4. Other AB Testing Ideas

### Content Tests
1. **Section order**: Does Business before World Affairs perform better?
2. **Bullet count**: 3 vs 5 bullets per section
3. **Tone**: More conversational vs. more authoritative
4. **Length**: 500 words vs 800 words total

### Structural Tests
1. **TL;DR at top**: One-sentence summary before diving in
2. **Pull quote**: Highlight a key stat/quote visually
3. **Sign-off**: "More tomorrow" vs. "Stay informed" vs. none

### Engagement Tests
1. **CTA placement**: "Read more at nytimes.com" position
2. **Social proof**: "250,000 readers" badge
3. **Reply prompt**: "Hit reply to share feedback"

---

## Next Steps

1. [ ] Get Mode access configured
2. [ ] Set up UTM tracking in write-briefing.js
3. [ ] Create subject-line-tests.json to log experiments
4. [ ] Build first heatmap from existing click data
5. [ ] Schedule first AB test for next week
