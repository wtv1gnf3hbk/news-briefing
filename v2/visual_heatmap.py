#!/usr/bin/env python3
"""
visual_heatmap.py - Generate visual newsletter heatmap with color-coded links

Creates an HTML file (and optional PNG screenshot) showing the newsletter
with links colored by performance:
  - Green = better than expected
  - Yellow = at expected
  - Red = worse than expected

Usage:
    python visual_heatmap.py <mode_export.csv> [--newsletter-html <url>] [--screenshot]

Requirements for screenshot:
    pip install playwright
    playwright install chromium
"""

import re
import sys
import json
import urllib.request
from pathlib import Path
from html.parser import HTMLParser
from dataclasses import dataclass
from typing import Optional

# Import sibling modules
from parse_newsletter import parse_newsletter, fetch_html, NewsletterLink


# =============================================================================
# CONFIGURATION
# =============================================================================

# Position CTR baselines
POSITION_CTR_BASELINE = {
    1: 0.002, 2: 0.006, 3: 0.005, 4: 0.004, 5: 0.003,
    6: 0.003, 7: 0.002, 8: 0.002, 9: 0.001, 10: 0.001,
}

# Color scale (performance ratio -> color)
def performance_to_color(perf: float) -> str:
    """
    Convert performance ratio to color.
    perf = actual_ctr / expected_ctr

    < 0.5  = deep red
    0.5-1  = red to yellow gradient
    1-2    = yellow to green gradient
    > 2    = deep green
    """
    if perf <= 0:
        return "rgba(220, 53, 69, 0.7)"  # red
    elif perf < 0.5:
        return "rgba(220, 53, 69, 0.7)"  # red
    elif perf < 1.0:
        # Red to yellow (0.5 -> 1.0)
        ratio = (perf - 0.5) / 0.5
        r = 220
        g = int(53 + (200 - 53) * ratio)
        b = int(69 * (1 - ratio))
        return f"rgba({r}, {g}, {b}, 0.7)"
    elif perf < 2.0:
        # Yellow to green (1.0 -> 2.0)
        ratio = (perf - 1.0) / 1.0
        r = int(255 * (1 - ratio))
        g = int(200 + 55 * ratio)
        b = int(0 + 100 * ratio)
        return f"rgba({r}, {g}, {b}, 0.6)"
    else:
        return "rgba(40, 167, 69, 0.6)"  # green


def performance_to_label(perf: float) -> str:
    """Get human-readable label for performance."""
    if perf < 0.5:
        return "poor"
    elif perf < 0.8:
        return "below avg"
    elif perf < 1.2:
        return "expected"
    elif perf < 2.0:
        return "good"
    else:
        return "excellent"


# =============================================================================
# CSV PARSING (simplified from analyze_v2)
# =============================================================================

