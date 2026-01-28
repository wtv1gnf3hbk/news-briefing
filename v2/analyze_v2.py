#!/usr/bin/env python3
"""
analyze_v2.py - Main analysis engine for The World newsletter

Generates actionable intelligence:
1. Subject Line Analysis - score, what worked, alternatives
2. Position Heatmap - click distribution by section/position
3. Underperformers - stories that missed expectations with diagnosis
4. Stories We Missed - from trending + other newsletters
5. Link Text Wins/Losses - patterns that drove or killed clicks

Usage:
    python analyze_v2.py <mode_export.csv> [--newsletter-html <url_or_file>]

Baselines (90-day averages):
    Asia edition:   33.4% open, 1.2% click
    Europe edition: 35.5% open, 2.6% click
    Position 2 is sweet spot (~0.6% CTR vs 0.2% for lead)
"""

import csv
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

# Import sibling modules
from parse_newsletter import parse_newsletter, fetch_html, NewsletterLink
from fetch_trending import fetch_trending, TrendingStory


# =============================================================================
# CONFIGURATION & BASELINES
# =============================================================================

@dataclass
class Baselines:
    """90-day performance baselines by edition."""
    asia_open_rate: float = 0.334
    asia_click_rate: float = 0.012
    europe_open_rate: float = 0.355
    europe_click_rate: float = 0.026

    # Position CTR baselines (approximate)
    position_ctr: dict = field(default_factory=lambda: {
        1: 0.002,   # Lead position - surprisingly low
        2: 0.006,   # Sweet spot
        3: 0.005,
        4: 0.004,
        5: 0.003,
        6: 0.003,
        7: 0.002,
        8: 0.002,
        9: 0.001,
        10: 0.001,
    })

    # Pattern CTR baselines
    pattern_ctr: dict = field(default_factory=lambda: {
        'question': 0.004,
        'action': 0.003,
        'fragment': 0.002,
        'numeric': 0.003,
        'quote': 0.003,
        'descriptive': 0.002,
    })


BASELINES = Baselines()


# =============================================================================
# DATA STRUCTURES
# =============================================================================

@dataclass
class ClickData:
    """Click data from Mode export for a single link."""
    url: str
    clicks: int
    unique_clicks: int
    sends: int
    ctr: float              # clicks / sends
    unique_ctr: float       # unique_clicks / sends
    link_text: str = ''
    position: int = 0
    edition: str = ''       # asia, europe, or combined
    send_date: str = ''


@dataclass
class SubjectLineAnalysis:
    """Analysis of a subject line's performance."""
    subject: str
    open_rate: float
    edition: str
    score: float            # 0-100 score vs baseline
    diagnosis: list[str]    # What worked / didn't work
    alternatives: list[str] # Suggested improvements


@dataclass
class LinkAnalysis:
    """Analysis of a single link's performance."""
    url: str
    text: str
    position: int
    section: str
    pattern: str
    clicks: int
    ctr: float
    expected_ctr: float     # Based on position + pattern
    performance: float      # ctr / expected_ctr (>1 = overperform)
    diagnosis: str          # Why it under/overperformed


@dataclass
class AnalysisReport:
    """Complete analysis report."""
    send_date: str
    edition: str
    subject_analysis: SubjectLineAnalysis
    position_heatmap: dict[int, dict]
    section_heatmap: dict[str, dict]
    underperformers: list[LinkAnalysis]
    overperformers: list[LinkAnalysis]
    missed_stories: list[TrendingStory]
    link_text_analysis: dict[str, dict]


# =============================================================================
# MODE CSV PARSING
# =============================================================================

