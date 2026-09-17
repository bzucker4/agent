require('dotenv').config();

const { App } = require('@slack/bolt');
const Groq = require('groq-sdk');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const SYSTEM_PROMPT =
  'You are Agent, a helpful and concise assistant in this Slack workspace. ' +
  'Keep responses brief and to the point unless asked for detail. ' +
  'Use Slack-friendly formatting (bullet points, bold) sparingly.';

const PDF_SYSTEM_PROMPT =
  "You turn a user's request into structured content for a one-page PDF. " +
  'Respond with ONLY a JSON object (no markdown, no code fences) matching this shape: ' +
  '{"title": string, "sections": [{"heading": string (optional), "body": string (optional), "bullets": string[] (optional)}]}. ' +
  'Keep it concise enough to fit on a single page: at most 5 sections, each with a short body ' +
  '(1-3 sentences) and/or up to 5 short bullets.';

const MODEL = 'openai/gpt-oss-20b';
const SEARCH_MODEL = 'groq/compound';
const SEARCH_TRIGGER = /^search:\s*/i;
const MAX_TOKENS = 500;
const PDF_MAX_TOKENS = 1200;
const MAX_HISTORY_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 500;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 1;
const STREAM_UPDATE_INTERVAL_MS = 1000;
const FALLBACK_MESSAGE =
  "Sorry, I'm having trouble reaching the assistant right now. Please try again in a moment.";
const PDF_FALLBACK_MESSAGE =
  "Sorry, I couldn't generate that PDF right now. Please try again in a moment.";

const PDF_TRIGGER_REGEX = /^pdf:\s*/i;

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const PAGE_MARGIN = 50;
const TITLE_FONT_SIZE = 22;
const HEADING_FONT_SIZE = 14;
const BODY_FONT_SIZE = 11;
const LINE_GAP = 4;
const TITLE_GAP = 20;
const SECTION_GAP = 16;
const BULLET_INDENT = 14;
const BULLET_CHAR = '•';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// threadKey -> array of { role, content }, most recent MAX_HISTORY_MESSAGES kept
const conversations = new Map();

function truncate(text) {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return text.slice(0, MAX_MESSAGE_CHARS);
}

function getHistory(threadKey) {
  return conversations.get(threadKey) || [];
}

function appendToHistory(threadKey, role, content) {
  const history = getHistory(threadKey);
  history.push({ role, content: truncate(content) });
  while (history.length > MAX_HISTORY_MESSAGES) history.shift();
  conversations.set(threadKey, history);
}

function stripMention(text) {
  return text.replace(/<@[^>]+>\s*/g, '').trim();
}

function isPdfRequest(text) {
  return PDF_TRIGGER_REGEX.test(text);
}

function extractPdfInstruction(text) {
  return text.replace(PDF_TRIGGER_REGEX, '').trim();
}

function toSlackFormatting(text) {
  // Convert **bold** -> *bold* (Slack mrkdwn uses single asterisks for bold)
  let out = text.replace(/\*\*(.+?)\*\*/g, '*$1*');
  // Convert markdown headers (## Heading) into bold lines
  out = out.replace(/^#{1,6}\s*(.+)$/gm, '*$1*');
  return out;
}

// Detects a leading "search:" trigger, strips it, and reports which model to use
function resolveModelAndText(rawText) {
  if (SEARCH_TRIGGER.test(rawText)) {
    return {
      model: SEARCH_MODEL,
      text: rawText.replace(SEARCH_TRIGGER, '').trim(),
    };
  }
  return { model: MODEL, text: rawText };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promiseFactory, ms, abortController) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      abortController.abort();
      reject(new Error('Request timed out'));
    }, ms);
  });
  return Promise.race([promiseFactory(), timeout]);
}

// Shared one-retry-with-backoff + timeout wrapper for Groq calls and the
// Slack file upload step.
async function withRetry(requestFn) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const abortController = new AbortController();
    try {
      return await withTimeout(() => requestFn(abortController.signal), REQUEST_TIMEOUT_MS, abortController);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        const backoffMs = 1000 * 2 ** attempt;
        await sleep(backoffMs);
      }
    }
  }
  throw lastError;
}

