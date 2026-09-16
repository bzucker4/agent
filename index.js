require('dotenv').config();

const { App } = require('@slack/bolt');
const Groq = require('groq-sdk');

const SYSTEM_PROMPT =
  'You are Agent, a helpful and concise assistant in this Slack workspace. ' +
  'Keep responses brief and to the point unless asked for detail. ' +
  'Use Slack-friendly formatting (bullet points, bold) sparingly.';

const MODEL = 'llama-3.1-8b-instant';
const MAX_TOKENS = 500;
const MAX_HISTORY_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 500;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 1;
const STREAM_UPDATE_INTERVAL_MS = 1000;
const FALLBACK_MESSAGE =
  "Sorry, I'm having trouble reaching the assistant right now. Please try again in a moment.";

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

async function streamGroqCompletion(messages, onDelta) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const abortController = new AbortController();
    try {
      let fullText = '';
      await withTimeout(
        async () => {
          const stream = await groq.chat.completions.create(
            {
              model: MODEL,
              messages,
              max_tokens: MAX_TOKENS,
              stream: true,
            },
            { signal: abortController.signal }
          );

          for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              onDelta(fullText);
            }
          }
        },
        REQUEST_TIMEOUT_MS,
        abortController
      );
      return fullText;
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

async function handleMessage({ client, channel, threadKey, threadTs, userText }) {
  appendToHistory(threadKey, 'user', userText);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...getHistory(threadKey),
  ];

  const initial = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: 'thinking...',
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
    const fullText = await streamGroqCompletion(messages, (partial) => {
      latestText = partial;
      flushUpdate(false);
    });

    latestText = fullText.trim() || "I don't have a response for that.";
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

app.event('app_mention', async ({ event, client }) => {
  try {
    const threadTs = event.thread_ts || event.ts;
    const threadKey = `${event.channel}:${threadTs}`;
    const userText = stripMention(event.text || '');
    if (!userText) return;

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