def parse_mode_csv(filepath: str) -> list[ClickData]:
    """
    Parse Mode dashboard CSV export.

    Expected columns (adjust based on actual export):
    - url or link_url
    - clicks or total_clicks
    - unique_clicks
    - sends or total_sends
    - link_text (optional)
    - position (optional)
    - edition (optional)
    - send_date (optional)
    """
    clicks = []

    with open(filepath, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)

        # Normalize column names (Mode exports can vary)
        fieldnames = [name.lower().strip() for name in reader.fieldnames or []]

        for row in reader:
            # Normalize row keys
            row = {k.lower().strip(): v for k, v in row.items()}

            # Extract URL
            url = row.get('url') or row.get('link_url') or row.get('href', '')

            # Extract counts
            total_clicks = int(row.get('clicks') or row.get('total_clicks') or 0)
            unique = int(row.get('unique_clicks') or row.get('unique') or total_clicks)
            sends = int(row.get('sends') or row.get('total_sends') or 1)

            # Calculate CTR
            ctr = total_clicks / sends if sends > 0 else 0
            unique_ctr = unique / sends if sends > 0 else 0

            click_data = ClickData(
                url=url,
                clicks=total_clicks,
                unique_clicks=unique,
                sends=sends,
                ctr=ctr,
                unique_ctr=unique_ctr,
                link_text=row.get('link_text', ''),
                position=int(row.get('position') or 0),
                edition=row.get('edition', ''),
                send_date=row.get('send_date') or row.get('date', ''),
            )
            clicks.append(click_data)

    return clicks


# =============================================================================
# SUBJECT LINE ANALYSIS
# =============================================================================

# Subject line patterns that tend to work/not work
SUBJECT_PATTERNS = {
    'positive': [
        (r'\b(breaking|urgent|just in)\b', 'urgency_word', 'Urgency words drive opens'),
        (r'\?$', 'question', 'Questions create curiosity'),
        (r'\b(exclusive|first look|inside)\b', 'exclusivity', 'Exclusivity signals value'),
        (r'\b\d+\b', 'number', 'Numbers provide specificity'),
        (r'^[A-Z][^.!?]*:', 'topic_colon', 'Topic: format sets expectations'),
    ],
    'negative': [
        (r'^(the|a|an)\s', 'weak_start', 'Weak article start'),
        (r'newsletter|update|digest', 'generic_word', 'Generic newsletter language'),
        (r'.{80,}', 'too_long', 'Subject line too long (>80 chars)'),
        (r'^[a-z]', 'lowercase_start', 'Starts with lowercase'),
    ],
}


def analyze_subject_line(
    subject: str,
    open_rate: float,
    edition: str = 'combined'
) -> SubjectLineAnalysis:
    """Analyze a subject line's performance and suggest improvements."""

    # Get baseline for edition
    if edition.lower() == 'asia':
        baseline = BASELINES.asia_open_rate
    elif edition.lower() == 'europe':
        baseline = BASELINES.europe_open_rate
    else:
        baseline = (BASELINES.asia_open_rate + BASELINES.europe_open_rate) / 2

    # Score: 100 = at baseline, scale linearly
    score = min(100, (open_rate / baseline) * 100) if baseline > 0 else 50

    diagnosis = []
    alternatives = []

    # Check positive patterns
    for pattern, name, explanation in SUBJECT_PATTERNS['positive']:
        if re.search(pattern, subject, re.IGNORECASE):
            diagnosis.append(f"✓ {explanation}")

    # Check negative patterns
    for pattern, name, explanation in SUBJECT_PATTERNS['negative']:
        if re.search(pattern, subject, re.IGNORECASE):
            diagnosis.append(f"✗ {explanation}")

    # Performance diagnosis
    if open_rate > baseline * 1.1:
        diagnosis.insert(0, f"⬆ {((open_rate/baseline)-1)*100:.1f}% above baseline")
    elif open_rate < baseline * 0.9:
        diagnosis.insert(0, f"⬇ {(1-(open_rate/baseline))*100:.1f}% below baseline")
    else:
        diagnosis.insert(0, "→ Performing at baseline")

    # Generate alternatives
    alternatives = _generate_subject_alternatives(subject, diagnosis)

    return SubjectLineAnalysis(
        subject=subject,
        open_rate=open_rate,
        edition=edition,
        score=score,
        diagnosis=diagnosis,
        alternatives=alternatives,
    )


