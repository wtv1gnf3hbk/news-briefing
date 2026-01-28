#!/usr/bin/env python3
"""
editions.py - Handle Asia/Europe edition pairing and analysis

The World publishes two editions daily:
- Asia edition: ~4pm ET (same calendar day)
- Europe edition: ~12:30am ET (next calendar day)

These editions share the same content but different audiences/baselines.
This module helps link them together for comparative analysis.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional
import re


# =============================================================================
# EDITION CONFIGURATION
# =============================================================================

@dataclass
class EditionConfig:
    """Configuration for each edition."""
    name: str
    publish_hour_et: int      # Hour in ET when edition publishes
    publish_minute_et: int    # Minute in ET
    baseline_open: float      # 90-day baseline open rate
    baseline_click: float     # 90-day baseline click rate

    # Position-specific CTR baselines (can differ by edition)
    position_ctr: dict = field(default_factory=dict)


EDITIONS = {
    'asia': EditionConfig(
        name='Asia',
        publish_hour_et=16,    # 4pm ET
        publish_minute_et=0,
        baseline_open=0.334,
        baseline_click=0.012,
        position_ctr={
            1: 0.002, 2: 0.006, 3: 0.005, 4: 0.004, 5: 0.003,
            6: 0.003, 7: 0.002, 8: 0.002, 9: 0.001, 10: 0.001,
        }
    ),
    'europe': EditionConfig(
        name='Europe',
        publish_hour_et=0,     # 12:30am ET (next day)
        publish_minute_et=30,
        baseline_open=0.355,
        baseline_click=0.026,
        position_ctr={
            1: 0.003, 2: 0.008, 3: 0.006, 4: 0.005, 5: 0.004,
            6: 0.004, 7: 0.003, 8: 0.003, 9: 0.002, 10: 0.002,
        }
    ),
}


# =============================================================================
# EDITION PAIR
# =============================================================================

@dataclass
class EditionPair:
    """
    A linked pair of Asia and Europe editions.

    The issue_date is the Asia edition's calendar date.
    Europe edition publishes the following calendar day but is part of the same issue.
    """
    issue_date: str           # YYYY-MM-DD of the Asia edition
    subject_line: str         # Shared subject line

    # Asia edition data
    asia_send_date: str = ''  # YYYY-MM-DD HH:MM
    asia_open_rate: float = 0.0
    asia_click_rate: float = 0.0
    asia_sends: int = 0
    asia_csv_path: str = ''

    # Europe edition data
    europe_send_date: str = ''
    europe_open_rate: float = 0.0
    europe_click_rate: float = 0.0
    europe_sends: int = 0
    europe_csv_path: str = ''

    def has_asia(self) -> bool:
        return bool(self.asia_csv_path or self.asia_sends > 0)

    def has_europe(self) -> bool:
        return bool(self.europe_csv_path or self.europe_sends > 0)

    def has_both(self) -> bool:
        return self.has_asia() and self.has_europe()

    def europe_calendar_date(self) -> str:
        """Get Europe's calendar date (day after Asia)."""
        if self.issue_date:
            asia_date = datetime.strptime(self.issue_date, '%Y-%m-%d')
            europe_date = asia_date + timedelta(days=1)
            return europe_date.strftime('%Y-%m-%d')
        return ''


# =============================================================================
# EDITION DETECTION
# =============================================================================

def detect_edition_from_filename(filename: str) -> Optional[str]:
    """
    Detect edition from filename patterns.

    Examples:
        clicks_asia_2026-01-27.csv -> asia
        WOR_europe_01-27.csv -> europe
        the_world_asia.csv -> asia
    """
    filename_lower = filename.lower()

    if 'asia' in filename_lower:
        return 'asia'
    elif 'europe' in filename_lower or 'euro' in filename_lower:
        return 'europe'

    return None


