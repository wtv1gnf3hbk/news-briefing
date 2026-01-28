#!/usr/bin/env python3
"""
analyze.py - V1 Newsletter Analytics (Simple Baseline)

Basic analysis of newsletter performance from Mode CSV export.
For full analysis with all features, use v2/analyze_v2.py

Usage:
    python analyze.py <mode_export.csv>

Output:
    - Top/bottom performing links
    - Basic CTR statistics
    - Position performance summary
"""

import csv
import sys
from collections import defaultdict
from pathlib import Path


# Baselines
BASELINE_CTR = {
    'asia': 0.012,
    'europe': 0.026,
    'combined': 0.019,
}

BASELINE_OPEN = {
    'asia': 0.334,
    'europe': 0.355,
    'combined': 0.345,
}


def parse_csv(filepath: str) -> list[dict]:
    """Parse Mode CSV export into list of dicts."""
    rows = []
    with open(filepath, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            # Normalize keys
            normalized = {k.lower().strip(): v for k, v in row.items()}

            # Extract key fields
            url = normalized.get('url') or normalized.get('link_url', '')
            clicks = int(normalized.get('clicks') or normalized.get('total_clicks') or 0)
            sends = int(normalized.get('sends') or normalized.get('total_sends') or 1)
            link_text = normalized.get('link_text', '')
            position = int(normalized.get('position') or 0)

            ctr = clicks / sends if sends > 0 else 0

            rows.append({
                'url': url,
                'clicks': clicks,
                'sends': sends,
                'ctr': ctr,
                'link_text': link_text,
                'position': position,
            })

    return rows


def analyze(data: list[dict], edition: str = 'combined'):
    """Run basic analysis and print results."""
    baseline = BASELINE_CTR.get(edition, 0.019)

    # Filter to links with clicks
    links_with_data = [d for d in data if d['sends'] > 0]

    if not links_with_data:
        print("No data to analyze!")
        return

    # Sort by CTR
    by_ctr = sorted(links_with_data, key=lambda x: x['ctr'], reverse=True)

    # Basic stats
    total_clicks = sum(d['clicks'] for d in links_with_data)
    avg_ctr = sum(d['ctr'] for d in links_with_data) / len(links_with_data)
    max_ctr = max(d['ctr'] for d in links_with_data)
    min_ctr = min(d['ctr'] for d in links_with_data)

    print("=" * 60)
    print("NEWSLETTER PERFORMANCE ANALYSIS (V1)")
    print("=" * 60)

    print(f"\n## OVERVIEW")
    print(f"Total links analyzed: {len(links_with_data)}")
    print(f"Total clicks: {total_clicks:,}")
    print(f"Average CTR: {avg_ctr:.2%}")
    print(f"Baseline CTR ({edition}): {baseline:.2%}")
    print(f"Performance vs baseline: {avg_ctr/baseline:.1f}x")

    print(f"\n## TOP 5 PERFORMERS")
    print("-" * 60)
    for i, link in enumerate(by_ctr[:5], 1):
        text = link['link_text'][:40] or link['url'][:40]
        print(f"{i}. [{link['position']}] {text}...")
        print(f"   CTR: {link['ctr']:.2%} | Clicks: {link['clicks']}")

    print(f"\n## BOTTOM 5 PERFORMERS")
    print("-" * 60)
    for i, link in enumerate(by_ctr[-5:], 1):
        text = link['link_text'][:40] or link['url'][:40]
        print(f"{i}. [{link['position']}] {text}...")
        print(f"   CTR: {link['ctr']:.3%} | Clicks: {link['clicks']}")

    # Position analysis
    print(f"\n## PERFORMANCE BY POSITION")
    print("-" * 60)
    by_position = defaultdict(list)
    for link in links_with_data:
        if link['position'] > 0:
            by_position[link['position']].append(link['ctr'])

    print(f"{'Position':>8} {'Avg CTR':>10} {'Count':>6}")
    for pos in sorted(by_position.keys())[:10]:
        ctrs = by_position[pos]
        avg = sum(ctrs) / len(ctrs)
        print(f"{pos:>8} {avg:>9.2%} {len(ctrs):>6}")

    # Underperformers (below 50% of baseline)
    underperformers = [d for d in links_with_data if d['ctr'] < baseline * 0.5]
    if underperformers:
        print(f"\n## UNDERPERFORMERS ({len(underperformers)} links below 50% baseline)")
        print("-" * 60)
        for link in sorted(underperformers, key=lambda x: x['ctr'])[:5]:
            text = link['link_text'][:50] or link['url'][:50]
            print(f"  [{link['position']}] {text}")
            print(f"      {link['ctr']:.3%} CTR ({link['ctr']/baseline:.0%} of baseline)")

    print("\n" + "=" * 60)
    print("For detailed analysis with subject lines, link patterns,")
    print("and story suggestions, use: python v2/analyze_v2.py")
    print("=" * 60)


def main():
    if len(sys.argv) < 2:
        print("Usage: python analyze.py <mode_export.csv> [edition]")
        print("\nEdition options: asia, europe, combined (default)")
        sys.exit(1)

    csv_path = sys.argv[1]
    edition = sys.argv[2] if len(sys.argv) > 2 else 'combined'

    if not Path(csv_path).exists():
        print(f"Error: File not found: {csv_path}")
        sys.exit(1)

    data = parse_csv(csv_path)
    analyze(data, edition)


if __name__ == '__main__':
    main()