def parse_mode_csv(filepath: str) -> dict[str, dict]:
    """Parse Mode CSV and return url -> {clicks, ctr, ...} mapping."""
    import csv

    url_data = {}
    with open(filepath, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            row = {k.lower().strip(): v for k, v in row.items()}

            url = row.get('url') or row.get('link_url') or row.get('href', '')
            clicks = int(row.get('clicks') or row.get('total_clicks') or 0)
            sends = int(row.get('sends') or row.get('total_sends') or 1)
            ctr = clicks / sends if sends > 0 else 0

            url_data[url] = {
                'clicks': clicks,
                'sends': sends,
                'ctr': ctr,
            }

    return url_data


# =============================================================================
# HTML TRANSFORMER
# =============================================================================

class HeatmapTransformer(HTMLParser):
    """Transform newsletter HTML to add heatmap colors to links."""

    def __init__(self, url_performance: dict[str, float]):
        super().__init__()
        self.url_performance = url_performance  # url -> performance ratio
        self.output = []
        self.link_count = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]):
        attrs_dict = dict(attrs)

        if tag == 'a':
            href = attrs_dict.get('href', '')

            # Check if this is an NYT article link we have data for
            perf = self._get_performance(href)

            if perf is not None:
                self.link_count += 1
                color = performance_to_color(perf)
                label = performance_to_label(perf)

                # Build new attributes with heatmap styling
                new_attrs = []
                existing_style = attrs_dict.get('style', '')

                heatmap_style = (
                    f"background: {color} !important; "
                    f"padding: 2px 4px !important; "
                    f"border-radius: 3px !important; "
                    f"text-decoration: none !important; "
                    f"position: relative !important; "
                )

                for name, value in attrs:
                    if name == 'style':
                        new_attrs.append(('style', existing_style + '; ' + heatmap_style))
                    else:
                        new_attrs.append((name, value))

                if 'style' not in attrs_dict:
                    new_attrs.append(('style', heatmap_style))

                # Add data attributes for tooltip
                new_attrs.append(('data-perf', f"{perf:.2f}"))
                new_attrs.append(('data-label', label))
                new_attrs.append(('title', f"Performance: {perf:.1f}x ({label})"))

                attrs = new_attrs

        # Rebuild tag
        attr_str = ''
        for name, value in attrs:
            if value is not None:
                attr_str += f' {name}="{value}"'
            else:
                attr_str += f' {name}'

        self.output.append(f'<{tag}{attr_str}>')

    def handle_endtag(self, tag: str):
        self.output.append(f'</{tag}>')

    def handle_data(self, data: str):
        self.output.append(data)

    def handle_entityref(self, name: str):
        self.output.append(f'&{name};')

    def handle_charref(self, name: str):
        self.output.append(f'&#{name};')

    def handle_comment(self, data: str):
        self.output.append(f'<!--{data}-->')

    def handle_decl(self, decl: str):
        self.output.append(f'<!{decl}>')

    def _get_performance(self, url: str) -> Optional[float]:
        """Get performance ratio for URL, or None if not tracked."""
        if not url or 'nytimes.com' not in url or '/20' not in url:
            return None

        # Direct match
        if url in self.url_performance:
            return self.url_performance[url]

        # Try normalized match (strip query params)
        normalized = url.split('?')[0].rstrip('/')
        for stored_url, perf in self.url_performance.items():
            if stored_url.split('?')[0].rstrip('/') == normalized:
                return perf

        return None

    def get_output(self) -> str:
        return ''.join(self.output)


# =============================================================================
# HEATMAP GENERATION
# =============================================================================

def generate_heatmap_html(
    newsletter_html: str,
    click_data: dict[str, dict],
    newsletter_links: list[NewsletterLink],
) -> str:
    """
    Generate newsletter HTML with heatmap overlay.

    Returns modified HTML with colored links.
    """
    # Calculate performance for each URL
    url_performance = {}

    for link in newsletter_links:
        if link.url in click_data:
            data = click_data[link.url]
            expected = POSITION_CTR_BASELINE.get(link.position, 0.002)
            actual = data['ctr']
            perf = actual / expected if expected > 0 else 1.0
            url_performance[link.url] = perf

    # Transform HTML
    transformer = HeatmapTransformer(url_performance)
    transformer.feed(newsletter_html)
    colored_html = transformer.get_output()

    # Wrap with legend and styling
    legend_html = """
    <div id="heatmap-legend" style="
        position: fixed;
        top: 10px;
        right: 10px;
        background: white;
        border: 2px solid #333;
        border-radius: 8px;
        padding: 15px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 12px;
        z-index: 10000;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        max-width: 200px;
    ">
        <strong style="font-size: 14px;">Click Heatmap</strong>
        <div style="margin-top: 10px;">
            <div style="display: flex; align-items: center; margin: 4px 0;">
                <span style="width: 20px; height: 20px; background: rgba(40, 167, 69, 0.6); border-radius: 3px; margin-right: 8px;"></span>
                <span>2x+ expected</span>
            </div>
            <div style="display: flex; align-items: center; margin: 4px 0;">
                <span style="width: 20px; height: 20px; background: rgba(200, 220, 50, 0.6); border-radius: 3px; margin-right: 8px;"></span>
                <span>At expected</span>
            </div>
            <div style="display: flex; align-items: center; margin: 4px 0;">
                <span style="width: 20px; height: 20px; background: rgba(220, 53, 69, 0.7); border-radius: 3px; margin-right: 8px;"></span>
                <span>&lt;0.5x expected</span>
            </div>
        </div>
        <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #ddd; font-size: 11px; color: #666;">
            Hover links for details
        </div>
    </div>
    """

    # Inject legend after body tag
    if '<body' in colored_html.lower():
        # Find end of body tag
        body_match = re.search(r'<body[^>]*>', colored_html, re.IGNORECASE)
        if body_match:
            insert_pos = body_match.end()
            colored_html = colored_html[:insert_pos] + legend_html + colored_html[insert_pos:]
    else:
        colored_html = legend_html + colored_html

    return colored_html