def _generate_subject_alternatives(subject: str, diagnosis: list[str]) -> list[str]:
    """Generate alternative subject lines based on diagnosis."""
    alternatives = []

    # If too long, suggest shorter version
    if any('too long' in d for d in diagnosis):
        # Try to shorten to key phrase
        words = subject.split()
        if len(words) > 8:
            short = ' '.join(words[:8]) + '...'
            alternatives.append(f"Shorter: {short}")

    # If no question, suggest question version
    if not any('question' in d.lower() for d in diagnosis):
        # Add question framing
        alternatives.append(f"Question: What's behind {subject.lower().rstrip('.')}?")

    # If weak start, suggest stronger start
    if any('weak' in d.lower() for d in diagnosis):
        # Remove leading article
        fixed = re.sub(r'^(the|a|an)\s+', '', subject, flags=re.IGNORECASE)
        if fixed != subject:
            alternatives.append(f"Stronger start: {fixed.capitalize()}")

    # Add colon format suggestion
    if ':' not in subject:
        words = subject.split()
        if len(words) >= 3:
            topic = words[0]
            rest = ' '.join(words[1:])
            alternatives.append(f"Topic format: {topic}: {rest}")

    return alternatives[:3]  # Limit to 3 suggestions


# =============================================================================
# POSITION HEATMAP
# =============================================================================

def build_position_heatmap(
    clicks: list[ClickData],
    newsletter_links: list[NewsletterLink]
) -> dict[int, dict]:
    """
    Build click distribution heatmap by position.

    Returns dict: position -> {clicks, ctr, expected_ctr, performance, links}
    """
    # Merge click data with newsletter link metadata
    url_to_link = {link.url: link for link in newsletter_links}
    url_to_clicks = {c.url: c for c in clicks}

    heatmap: dict[int, dict] = {}

    for link in newsletter_links:
        pos = link.position
        click_data = url_to_clicks.get(link.url)

        if pos not in heatmap:
            heatmap[pos] = {
                'clicks': 0,
                'total_ctr': 0.0,
                'count': 0,
                'expected_ctr': BASELINES.position_ctr.get(pos, 0.001),
                'links': [],
            }

        if click_data:
            heatmap[pos]['clicks'] += click_data.clicks
            heatmap[pos]['total_ctr'] += click_data.ctr
            heatmap[pos]['count'] += 1
            heatmap[pos]['links'].append({
                'url': link.url,
                'text': link.text,
                'ctr': click_data.ctr,
            })

    # Calculate averages and performance
    for pos, data in heatmap.items():
        if data['count'] > 0:
            data['avg_ctr'] = data['total_ctr'] / data['count']
            data['performance'] = data['avg_ctr'] / data['expected_ctr'] if data['expected_ctr'] > 0 else 1.0
        else:
            data['avg_ctr'] = 0
            data['performance'] = 0

        del data['total_ctr']  # Clean up intermediate value

    return heatmap


def build_section_heatmap(
    clicks: list[ClickData],
    newsletter_links: list[NewsletterLink]
) -> dict[str, dict]:
    """Build click distribution by section."""
    url_to_clicks = {c.url: c for c in clicks}

    section_map: dict[str, dict] = {}

    for link in newsletter_links:
        section = link.section
        click_data = url_to_clicks.get(link.url)

        if section not in section_map:
            section_map[section] = {
                'clicks': 0,
                'total_ctr': 0.0,
                'count': 0,
                'links': [],
            }

        if click_data:
            section_map[section]['clicks'] += click_data.clicks
            section_map[section]['total_ctr'] += click_data.ctr
            section_map[section]['count'] += 1
            section_map[section]['links'].append({
                'text': link.text[:50],
                'ctr': click_data.ctr,
            })

    # Calculate averages
    for section, data in section_map.items():
        if data['count'] > 0:
            data['avg_ctr'] = data['total_ctr'] / data['count']
        else:
            data['avg_ctr'] = 0
        del data['total_ctr']

    return section_map


# =============================================================================
# UNDERPERFORMERS / OVERPERFORMERS
# =============================================================================

