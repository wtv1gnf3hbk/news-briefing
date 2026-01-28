#!/usr/bin/env python3
"""
fetch_trending.py - Scrape NYT trending and other newsletter data

Fetches "stories we missed" candidates from:
- NYT Trending page (https://www.nytimes.com/trending/)
- Other NYT newsletters (Morning, Cooking, etc.) when available

Usage:
    python fetch_trending.py [--output trending.json]
"""

import re
import sys
import json
import urllib.request
from html.parser import HTMLParser
from dataclasses import dataclass, asdict
from typing import Optional
from pathlib import Path
from datetime import datetime


@dataclass
class TrendingStory:
    """A trending or high-performing story from NYT."""
    headline: str
    url: str
    source: str           # 'trending', 'morning', 'cooking', etc.
    rank: int             # Position in the list (1-indexed)
    section: str          # news section: world, politics, business, etc.
    fetch_time: str       # ISO timestamp


class NYTTrendingParser(HTMLParser):
    """Parse NYT trending page."""

    def __init__(self):
        super().__init__()
        self.stories: list[dict] = []
        self.in_article = False
        self.in_headline = False
        self.current_story: dict = {}
        self.current_text: list[str] = []
        self.rank = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]):
        attrs_dict = dict(attrs)
        class_name = attrs_dict.get('class', '')

        # Look for article containers
        if tag == 'article' or (tag == 'li' and 'story' in class_name.lower()):
            self.in_article = True
            self.current_story = {}

        # Look for headline links within articles
        if self.in_article and tag == 'a':
            href = attrs_dict.get('href', '')
            if href and '/20' in href and 'nytimes.com' in href:
                self.current_story['url'] = href
                self.in_headline = True
                self.current_text = []

        # Also capture standalone headline links
        if tag == 'a' and not self.in_article:
            href = attrs_dict.get('href', '')
            if href and '/20' in href and 'nytimes.com' in href:
                self.current_story = {'url': href}
                self.in_headline = True
                self.current_text = []

    def handle_endtag(self, tag: str):
        if tag == 'a' and self.in_headline:
            self.in_headline = False
            text = ' '.join(self.current_text).strip()
            text = re.sub(r'\s+', ' ', text)
            if text and self.current_story.get('url'):
                self.current_story['headline'] = text
                self.rank += 1
                self.current_story['rank'] = self.rank
                self.stories.append(self.current_story.copy())
            self.current_text = []

        if tag in ('article', 'li') and self.in_article:
            self.in_article = False
            self.current_story = {}

    def handle_data(self, data: str):
        if self.in_headline:
            self.current_text.append(data)


def extract_section_from_url(url: str) -> str:
    """Extract the news section from a NYT URL."""
    patterns = [
        (r'/world/', 'world'),
        (r'/us/', 'us'),
        (r'/politics/', 'politics'),
        (r'/business/', 'business'),
        (r'/technology/', 'technology'),
        (r'/science/', 'science'),
        (r'/health/', 'health'),
        (r'/sports/', 'sports'),
        (r'/arts/', 'arts'),
        (r'/books/', 'books'),
        (r'/style/', 'style'),
        (r'/food/', 'food'),
        (r'/travel/', 'travel'),
        (r'/opinion/', 'opinion'),
        (r'/climate/', 'climate'),
    ]
    for pattern, section in patterns:
        if re.search(pattern, url, re.IGNORECASE):
            return section
    return 'other'


def fetch_html(url: str) -> str:
    """Fetch HTML from URL with proper headers."""
    req = urllib.request.Request(
        url,
        headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
        }
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return response.read().decode('utf-8')


def fetch_trending() -> list[TrendingStory]:
    """Fetch stories from NYT trending page."""
    url = 'https://www.nytimes.com/trending/'
    fetch_time = datetime.utcnow().isoformat() + 'Z'

    try:
        html = fetch_html(url)
        parser = NYTTrendingParser()
        parser.feed(html)

        stories = []
        seen_urls = set()

        for item in parser.stories:
            if item['url'] in seen_urls:
                continue
            seen_urls.add(item['url'])

            story = TrendingStory(
                headline=item.get('headline', ''),
                url=item['url'],
                source='trending',
                rank=item.get('rank', 0),
                section=extract_section_from_url(item['url']),
                fetch_time=fetch_time,
            )
            stories.append(story)

        return stories

    except Exception as e:
        print(f"Warning: Could not fetch trending: {e}")
        return []


def fetch_newsletter_archive(newsletter: str = 'morning') -> list[TrendingStory]:
    """
    Fetch recent stories from other NYT newsletters.

    Newsletter options: 'morning', 'evening', 'cooking', 'well', 'climate'
    """
    # NYT newsletter archive URLs
    newsletter_urls = {
        'morning': 'https://www.nytimes.com/series/the-morning',
        'evening': 'https://www.nytimes.com/series/the-evening',
        'cooking': 'https://www.nytimes.com/series/sam-sifton-cooking-newsletter',
    }

    if newsletter not in newsletter_urls:
        return []

    url = newsletter_urls[newsletter]
    fetch_time = datetime.utcnow().isoformat() + 'Z'

    try:
        html = fetch_html(url)
        parser = NYTTrendingParser()
        parser.feed(html)

        stories = []
        seen_urls = set()

        for item in parser.stories[:20]:  # Limit to recent stories
            if item['url'] in seen_urls:
                continue
            seen_urls.add(item['url'])

            story = TrendingStory(
                headline=item.get('headline', ''),
                url=item['url'],
                source=newsletter,
                rank=item.get('rank', 0),
                section=extract_section_from_url(item['url']),
                fetch_time=fetch_time,
            )
            stories.append(story)

        return stories

    except Exception as e:
        print(f"Warning: Could not fetch {newsletter} newsletter: {e}")
        return []


def load_from_json(filepath: str) -> list[TrendingStory]:
    """Load previously saved trending data."""
    data = json.loads(Path(filepath).read_text())
    return [TrendingStory(**item) for item in data]


def main():
    output_path = Path(__file__).parent / 'trending.json'

    # Parse args
    if '--output' in sys.argv:
        idx = sys.argv.index('--output')
        if idx + 1 < len(sys.argv):
            output_path = Path(sys.argv[idx + 1])

    print("Fetching NYT trending stories...")
    trending = fetch_trending()
    print(f"  Found {len(trending)} trending stories")

    print("\nFetching Morning newsletter archive...")
    morning = fetch_newsletter_archive('morning')
    print(f"  Found {len(morning)} stories from Morning")

    all_stories = trending + morning

    # Deduplicate by URL
    seen = set()
    unique_stories = []
    for story in all_stories:
        if story.url not in seen:
            seen.add(story.url)
            unique_stories.append(story)

    print(f"\nTotal unique stories: {len(unique_stories)}")

    # Group by section
    by_section: dict[str, list[TrendingStory]] = {}
    for story in unique_stories:
        if story.section not in by_section:
            by_section[story.section] = []
        by_section[story.section].append(story)

    print("\nBy section:")
    for section, stories in sorted(by_section.items(), key=lambda x: -len(x[1])):
        print(f"  {section}: {len(stories)}")

    # Save to JSON
    output_data = [asdict(s) for s in unique_stories]
    output_path.write_text(json.dumps(output_data, indent=2))
    print(f"\nSaved to {output_path}")

    return unique_stories


if __name__ == '__main__':
    main()