def take_screenshot(html_path: str, output_path: str, zoom: float = 0.5):
    """
    Take a screenshot of the heatmap HTML using Playwright.

    Args:
        html_path: Path to the HTML file
        output_path: Path for the PNG output
        zoom: Zoom level (0.5 = 50% size for overview)
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Playwright not installed. Install with:")
        print("  pip install playwright")
        print("  playwright install chromium")
        return False

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(
            viewport={'width': 800, 'height': 2000},
            device_scale_factor=2,  # Retina quality
        )

        # Load the HTML file
        page.goto(f'file://{html_path}')

        # Wait for content to load
        page.wait_for_load_state('networkidle')

        # Apply zoom
        page.evaluate(f'document.body.style.zoom = "{zoom}"')

        # Get full page height
        height = page.evaluate('document.body.scrollHeight')

        # Take full-page screenshot
        page.screenshot(
            path=output_path,
            full_page=True,
        )

        browser.close()
        return True


# =============================================================================
# MAIN
# =============================================================================

def main():
    if len(sys.argv) < 2:
        print("Usage: python visual_heatmap.py <mode_export.csv> [options]")
        print("\nOptions:")
        print("  --newsletter-html <url>   Newsletter HTML URL or file")
        print("  --output <path>           Output HTML path (default: heatmap.html)")
        print("  --screenshot              Also generate PNG screenshot")
        print("  --zoom <float>            Screenshot zoom level (default: 0.5)")
        print("\nExample:")
        print("  python visual_heatmap.py clicks.csv --screenshot --zoom 0.4")
        sys.exit(1)

    csv_path = sys.argv[1]

    # Parse arguments
    newsletter_url = 'https://static.nytimes.com/email-content/WOR_sample.html'
    output_path = Path(__file__).parent / 'heatmap.html'
    do_screenshot = False
    zoom = 0.5

    args = sys.argv[2:]
    i = 0
    while i < len(args):
        if args[i] == '--newsletter-html' and i + 1 < len(args):
            newsletter_url = args[i + 1]
            i += 2
        elif args[i] == '--output' and i + 1 < len(args):
            output_path = Path(args[i + 1])
            i += 2
        elif args[i] == '--screenshot':
            do_screenshot = True
            i += 1
        elif args[i] == '--zoom' and i + 1 < len(args):
            zoom = float(args[i + 1])
            i += 2
        else:
            i += 1

    # Load data
    print(f"Loading click data from {csv_path}...")
    click_data = parse_mode_csv(csv_path)
    print(f"  Loaded {len(click_data)} URLs")

    print(f"\nFetching newsletter from {newsletter_url}...")
    newsletter_html = fetch_html(newsletter_url)

    print("Parsing newsletter links...")
    newsletter_links = parse_newsletter(newsletter_html)
    print(f"  Found {len(newsletter_links)} links")

    # Generate heatmap
    print("\nGenerating heatmap...")
    heatmap_html = generate_heatmap_html(
        newsletter_html,
        click_data,
        newsletter_links,
    )

    # Save HTML
    output_path.write_text(heatmap_html)
    print(f"Saved heatmap HTML to: {output_path}")

    # Screenshot if requested
    if do_screenshot:
        screenshot_path = output_path.with_suffix('.png')
        print(f"\nGenerating screenshot (zoom={zoom})...")

        success = take_screenshot(
            str(output_path.absolute()),
            str(screenshot_path),
            zoom=zoom,
        )

        if success:
            print(f"Saved screenshot to: {screenshot_path}")
        else:
            print("Screenshot generation failed (Playwright not available)")
            print("You can still open the HTML file in a browser.")

    print("\nDone! Open the HTML file in a browser to see the heatmap.")
    print("Hover over links to see performance details.")


if __name__ == '__main__':
    main()