async function streamGroqCompletion(model, messages, onDelta) {
  return withRetry(async (signal) => {
    let fullText = '';
    const stream = await groq.chat.completions.create(
      {
        model,
        messages,
        max_tokens: MAX_TOKENS,
        stream: true,
      },
      { signal }
    );

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        fullText += delta;
        onDelta(fullText);
      }
    }
    return fullText;
  });
}

function normalizePdfContent(parsed) {
  const title =
    typeof parsed?.title === 'string' && parsed.title.trim() ? parsed.title.trim() : 'Untitled';

  const rawSections = Array.isArray(parsed?.sections) ? parsed.sections : [];
  const sections = rawSections.map((section) => ({
    heading: typeof section?.heading === 'string' ? section.heading.trim() : undefined,
    body: typeof section?.body === 'string' ? section.body.trim() : '',
    bullets: Array.isArray(section?.bullets)
      ? section.bullets.filter((b) => typeof b === 'string' && b.trim()).map((b) => b.trim())
      : [],
  }));

  return { title, sections };
}

async function getPdfContent(instruction) {
  const messages = [
    { role: 'system', content: PDF_SYSTEM_PROMPT },
    { role: 'user', content: truncate(instruction) },
  ];

  return withRetry(async (signal) => {
    const completion = await groq.chat.completions.create(
      {
        model: MODEL,
        messages,
        max_tokens: PDF_MAX_TOKENS,
        response_format: { type: 'json_object' },
      },
      { signal }
    );
    const raw = completion.choices?.[0]?.message?.content || '';
    return normalizePdfContent(JSON.parse(raw));
  });
}

function wrapText(text, font, fontSize, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      currentLine = candidate;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

async function generatePdf(content) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const contentWidth = PAGE_WIDTH - PAGE_MARGIN * 2;
  const bottomLimit = PAGE_MARGIN;
  let y = PAGE_HEIGHT - PAGE_MARGIN;
  let fits = true;

  // Draws one line at the current cursor and advances it; returns false
  // (without drawing) once there's no more room, so callers can stop
  // gracefully instead of overflowing the page.
  const drawLine = (text, font, size, x, gapAfter) => {
    if (y - size < bottomLimit) {
      fits = false;
      return false;
    }
    page.drawText(text, { x, y: y - size, size, font });
    y -= size + gapAfter;
    return true;
  };

  const titleLines = wrapText(content.title, helveticaBold, TITLE_FONT_SIZE, contentWidth);
  for (const line of titleLines) {
    if (!drawLine(line, helveticaBold, TITLE_FONT_SIZE, PAGE_MARGIN, LINE_GAP)) break;
  }
  if (fits) y -= TITLE_GAP - LINE_GAP;

  outer: for (const section of content.sections) {
    if (!fits) break;

    if (section.heading) {
      const headingLines = wrapText(section.heading, helveticaBold, HEADING_FONT_SIZE, contentWidth);
      for (const line of headingLines) {
        if (!drawLine(line, helveticaBold, HEADING_FONT_SIZE, PAGE_MARGIN, LINE_GAP)) break outer;
      }
    }

    if (section.body) {
      const bodyLines = wrapText(section.body, helvetica, BODY_FONT_SIZE, contentWidth);
      for (const line of bodyLines) {
        if (!drawLine(line, helvetica, BODY_FONT_SIZE, PAGE_MARGIN, LINE_GAP)) break outer;
      }
    }

    for (const bullet of section.bullets) {
      const bulletLines = wrapText(bullet, helvetica, BODY_FONT_SIZE, contentWidth - BULLET_INDENT);
      for (let i = 0; i < bulletLines.length; i++) {
        const prefix = i === 0 ? `${BULLET_CHAR} ` : '  ';
        if (!drawLine(`${prefix}${bulletLines[i]}`, helvetica, BODY_FONT_SIZE, PAGE_MARGIN + BULLET_INDENT, LINE_GAP)) {
          break outer;
        }
      }
    }

    y -= SECTION_GAP - LINE_GAP;
  }

  return pdfDoc.save();
}