def detect_edition_from_time(send_time: datetime) -> str:
    """
    Detect edition based on send time (ET).

    Asia: 12pm - 8pm ET (typically ~4pm)
    Europe: 8pm - 12pm ET next day (typically ~12:30am)
    """
    hour = send_time.hour

    # Asia window: noon to 8pm
    if 12 <= hour < 20:
        return 'asia'
    # Europe window: 8pm to noon (wraps around midnight)
    else:
        return 'europe'


def detect_edition_from_csv_column(row: dict) -> Optional[str]:
    """
    Detect edition from CSV column value.

    Looks for columns like 'edition', 'market', 'region', 'audience'
    """
    edition_columns = ['edition', 'market', 'region', 'audience', 'segment']

    for col in edition_columns:
        if col in row:
            value = row[col].lower().strip()
            if 'asia' in value:
                return 'asia'
            elif 'europe' in value or 'euro' in value:
                return 'europe'

    return None


def parse_send_date(date_str: str) -> Optional[datetime]:
    """Parse various date formats from Mode exports."""
    formats = [
        '%Y-%m-%d %H:%M:%S',
        '%Y-%m-%d %H:%M',
        '%Y-%m-%d',
        '%m/%d/%Y %H:%M:%S',
        '%m/%d/%Y %H:%M',
        '%m/%d/%Y',
        '%Y-%m-%dT%H:%M:%S',
        '%Y-%m-%dT%H:%M:%SZ',
    ]

    for fmt in formats:
        try:
            return datetime.strptime(date_str.strip(), fmt)
        except ValueError:
            continue

    return None


def get_issue_date(send_datetime: datetime, edition: str) -> str:
    """
    Get the issue date (Asia's calendar date) from send datetime.

    If Europe edition, subtract a day to get the linked Asia date.
    """
    if edition == 'europe':
        # Europe publishes after midnight, so issue date is previous day
        issue_date = send_datetime - timedelta(days=1)
    else:
        issue_date = send_datetime

    return issue_date.strftime('%Y-%m-%d')


# =============================================================================
# EDITION COMPARISON
# =============================================================================

@dataclass
class EditionComparison:
    """Comparison between Asia and Europe performance for a link."""
    url: str
    text: str
    position: int

    asia_clicks: int = 0
    asia_ctr: float = 0.0
    asia_performance: float = 0.0  # vs baseline

    europe_clicks: int = 0
    europe_ctr: float = 0.0
    europe_performance: float = 0.0

    # Computed fields
    ctr_diff: float = 0.0          # europe_ctr - asia_ctr
    ctr_ratio: float = 0.0         # europe_ctr / asia_ctr

    def compute_diff(self):
        """Compute difference metrics."""
        self.ctr_diff = self.europe_ctr - self.asia_ctr
        if self.asia_ctr > 0:
            self.ctr_ratio = self.europe_ctr / self.asia_ctr
        else:
            self.ctr_ratio = float('inf') if self.europe_ctr > 0 else 1.0


def compare_editions(
    asia_clicks: dict,    # url -> ClickData
    europe_clicks: dict,  # url -> ClickData
    links: list,          # NewsletterLinks
) -> list[EditionComparison]:
    """
    Compare performance between Asia and Europe editions.

    Returns list of EditionComparison sorted by biggest CTR difference.
    """
    comparisons = []

    # Get all URLs from both editions
    all_urls = set(asia_clicks.keys()) | set(europe_clicks.keys())

    # Create URL -> link mapping
    url_to_link = {link.url: link for link in links}

    for url in all_urls:
        link = url_to_link.get(url)
        if not link:
            continue

        asia_data = asia_clicks.get(url)
        europe_data = europe_clicks.get(url)

        asia_baseline = EDITIONS['asia'].position_ctr.get(link.position, 0.002)
        europe_baseline = EDITIONS['europe'].position_ctr.get(link.position, 0.003)

        comp = EditionComparison(
            url=url,
            text=link.text,
            position=link.position,
            asia_clicks=asia_data.clicks if asia_data else 0,
            asia_ctr=asia_data.ctr if asia_data else 0,
            asia_performance=(asia_data.ctr / asia_baseline) if asia_data and asia_baseline else 0,
            europe_clicks=europe_data.clicks if europe_data else 0,
            europe_ctr=europe_data.ctr if europe_data else 0,
            europe_performance=(europe_data.ctr / europe_baseline) if europe_data and europe_baseline else 0,
        )
        comp.compute_diff()
        comparisons.append(comp)

    # Sort by absolute CTR difference (biggest swings first)
    comparisons.sort(key=lambda x: abs(x.ctr_diff), reverse=True)

    return comparisons


