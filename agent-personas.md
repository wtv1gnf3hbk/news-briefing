# Claude Agent Personas

*Last updated: 2026-01-28*

---

## Optimus
*Newsletter optimization & testing*

**Framework:** [optimus-framework.md](optimus-framework.md)

### Projects
- **Link text** - Optimize newsletter link copy
  - [ ] Track effect of changes with Mode data
  - [ ] Add UTM parameters to briefing links

- **Subject line** - Email subject optimization
  - [x] AB test suggestions created (see framework)
  - [ ] Run first AB test
  - [ ] Set up Mode dashboard

- **Analytics** - Newsletter performance analysis
  - [x] Heatmap design documented
  - [ ] Implement pixel tracking
  - [ ] Build first heatmap visualization

---

## Concierge
*Daily information curation*

### Projects
- **News briefing** - Daily news summary
  - [x] Improved lead story selection logic (scoring system)
  - [ ] Test with live data
  - [ ] Fine-tune scoring weights

- **World's biggest story** - Major story tracking
  - [x] Built! See [worlds-biggest-story.js](worlds-biggest-story.js)
  - Features: cross-source clustering, streak tracking, runners-up
  - [ ] Integrate into daily workflow
  - [ ] Add to GitHub Actions

---

## Explanify
*Educational content & presentations*

**Framework:** [explanify-seoul-presentation.md](explanify-seoul-presentation.md)

### Projects
- **Seoul presentation** - Based on explanatory playbook
  - [x] Presentation structure outlined
  - [ ] Confirm topic/theme
  - [ ] Draft slides
  - [ ] Gather examples/artifacts

- **Evergreen update** - Ongoing content maintenance
  - [ ] Audit existing evergreen content
  - [ ] Prioritize updates

---

## Personal Assistant
*Life management & tools*

### Projects
- [ ] Habit tracker - Design and build
- [ ] Media diet - Track consumption patterns
- [ ] Finish distractify app - Complete MVP
- [ ] Incorporate Moltbot - Integration TBD

---

## Infrastructure
*Technical foundation*

**Plan:** [infrastructure-plan.md](infrastructure-plan.md)

### Projects
- [x] Cloud hosting plan documented
  - Recommended: Hetzner VPS ($6/mo)
  - Architecture: nginx + pm2 + cron
- [x] Paywall access workflow designed
  - Browser extension + local proxy
- [x] PDF ingester designed
  - Uses pdf-parse library
- [x] Offline LLM plan documented
  - Ollama + Mistral recommended

### Next Actions
- [ ] Provision VPS
- [ ] Deploy news-briefing
- [ ] Set up SSL and domains
- [ ] Build paywall extension

---

## Daily Log

### 2026-01-28
- Created agent personas tracking system
- **Concierge**: Improved lead story logic with scoring system; built World's Biggest Story feature
- **Optimus**: Documented AB testing framework with 4 ready-to-run tests; designed heatmap approach
- **Explanify**: Created Seoul presentation structure based on explanatory playbook principles
- **Infrastructure**: Full deployment plan with VPS setup, paywall workflow, PDF ingester, and offline LLM
