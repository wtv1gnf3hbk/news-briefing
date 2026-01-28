#!/usr/bin/env python3
"""
parse_newsletter.py - Extract link text and positions from newsletter HTML

Parses "The World" newsletter HTML to extract:
- All links with their text, URL, and position
- Section boundaries (lead, highlights, around the world, etc.)
- Position metadata for click analysis

Usage:
    python parse_newsletter.py [html_file_or_url]

Default: https://static.nytimes.com/email-content/WOR_sample.html
"""

import re
import sys
import json
import urllib.request
from html.parser import HTMLParser
from dataclasses import dataclass, asdict
from typing import Optional
from pathlib import Path


@dataclass
class NewsletterLink:
    """Represents a single link in the newsletter."""
    position: int           # 1-indexed position in newsletter
    url: str
    text: str
    section: str            # lead, highlights, around_the_world, business, etc.
    section_position: int   # position within section (1-indexed)
    word_count: int         # number of words in link text
    is_headline: bool       # True if this appears to be a headline link
    pattern: str            # classified pattern: question, fragment, descriptive, etc.


class NewsletterParser(HTMLParser):
    """Parse newsletter HTML and extract links with position metadata."""

    # Section markers - adjust based on actual newsletter structure
    SECTION_MARKERS = {
        'lead': ['good morning', 'here\'s the state of play', 'top story'],
        'highlights': ['what else is happening', 'here\'s more', 'also today'],
        'around_the_world': ['around the world', 'global news', 'international'],
        'business': ['business', 'markets', 'economy'],
        'technology': ['technology', 'tech'],
        'opinion': ['opinion', 'commentary'],
        'closing': ['have a great', 'see you tomorrow', 'thanks for reading'],
    }

    def __init__(self):
        super().__init__()
        self.links: list[NewsletterLink] = []
        self.current_section = 'lead'
        self.section_positions: dict[str, int] = {}
        self.global_position = 0
        self.current_text = []
        self.in_link = False
        self.current_href = ''
        self.full_text = []  # Track all text for section detection

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]):
        if tag == 'a':
            attrs_dict = dict(attrs)
            href = attrs_dict.get('href', '')
            # Filter to only include NYT article links
            if href and 'nytimes.com' in href and '/20' in href:
                self.in_link = True
                self.current_href = href
                self.current_text = []

    def handle_endtag(self, tag: str):
        if tag == 'a' and self.in_link:
            self.in_link = False
            if self.current_href and self.current_text:
                text = ' '.join(self.current_text).strip()
                text = re.sub(r'\s+', ' ', text)  # Normalize whitespace

                if text and len(text) > 1:  # Skip empty or single-char links
                    self.global_position += 1

                    # Update section position
                    if self.current_section not in self.section_positions:
                        self.section_positions[self.current_section] = 0
                    self.section_positions[self.current_section] += 1

                    link = NewsletterLink(
                        position=self.global_position,
                        url=self.current_href,
                        text=text,
                        section=self.current_section,
                        section_position=self.section_positions[self.current_section],
                        word_count=len(text.split()),
                        is_headline=self._is_headline(text),
                        pattern=self._classify_pattern(text),
                    )
                    self.links.append(link)

            self.current_href = ''
            self.current_text = []

    def handle_data(self, data: str):
        if self.in_link:
            self.current_text.append(data)

        # Track text for section detection
        text_lower = data.lower().strip()
        if text_lower:
            self.full_text.append(text_lower)
            self._detect_section(text_lower)

    def _detect_section(self, text: str):
        """Detect section changes based on text markers."""
        for section, markers in self.SECTION_MARKERS.items():
            for marker in markers:
                if marker in text:
                    self.current_section = section
                    return

    def _is_headline(self, text: str) -> bool:
        """Determine if link text appears to be a headline."""
        # Headlines typically: start with capital, no ending punctuation except ?
        # or are title case, longer than 3 words
        if len(text.split()) >= 4:
            return True
        if text[0].isupper() and not text.endswith('.'):
            return True
        return False

    def _classify_pattern(self, text: str) -> str:
        """Classify link text pattern for analysis."""
        text_lower = text.lower()

        # Question pattern
        if '?' in text or text_lower.startswith(('who ', 'what ', 'where ', 'when ', 'why ', 'how ')):
            return 'question'

        # Fragment pattern (no verb, short)
        words = text.split()
        if len(words) <= 3:
            return 'fragment'

        # Verb-first / action pattern
        action_verbs = ['says', 'claims', 'announces', 'reveals', 'shows', 'finds',
                       'reports', 'warns', 'argues', 'explains', 'suggests']
        if any(verb in text_lower for verb in action_verbs):
            return 'action'

        # Numbers pattern
        if any(char.isdigit() for char in text):
            return 'numeric'

        # Quote pattern
        if '"' in text or "'" in text or text.startswith(('"', "'")):
            return 'quote'

        # Default: descriptive
        return 'descriptive'


def fetch_html(source: str) -> str:
    """Fetch HTML from URL or local file."""
    if source.startswith('http'):
        req = urllib.request.Request(
            source,
            headers={'User-Agent': 'Mozilla/5.0 (newsletter-analytics)'}
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.read().decode('utf-8')
    else:
        return Path(source).read_text()


def parse_newsletter(html: str) -> list[NewsletterLink]:
    """Parse newsletter HTML and return list of links with metadata."""
    parser = NewsletterParser()
    parser.feed(html)
    return parser.links


def to_dataframe_format(links: list[NewsletterLink]) -> list[dict]:
    """Convert links to list of dicts for pandas/CSV export."""
    return [asdict(link) for link in links]


def main():
    # Default to sample newsletter
    source = sys.argv[1] if len(sys.argv) > 1 else 'https://static.nytimes.com/email-content/WOR_sample.html'

    print(f"Fetching newsletter from: {source}")

    try:
        html = fetch_html(source)
        links = parse_newsletter(html)

        print(f"\nFound {len(links)} links\n")
        print("=" * 80)

        # Group by section
        sections: dict[str, list[NewsletterLink]] = {}
        for link in links:
            if link.section not in sections:
                sections[link.section] = []
            sections[link.section].append(link)

        for section, section_links in sections.items():
            print(f"\n## {section.upper()} ({len(section_links)} links)")
            print("-" * 40)
            for link in section_links:
                print(f"  {link.position:2d}. [{link.pattern:11s}] {link.text[:60]}...")

        # Output JSON for further processing
        output = to_dataframe_format(links)
        output_path = Path(__file__).parent / 'newsletter_links.json'
        output_path.write_text(json.dumps(output, indent=2))
        print(f"\n\nSaved {len(links)} links to {output_path}")

        return links

    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
