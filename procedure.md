# The World Newsletter Analytics - Procedure

Step-by-step guide for running newsletter performance analysis.

## Data Sources

| Source | URL | Access |
|--------|-----|--------|
| Mode Dashboard | https://app.mode.com/nytimes/reports/935f63aaed8f | Manual CSV export |
| Newsletter HTML | https://static.nytimes.com/email-content/WOR_sample.html | Auto-fetched |
| NYT Trending | https://www.nytimes.com/trending/ | Auto-scraped |

## Edition Schedule

The World publishes **two editions daily** with different audiences:

| Edition | Publish Time (ET) | Calendar Date | Audience |
|---------|-------------------|---------------|----------|
| **Asia** | ~4:00pm | Same day | Asia-Pacific readers |
| **Europe** | ~12:30am | Next day | European readers |

**Important**: Both editions share the same content/subject line but publish on different calendar days. When analyzing, they should be linked as a pair but compared separately.

Example: "Xi's Purge" issue
- Asia edition: Jan 27, 4pm ET → Mode shows as Jan 27
- Europe edition: Jan 28, 12:30am ET → Mode shows as Jan 28
- Both are the same "issue" and should be analyzed together

## Step 1: Export Click Data from Mode

1. Open the Mode dashboard: https://app.mode.com/nytimes/reports/935f63aaed8f

2. Set the date filter to the send date you want to analyze
   - For **Asia**: Use the issue date (e.g., Jan 27)
   - For **Europe**: Use the next calendar day (e.g., Jan 28)

3. Export the click data:
   - Click the **Export** button (top right)
   - Select **CSV**
   - Save with edition in filename: `clicks_asia_2024-01-27.csv` or `clicks_europe_2024-01-28.csv`

4. Required columns in the export:
   ```
   url (or link_url)     - The clicked link URL
   clicks                - Total click count
   unique_clicks         - Unique clicker count (optional)
   sends                 - Total emails sent
   link_text             - The link text shown (optional but helpful)
   position              - Link position in newsletter (optional)
   edition               - asia/europe (optional - can detect from filename)
   ```

## Step 2: Get Newsletter HTML (Optional)

If analyzing a specific send (not the sample):

1. Find the newsletter HTML URL from the send system
2. Or save the HTML locally from your email client (View Source)
3. Pass to analyzer with `--newsletter-html` flag

## Step 3: Run Analysis

### Quick Analysis (V1)
```bash
python analyze.py clicks_2024-01-15.csv
```

### Full Analysis (V2)
```bash
python v2/analyze_v2.py clicks_2024-01-15.csv \
  --subject "Your subject line here" \
  --open-rate 0.35 \
  --edition asia
```

Options:
- `--subject` - The subject line used (for subject analysis)
- `--open-rate` - The open rate as decimal (0.35 = 35%)
- `--edition` - asia, europe, or combined
- `--newsletter-html` - URL or file path to newsletter HTML
- `--visual-heatmap` - Generate color-coded HTML overlay
- `--screenshot` - Also generate PNG screenshot (requires playwright)

### Visual Heatmap
```bash
# Generate HTML with colored links (green=good, red=bad)
python v2/analyze_v2.py clicks.csv --visual-heatmap

# Also generate a PNG screenshot (zoomed out overview)
python v2/analyze_v2.py clicks.csv --visual-heatmap --screenshot
```

Or run the heatmap generator directly:
```bash
python v2/visual_heatmap.py clicks.csv --screenshot --zoom 0.4
```

The heatmap shows:
- **Green** = 2x+ expected CTR
- **Yellow** = At expected CTR
- **Red** = <0.5x expected CTR

Hover over links to see exact performance numbers.

For screenshots, install Playwright:
```bash
pip install playwright
playwright install chromium
```

### Compare Asia & Europe Editions

To analyze both editions side-by-side and see what performed differently:

```bash
python v2/analyze_v2.py --compare \
  --asia-csv clicks_asia_2024-01-27.csv \
  --europe-csv clicks_europe_2024-01-28.csv \
  --subject "Xi's Purge of the Chinese Military" \
  --asia-open-rate 0.33 \
  --europe-open-rate 0.36 \
  --newsletter-html newsletter.html
```

Edition comparison options:
- `--compare` - Enable edition comparison mode
- `--asia-csv <path>` - Path to Asia edition CSV
- `--europe-csv <path>` - Path to Europe edition CSV
- `--asia-open-rate <float>` - Asia open rate (default: 0.334)
- `--europe-open-rate <float>` - Europe open rate (default: 0.355)

The comparison shows:
- Side-by-side open rates and click rates
- Links with biggest performance differences between editions
- Which stories resonated more with Asian vs European readers
- Individual detailed analysis for each edition

## Step 4: Review Output

The analyzer outputs:

1. **Subject Line Analysis**
   - Score vs baseline
   - What worked/didn't work
   - Alternative suggestions

2. **Position Heatmap**
   - CTR by position (1, 2, 3...)
   - Expected vs actual performance
   - Drop-off identification

3. **Section Heatmap**
   - CTR by section (lead, highlights, around the world...)

4. **Underperformers**
   - Links performing below expectations
   - Diagnosis: bad position? link text? topic?

5. **Overperformers**
   - Links that beat expectations
   - What made them work

6. **Stories We Missed**
   - Trending stories not in newsletter
   - Stories that performed well elsewhere

7. **Link Text Patterns**
   - Which patterns work: questions, fragments, action verbs
   - Best/worst examples

## Baselines (90-day averages)

| Metric | Asia | Europe |
|--------|------|--------|
| Open Rate | 33.4% | 35.5% |
| Click Rate | 1.2% | 2.6% |

Position CTR benchmarks:
- Position 1 (lead): ~0.2%
- Position 2: ~0.6% ← sweet spot
- Position 3-5: ~0.3-0.5%
- Position 6+: ~0.1-0.2%

## Automation Ideas

### Daily Analysis
```bash
# Download yesterday's data and run analysis
DATE=$(date -d "yesterday" +%Y-%m-%d)
python v2/analyze_v2.py "clicks_${DATE}.csv" \
  --edition combined > "reports/analysis_${DATE}.txt"
```

### Batch Historical Analysis
```bash
for file in clicks_*.csv; do
  python analyze.py "$file" >> historical_summary.txt
done
```

## Troubleshooting

**"No data to analyze"**
- Check CSV has the required columns
- Verify column names match expected (url, clicks, sends)

**Low trending story matches**
- Trending page may have changed structure
- Check `v2/fetch_trending.py` output manually

**Position data missing**
- Mode export may not include position
- Add position column manually or use newsletter HTML parsing

## Files Reference

```
news-briefing/
├── analyze.py              # V1 simple analyzer
├── procedure.md            # This file
└── v2/
    ├── analyze_v2.py       # Full analysis engine
    ├── parse_newsletter.py # Newsletter HTML parser
    ├── fetch_trending.py   # NYT trending scraper
    ├── visual_heatmap.py   # Color-coded newsletter overlay
    └── editions.py         # Asia/Europe edition handling & comparison
```
