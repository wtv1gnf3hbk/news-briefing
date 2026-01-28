# Infrastructure: Technical Foundation

## Overview
Centralized hosting and services for all Claude agent projects.

---

## 1. Cloud Server Hosting

### Recommended Setup: Single VPS
One server to rule them all (simplicity over complexity).

**Provider Options:**
| Provider | Spec | Monthly | Notes |
|----------|------|---------|-------|
| DigitalOcean | 2 vCPU, 4GB, 80GB | $24 | Best docs, simple |
| Linode | 2 vCPU, 4GB, 80GB | $24 | Akamai backing |
| Hetzner | 2 vCPU, 4GB, 40GB | $6 | Europe-based, cheapest |
| Fly.io | Pay-per-use | ~$5-20 | Good for multiple small apps |

**Recommended**: Hetzner (cost) or DigitalOcean (ease)

### Server Architecture
```
┌─────────────────────────────────────────────┐
│                 VPS (Ubuntu 22.04)          │
├─────────────────────────────────────────────┤
│  nginx (reverse proxy)                      │
│    ├── briefing.yourdomain.com → :3001      │
│    ├── biggest-story.yourdomain.com → :3002 │
│    ├── distractify.yourdomain.com → :3003   │
│    └── api.yourdomain.com → :3000           │
├─────────────────────────────────────────────┤
│  pm2 (process manager)                      │
│    ├── news-briefing                        │
│    ├── worlds-biggest-story                 │
│    ├── habit-tracker                        │
│    └── distractify                          │
├─────────────────────────────────────────────┤
│  cron jobs                                  │
│    ├── 6:00 AM: generate-briefing.js        │
│    ├── 6:05 AM: write-briefing.js           │
│    └── 6:10 AM: worlds-biggest-story.js     │
├─────────────────────────────────────────────┤
│  SQLite / PostgreSQL                        │
│    └── Shared data store                    │
└─────────────────────────────────────────────┘
```

### Setup Commands
```bash
# Initial server setup
ssh root@your-server

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
apt install -y nodejs

# Install nginx
apt install -y nginx certbot python3-certbot-nginx

# Install pm2
npm install -g pm2

# Clone projects
mkdir -p /var/www
cd /var/www
git clone https://github.com/yourusername/news-briefing.git

# Set up environment
cp .env.example .env
nano .env  # Add ANTHROPIC_API_KEY

# Start with pm2
cd /var/www/news-briefing
pm2 start generate-briefing.js --name briefing-gen --cron "0 6 * * *"
pm2 save
pm2 startup
```

---

## 2. Paywall Access Workflow

### The Problem
Need to access paywalled content (NYT, WSJ, etc.) for research without manual copying.

### Solution: Browser Extension + Local Proxy

**Architecture:**
```
Browser (logged into sites)
    ↓
Extension captures article HTML
    ↓
Sends to local endpoint
    ↓
Saves to ~/articles/{source}/{date}/{slug}.html
    ↓
Claude can read local files
```

**Extension Pseudocode:**
```javascript
// content-script.js
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.action === 'capture') {
    const article = document.querySelector('article') || document.body;
    fetch('http://localhost:9999/save', {
      method: 'POST',
      body: JSON.stringify({
        url: window.location.href,
        title: document.title,
        html: article.innerHTML,
        text: article.innerText
      })
    });
  }
});
```

**Local Server:**
```javascript
// article-saver.js
const http = require('http');
const fs = require('fs');
const path = require('path');

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/save') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const data = JSON.parse(body);
      const date = new Date().toISOString().split('T')[0];
      const slug = data.url.split('/').pop().replace(/[^a-z0-9]/gi, '-');
      const dir = path.join(process.env.HOME, 'articles', date);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(data, null, 2));
      res.end('saved');
    });
  }
}).listen(9999);
```

### Alternative: Puppeteer with Cookie Import
Export cookies from browser, use in headless Puppeteer session.

---

## 3. Link Ingester (PDF)

### Purpose
Extract text from PDF links for briefing research.

### Implementation
```javascript
// pdf-ingester.js
const pdf = require('pdf-parse');
const https = require('https');
const fs = require('fs');

async function ingestPDF(url) {
  // Download PDF
  const buffer = await new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
  });

  // Parse text
  const data = await pdf(buffer);
  return {
    url,
    pages: data.numpages,
    text: data.text,
    extracted: new Date().toISOString()
  };
}

// Usage
// node pdf-ingester.js https://example.com/report.pdf
```

**Dependencies:**
```bash
npm install pdf-parse
```

---

## 4. Offline LLM

### Purpose
Run models locally for:
- Privacy-sensitive tasks
- Cost reduction for high-volume queries
- Experimentation without API limits

### Recommended Setup: Ollama + Mistral/Llama

**Installation:**
```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull models
ollama pull mistral        # 7B, fast, good for most tasks
ollama pull llama2:13b     # Larger, better reasoning
ollama pull codellama      # Code-specific

# Run
ollama serve
```

**Usage from Node.js:**
```javascript
const response = await fetch('http://localhost:11434/api/generate', {
  method: 'POST',
  body: JSON.stringify({
    model: 'mistral',
    prompt: 'Summarize this article...',
    stream: false
  })
});
const result = await response.json();
console.log(result.response);
```

### Hardware Requirements
- Minimum: 16GB RAM, any modern CPU
- Recommended: 32GB RAM, Apple Silicon or NVIDIA GPU
- For 13B+ models: 32GB+ RAM required

### When to Use Local vs. API
| Task | Local (Ollama) | API (Claude) |
|------|----------------|--------------|
| Quick summaries | ✓ | |
| Code generation | ✓ | |
| Complex reasoning | | ✓ |
| Nuanced writing | | ✓ |
| Privacy-sensitive | ✓ | |
| High volume (100+/day) | ✓ | |

---

## 5. Deployment Checklist

### Initial Setup
- [ ] Provision VPS (recommend Hetzner or DO)
- [ ] Configure DNS for subdomains
- [ ] Set up SSL with certbot
- [ ] Install Node.js, nginx, pm2
- [ ] Clone all project repos
- [ ] Configure environment variables
- [ ] Set up pm2 processes
- [ ] Configure cron jobs

### Security
- [ ] Disable root SSH login
- [ ] Set up SSH keys only (no passwords)
- [ ] Configure UFW firewall
- [ ] Set up fail2ban
- [ ] Regular apt updates (unattended-upgrades)

### Monitoring
- [ ] Set up UptimeRobot or similar
- [ ] pm2 logs rotation
- [ ] Disk space alerts
- [ ] Error notification (email or Slack)

---

## Cost Estimate

| Item | Monthly |
|------|---------|
| VPS (Hetzner 4GB) | $6 |
| Domain | $1 |
| Claude API (est.) | $20-50 |
| **Total** | **~$30-60** |
