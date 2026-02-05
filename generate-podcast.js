#!/usr/bin/env node
/**
 * Generate audio podcast from briefing.md using ElevenLabs API
 * Uses the "Alice" voice (British, clear educator style)
 *
 * Requires: ELEVENLABS_API_KEY environment variable
 */

const https = require('https');
const fs = require('fs');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// Alice voice ID from ElevenLabs (British, clear educator style)
const VOICE_ID = 'Xb7hH8MSUJpSbSDYk0k2';

if (!ELEVENLABS_API_KEY) {
  console.error('Missing ELEVENLABS_API_KEY environment variable');
  process.exit(1);
}

/**
 * Convert markdown briefing to spoken script
 * - Removes links but keeps the link text
 * - Converts bullet points to natural spoken list
 * - Adds natural pauses and transitions
 */
function markdownToScript(markdown) {
  let script = markdown
    // Remove markdown links but keep text: [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove bold markers
    .replace(/\*\*(.+?)\*\*/g, '$1')
    // Convert bullet points to spoken format
    .replace(/^- /gm, '')
    // Clean up multiple newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Add intro and outro
  script = `Right then, here's what's happening in the world today.\n\n${script}\n\nThat's your world update for today.`;

  return script;
}

/**
 * Call ElevenLabs text-to-speech API
 */
function generateSpeech(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text: text,
      model_id: 'eleven_turbo_v2_5',  // Faster model, slightly lower quality but good enough
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true
      }
    });

    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${VOICE_ID}`,
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          reject(new Error(`ElevenLabs API error ${res.statusCode}: ${data}`));
        });
        return;
      }

      // Collect binary audio data
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    });

    req.on('error', reject);
    req.setTimeout(180000, () => {
      req.destroy();
      reject(new Error('ElevenLabs API timeout (3 min)'));
    });

    req.write(body);
    req.end();
  });
}

async function main() {
  // Read the briefing markdown
  console.log('Reading briefing.md...');
  if (!fs.existsSync('briefing.md')) {
    console.error('briefing.md not found. Run write-briefing.js first.');
    process.exit(1);
  }

  const markdown = fs.readFileSync('briefing.md', 'utf8');

  // Convert to spoken script
  console.log('Converting to spoken script...');
  const script = markdownToScript(markdown);
  console.log(`Script length: ${script.length} characters`);

  // Check script length (ElevenLabs has limits)
  if (script.length > 5000) {
    console.warn('⚠️ Script is long - may take a while to generate');
  }

  // Generate audio
  console.log('Generating audio with ElevenLabs (Alice voice)...');
  const startTime = Date.now();

  try {
    const audioBuffer = await generateSpeech(script);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Audio generated in ${elapsed}s`);

    // Save the MP3
    fs.writeFileSync('podcast.mp3', audioBuffer);
    const sizeKb = Math.round(audioBuffer.length / 1024);
    console.log(`Saved podcast.mp3 (${sizeKb} KB)`);

    // Save metadata
    const metadata = {
      generated: new Date().toISOString(),
      voice: {
        id: VOICE_ID,
        name: 'Alice',
        accent: 'British',
        style: 'clear educator'
      },
      script: script,
      size_kb: sizeKb
    };
    fs.writeFileSync('podcast-metadata.json', JSON.stringify(metadata, null, 2));
    console.log('Saved podcast-metadata.json');

    console.log('✅ Podcast generated successfully');

  } catch (e) {
    console.error('❌ Failed to generate podcast:', e.message);
    process.exit(1);
  }
}

main();