function slugifyFilename(title) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${slug || 'document'}.pdf`;
}

async function handleMessage({ client, channel, threadKey, threadTs, userText }) {
  const { model, text: cleanText } = resolveModelAndText(userText);
  if (!cleanText) return;

  appendToHistory(threadKey, 'user', cleanText);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...getHistory(threadKey),
  ];

  const initial = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: model === SEARCH_MODEL ? 'searching...' : 'thinking...',
  });

  let lastUpdateAt = 0;
  let latestText = '';

  const flushUpdate = async (force) => {
    const now = Date.now();
    if (!force && now - lastUpdateAt < STREAM_UPDATE_INTERVAL_MS) return;
    lastUpdateAt = now;
    try {
      await client.chat.update({
        channel,
        ts: initial.ts,
        text: latestText || 'thinking...',
      });
    } catch (err) {
      // ignore transient update errors; final flush will retry via return value
    }
  };

  try {
    const fullText = await streamGroqCompletion(model, messages, (partial) => {
      latestText = partial;
      flushUpdate(false);
    });

    latestText = toSlackFormatting(fullText.trim() || "I don't have a response for that.");
    await client.chat.update({
      channel,
      ts: initial.ts,
      text: latestText,
    });

    appendToHistory(threadKey, 'assistant', latestText);
  } catch (error) {
    console.error('Groq request failed:', error);
    await client.chat.update({
      channel,
      ts: initial.ts,
      text: FALLBACK_MESSAGE,
    });
  }
}

async function handlePdfRequest({ client, channel, threadTs, instruction }) {
  const initial = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: 'thinking... (generating PDF)',
  });

  try {
    const content = await getPdfContent(instruction);
    const pdfBytes = await generatePdf(content);

    await withRetry(() =>
      client.files.uploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        filename: slugifyFilename(content.title),
        file: Buffer.from(pdfBytes),
      })
    );

    await client.chat.update({
      channel,
      ts: initial.ts,
      text: `📄 Here's your PDF: *${content.title}*`,
    });
  } catch (error) {
    console.error('PDF generation failed:', error);
    await client.chat.update({
      channel,
      ts: initial.ts,
      text: PDF_FALLBACK_MESSAGE,
    });
  }
}

app.event('app_mention', async ({ event, client }) => {
  try {
    const threadTs = event.thread_ts || event.ts;
    const threadKey = `${event.channel}:${threadTs}`;
    const userText = stripMention(event.text || '');
    if (!userText) return;

    if (isPdfRequest(userText)) {
      const instruction = extractPdfInstruction(userText);
      if (!instruction) return;
      await handlePdfRequest({ client, channel: event.channel, threadTs, instruction });
      return;
    }

    await handleMessage({
      client,
      channel: event.channel,
      threadKey,
      threadTs,
      userText,
    });
  } catch (error) {
    console.error('Error handling app_mention:', error);
  }
});

app.message(async ({ message, client }) => {
  try {
    if (message.channel_type !== 'im') return;
    if (message.subtype || message.bot_id) return;

    const threadKey = `${message.channel}:dm`;
    const userText = (message.text || '').trim();
    if (!userText) return;

    if (isPdfRequest(userText)) {
      const instruction = extractPdfInstruction(userText);
      if (!instruction) return;
      await handlePdfRequest({
        client,
        channel: message.channel,
        threadTs: message.thread_ts,
        instruction,
      });
      return;
    }

    await handleMessage({
      client,
      channel: message.channel,
      threadKey,
      threadTs: message.thread_ts,
      userText,
    });
  } catch (error) {
    console.error('Error handling DM:', error);
  }
});

(async () => {
  await app.start();
  console.log('⚡️ Agent is running (Socket Mode)');
})();