def print_edition_comparison(comparisons: list[EditionComparison], pair: EditionPair):
    """Print formatted edition comparison report."""
    print("\n" + "=" * 80)
    print(f"EDITION COMPARISON: {pair.issue_date}")
    print(f"Subject: {pair.subject_line}")
    print("=" * 80)

    print(f"\n{'':60} {'ASIA':>10} {'EUROPE':>10} {'DIFF':>10}")
    print("-" * 90)

    # Overall metrics
    print(f"{'Open Rate':<60} {pair.asia_open_rate:>9.1%} {pair.europe_open_rate:>9.1%} {pair.europe_open_rate - pair.asia_open_rate:>+9.1%}")
    print(f"{'Click Rate':<60} {pair.asia_click_rate:>9.2%} {pair.europe_click_rate:>9.2%} {pair.europe_click_rate - pair.asia_click_rate:>+9.2%}")
    print(f"{'Sends':<60} {pair.asia_sends:>10,} {pair.europe_sends:>10,}")

    print("\n## LINKS WITH BIGGEST EDITION DIFFERENCES")
    print("-" * 90)

    # Top differences
    for comp in comparisons[:10]:
        indicator = "🔵" if comp.ctr_diff > 0 else "🔴" if comp.ctr_diff < 0 else "⚪"
        text_preview = comp.text[:45] + "..." if len(comp.text) > 45 else comp.text
        print(f"{indicator} [{comp.position:2d}] {text_preview:<50}")
        print(f"      Asia: {comp.asia_ctr:>6.2%} ({comp.asia_performance:.1f}x)  |  Europe: {comp.europe_ctr:>6.2%} ({comp.europe_performance:.1f}x)  |  Diff: {comp.ctr_diff:>+6.2%}")

    print("\n## INSIGHTS")
    print("-" * 40)

    # Find patterns
    europe_winners = [c for c in comparisons if c.ctr_ratio > 1.5 and c.asia_ctr > 0]
    asia_winners = [c for c in comparisons if c.ctr_ratio < 0.67 and c.asia_ctr > 0]

    if europe_winners:
        print(f"\n{len(europe_winners)} links performed >50% better in Europe:")
        for c in europe_winners[:3]:
            print(f"  • {c.text[:50]}... ({c.ctr_ratio:.1f}x)")

    if asia_winners:
        print(f"\n{len(asia_winners)} links performed >50% better in Asia:")
        for c in asia_winners[:3]:
            print(f"  • {c.text[:50]}... ({1/c.ctr_ratio:.1f}x)")


# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

def get_edition_baseline(edition: str, metric: str) -> float:
    """Get baseline for an edition and metric."""
    config = EDITIONS.get(edition.lower())
    if not config:
        # Default to combined average
        return (EDITIONS['asia'].baseline_click + EDITIONS['europe'].baseline_click) / 2

    if metric == 'open':
        return config.baseline_open
    elif metric == 'click':
        return config.baseline_click
    else:
        return config.position_ctr.get(int(metric), 0.002)


def get_position_baseline(edition: str, position: int) -> float:
    """Get position CTR baseline for an edition."""
    config = EDITIONS.get(edition.lower())
    if config:
        return config.position_ctr.get(position, 0.002)
    # Default combined baseline
    asia_ctr = EDITIONS['asia'].position_ctr.get(position, 0.002)
    europe_ctr = EDITIONS['europe'].position_ctr.get(position, 0.003)
    return (asia_ctr + europe_ctr) / 2