def analyze_link_performance(
    clicks: list[ClickData],
    newsletter_links: list[NewsletterLink]
) -> tuple[list[LinkAnalysis], list[LinkAnalysis]]:
    """
    Identify under and overperforming links with diagnosis.

    Returns: (underperformers, overperformers)
    """
    url_to_clicks = {c.url: c for c in clicks}
    url_to_link = {link.url: link for link in newsletter_links}

    analyses = []

    for link in newsletter_links:
        click_data = url_to_clicks.get(link.url)
        if not click_data:
            continue

        # Calculate expected CTR based on position and pattern
        pos_expected = BASELINES.position_ctr.get(link.position, 0.001)
        pattern_expected = BASELINES.pattern_ctr.get(link.pattern, 0.002)
        expected_ctr = (pos_expected + pattern_expected) / 2

        performance = click_data.ctr / expected_ctr if expected_ctr > 0 else 1.0

        # Generate diagnosis
        diagnosis = _diagnose_link_performance(link, click_data, performance)

        analysis = LinkAnalysis(
            url=link.url,
            text=link.text,
            position=link.position,
            section=link.section,
            pattern=link.pattern,
            clicks=click_data.clicks,
            ctr=click_data.ctr,
            expected_ctr=expected_ctr,
            performance=performance,
            diagnosis=diagnosis,
        )
        analyses.append(analysis)

    # Sort by performance
    analyses.sort(key=lambda x: x.performance)

    # Bottom 20% = underperformers, Top 20% = overperformers
    n = len(analyses)
    cutoff = max(3, n // 5)

    underperformers = analyses[:cutoff]
    overperformers = analyses[-cutoff:][::-1]  # Reverse for best first

    return underperformers, overperformers


def _diagnose_link_performance(
    link: NewsletterLink,
    click_data: ClickData,
    performance: float
) -> str:
    """Generate diagnosis for why a link under/overperformed."""
    reasons = []

    if performance < 0.5:
        # Severe underperformance
        if link.position > 7:
            reasons.append("buried position (below fold)")
        if link.word_count > 6:
            reasons.append("link text too long")
        if link.word_count < 2:
            reasons.append("link text too short/vague")
        if link.pattern == 'fragment':
            reasons.append("fragment pattern underperforms")
        if link.section == 'closing':
            reasons.append("closing section gets few clicks")

    elif performance > 2.0:
        # Strong overperformance
        if link.position <= 3:
            reasons.append("prime position")
        if link.pattern == 'question':
            reasons.append("question pattern drives curiosity")
        if link.pattern == 'action':
            reasons.append("action verbs engage readers")
        if 2 <= link.word_count <= 4:
            reasons.append("optimal link text length")

    if not reasons:
        if performance < 1.0:
            reasons.append("slightly below expected")
        else:
            reasons.append("performing as expected")

    return '; '.join(reasons)


# =============================================================================
# STORIES WE MISSED
# =============================================================================

def find_missed_stories(
    newsletter_links: list[NewsletterLink],
    trending: list[TrendingStory],
    min_rank: int = 10
) -> list[TrendingStory]:
    """
    Find trending stories that weren't included in the newsletter.

    Args:
        newsletter_links: Links from the newsletter
        trending: Trending stories from NYT
        min_rank: Only consider stories ranked this high or better

    Returns: List of missed stories that were trending
    """
    # Get URLs we used
    used_urls = {link.url for link in newsletter_links}

    # Normalize URLs for comparison (remove query params, trailing slashes)
    def normalize_url(url: str) -> str:
        url = url.split('?')[0].rstrip('/')
        return url.lower()

    used_normalized = {normalize_url(u) for u in used_urls}

    missed = []
    for story in trending:
        if story.rank > min_rank:
            continue
        if normalize_url(story.url) not in used_normalized:
            missed.append(story)

    return missed


# =============================================================================
# LINK TEXT ANALYSIS
# =============================================================================

def analyze_link_text_patterns(
    clicks: list[ClickData],
    newsletter_links: list[NewsletterLink]
) -> dict[str, dict]:
    """
    Analyze CTR by link text pattern.

    Returns: pattern -> {count, avg_ctr, baseline, performance, examples}
    """
    url_to_clicks = {c.url: c for c in clicks}

    pattern_stats: dict[str, dict] = {}

    for link in newsletter_links:
        pattern = link.pattern
        click_data = url_to_clicks.get(link.url)

        if pattern not in pattern_stats:
            pattern_stats[pattern] = {
                'count': 0,
                'total_ctr': 0.0,
                'baseline': BASELINES.pattern_ctr.get(pattern, 0.002),
                'wins': [],    # Top performers
                'losses': [],  # Bottom performers
            }

        if click_data:
            pattern_stats[pattern]['count'] += 1
            pattern_stats[pattern]['total_ctr'] += click_data.ctr

            # Track for examples
            example = {'text': link.text[:50], 'ctr': click_data.ctr}
            if click_data.ctr > pattern_stats[pattern]['baseline'] * 1.5:
                pattern_stats[pattern]['wins'].append(example)
            elif click_data.ctr < pattern_stats[pattern]['baseline'] * 0.5:
                pattern_stats[pattern]['losses'].append(example)

    # Calculate averages and performance
    for pattern, stats in pattern_stats.items():
        if stats['count'] > 0:
            stats['avg_ctr'] = stats['total_ctr'] / stats['count']
            stats['performance'] = stats['avg_ctr'] / stats['baseline'] if stats['baseline'] > 0 else 1.0
        else:
            stats['avg_ctr'] = 0
            stats['performance'] = 0
        del stats['total_ctr']

        # Keep only top 3 wins/losses
        stats['wins'] = sorted(stats['wins'], key=lambda x: -x['ctr'])[:3]
        stats['losses'] = sorted(stats['losses'], key=lambda x: x['ctr'])[:3]

    return pattern_stats


# =============================================================================
# MAIN REPORT GENERATION
# =============================================================================

def generate_report(
    csv_path: str,
    newsletter_url: str = 'https://static.nytimes.com/email-content/WOR_sample.html',
    subject_line: str = '',
    open_rate: float = 0.0,
    edition: str = 'combined'
) -> AnalysisReport:
    """Generate complete analysis report."""

    print(f"Loading click data from {csv_path}...")
    clicks = parse_mode_csv(csv_path)
    print(f"  Loaded {len(clicks)} click records")

    print(f"\nParsing newsletter from {newsletter_url}...")
    html = fetch_html(newsletter_url)
    newsletter_links = parse_newsletter(html)
    print(f"  Found {len(newsletter_links)} links")

    print("\nFetching trending stories...")
    trending = fetch_trending()
    print(f"  Found {len(trending)} trending stories")

    # Subject line analysis
    print("\nAnalyzing subject line...")
    subject_analysis = analyze_subject_line(subject_line, open_rate, edition)

    # Position heatmap
    print("Building position heatmap...")
    position_heatmap = build_position_heatmap(clicks, newsletter_links)
    section_heatmap = build_section_heatmap(clicks, newsletter_links)

    # Under/overperformers
    print("Analyzing link performance...")
    underperformers, overperformers = analyze_link_performance(clicks, newsletter_links)

    # Missed stories
    print("Finding missed stories...")
    missed_stories = find_missed_stories(newsletter_links, trending)

    # Link text patterns
    print("Analyzing link text patterns...")
    link_text_analysis = analyze_link_text_patterns(clicks, newsletter_links)

    # Get send date from click data
    send_date = clicks[0].send_date if clicks else datetime.now().strftime('%Y-%m-%d')

    return AnalysisReport(
        send_date=send_date,
        edition=edition,
        subject_analysis=subject_analysis,
        position_heatmap=position_heatmap,
        section_heatmap=section_heatmap,
        underperformers=underperformers,
        overperformers=overperformers,
        missed_stories=missed_stories,
        link_text_analysis=link_text_analysis,
    )


def print_report(report: AnalysisReport):
    """Print formatted analysis report."""
    print("\n" + "=" * 80)
    print(f"THE WORLD NEWSLETTER ANALYSIS - {report.send_date}")
    print(f"Edition: {report.edition}")
    print("=" * 80)

    # Subject Line
    print("\n## SUBJECT LINE ANALYSIS")
    print("-" * 40)
    sa = report.subject_analysis
    print(f"Subject: {sa.subject}")
    print(f"Open Rate: {sa.open_rate:.1%}")
    print(f"Score: {sa.score:.0f}/100")
    print("\nDiagnosis:")
    for d in sa.diagnosis:
        print(f"  {d}")
    if sa.alternatives:
        print("\nAlternatives to try:")
        for alt in sa.alternatives:
            print(f"  → {alt}")

    # Position Heatmap
    print("\n## POSITION HEATMAP")
    print("-" * 40)
    print(f"{'Pos':>4} {'Clicks':>7} {'CTR':>8} {'Expected':>9} {'Perf':>8}")
    for pos in sorted(report.position_heatmap.keys()):
        data = report.position_heatmap[pos]
        perf_indicator = "🔥" if data['performance'] > 1.5 else "❄️" if data['performance'] < 0.5 else "  "
        print(f"{pos:>4} {data['clicks']:>7} {data.get('avg_ctr', 0):>7.2%} {data['expected_ctr']:>8.2%} {data['performance']:>7.1f}x {perf_indicator}")

    # Section Heatmap
    print("\n## SECTION HEATMAP")
    print("-" * 40)
    for section, data in sorted(report.section_heatmap.items(), key=lambda x: -x[1]['clicks']):
        print(f"  {section:20s}: {data['clicks']:>5} clicks, {data.get('avg_ctr', 0):.2%} avg CTR")

    # Underperformers
    print("\n## UNDERPERFORMERS (need attention)")
    print("-" * 40)
    for link in report.underperformers[:5]:
        print(f"  [{link.position}] {link.text[:40]}...")
        print(f"      CTR: {link.ctr:.3%} vs {link.expected_ctr:.3%} expected ({link.performance:.1f}x)")
        print(f"      Diagnosis: {link.diagnosis}")

    # Overperformers
    print("\n## OVERPERFORMERS (learn from these)")
    print("-" * 40)
    for link in report.overperformers[:5]:
        print(f"  [{link.position}] {link.text[:40]}...")
        print(f"      CTR: {link.ctr:.3%} vs {link.expected_ctr:.3%} expected ({link.performance:.1f}x)")
        print(f"      Why: {link.diagnosis}")

    # Missed Stories
    print("\n## STORIES WE MISSED")
    print("-" * 40)
    if report.missed_stories:
        for story in report.missed_stories[:10]:
            print(f"  #{story.rank} [{story.section}] {story.headline[:50]}...")
            print(f"      {story.url}")
    else:
        print("  No significant missed stories found!")

    # Link Text Patterns
    print("\n## LINK TEXT PATTERNS")
    print("-" * 40)
    for pattern, stats in sorted(report.link_text_analysis.items(), key=lambda x: -x[1].get('avg_ctr', 0)):
        perf = stats.get('performance', 0)
        indicator = "✓" if perf > 1.2 else "✗" if perf < 0.8 else "~"
        print(f"  {indicator} {pattern:12s}: {stats.get('avg_ctr', 0):.2%} CTR ({perf:.1f}x baseline)")
        if stats.get('wins'):
            print(f"      Best: \"{stats['wins'][0]['text']}\" ({stats['wins'][0]['ctr']:.2%})")
        if stats.get('losses'):
            print(f"      Worst: \"{stats['losses'][0]['text']}\" ({stats['losses'][0]['ctr']:.3%})")


def main():
    if len(sys.argv) < 2:
        print("Usage: python analyze_v2.py <mode_export.csv> [options]")
        print("\nOptions:")
        print("  --newsletter-html <url>   Newsletter HTML URL or file path")
        print("  --subject <text>          Subject line to analyze")
        print("  --open-rate <float>       Open rate (e.g., 0.35 for 35%)")
        print("  --edition <name>          Edition: asia, europe, or combined")
        print("  --visual-heatmap          Generate visual heatmap HTML overlay")
        print("  --screenshot              Also generate PNG screenshot (requires playwright)")
        print("\nExample:")
        print("  python analyze_v2.py clicks.csv --subject 'Breaking: Major Story' --open-rate 0.38 --visual-heatmap")
        sys.exit(1)

    csv_path = sys.argv[1]

    # Parse optional arguments
    newsletter_url = 'https://static.nytimes.com/email-content/WOR_sample.html'
    subject_line = '[No subject provided]'
    open_rate = 0.34
    edition = 'combined'
    generate_visual = False
    generate_screenshot = False

    args = sys.argv[2:]
    i = 0
    while i < len(args):
        if args[i] == '--newsletter-html' and i + 1 < len(args):
            newsletter_url = args[i + 1]
            i += 2
        elif args[i] == '--subject' and i + 1 < len(args):
            subject_line = args[i + 1]
            i += 2
        elif args[i] == '--open-rate' and i + 1 < len(args):
            open_rate = float(args[i + 1])
            i += 2
        elif args[i] == '--edition' and i + 1 < len(args):
            edition = args[i + 1]
            i += 2
        elif args[i] == '--visual-heatmap':
            generate_visual = True
            i += 1
        elif args[i] == '--screenshot':
            generate_screenshot = True
            generate_visual = True  # Screenshot implies visual heatmap
            i += 1
        else:
            i += 1

    report = generate_report(
        csv_path=csv_path,
        newsletter_url=newsletter_url,
        subject_line=subject_line,
        open_rate=open_rate,
        edition=edition,
    )

    print_report(report)

    # Save JSON report
    output_path = Path(csv_path).stem + '_analysis.json'
    # Convert dataclasses to dicts for JSON
    report_dict = {
        'send_date': report.send_date,
        'edition': report.edition,
        'subject_analysis': {
            'subject': report.subject_analysis.subject,
            'open_rate': report.subject_analysis.open_rate,
            'score': report.subject_analysis.score,
            'diagnosis': report.subject_analysis.diagnosis,
            'alternatives': report.subject_analysis.alternatives,
        },
        'position_heatmap': report.position_heatmap,
        'section_heatmap': report.section_heatmap,
        'underperformers': [
            {'url': l.url, 'text': l.text, 'ctr': l.ctr, 'diagnosis': l.diagnosis}
            for l in report.underperformers
        ],
        'overperformers': [
            {'url': l.url, 'text': l.text, 'ctr': l.ctr, 'diagnosis': l.diagnosis}
            for l in report.overperformers
        ],
        'missed_stories': [
            {'headline': s.headline, 'url': s.url, 'rank': s.rank}
            for s in report.missed_stories
        ],
        'link_text_analysis': report.link_text_analysis,
    }
    Path(output_path).write_text(json.dumps(report_dict, indent=2))
    print(f"\n\nFull report saved to: {output_path}")

    # Generate visual heatmap if requested
    if generate_visual:
        print("\n" + "=" * 40)
        print("GENERATING VISUAL HEATMAP")
        print("=" * 40)

        from visual_heatmap import generate_heatmap_html, take_screenshot

        # Re-fetch newsletter HTML and build click data dict
        html = fetch_html(newsletter_url)
        newsletter_links = parse_newsletter(html)
        clicks = parse_mode_csv(csv_path)
        click_data = {c.url: {'clicks': c.clicks, 'sends': c.sends, 'ctr': c.ctr} for c in clicks}

        # Generate heatmap HTML
        heatmap_html = generate_heatmap_html(html, click_data, newsletter_links)

        heatmap_path = Path(csv_path).stem + '_heatmap.html'
        Path(heatmap_path).write_text(heatmap_html)
        print(f"Visual heatmap saved to: {heatmap_path}")

        # Generate screenshot if requested
        if generate_screenshot:
            screenshot_path = Path(csv_path).stem + '_heatmap.png'
            print(f"Generating screenshot...")
            success = take_screenshot(
                str(Path(heatmap_path).absolute()),
                str(screenshot_path),
                zoom=0.5,
            )
            if success:
                print(f"Screenshot saved to: {screenshot_path}")
            else:
                print("Screenshot failed - open the HTML file in a browser instead")


if __name__ == '__main__':
    main()
