# Agent

A Slack bot named **Agent** that answers when @mentioned in a channel or messaged directly (DM), powered by Groq's `llama-3.1-8b-instant` model. Built with `@slack/bolt` in Socket Mode.

## Features

- Responds to `@mentions` in channels and to direct messages.
- Posts a "thinking..." placeholder, then edits it in place as the response streams in (`chat.update`), rather than waiting for the full completion.
- Keeps the last 6 messages of context per thread in an in-memory `Map` (no database) — each message truncated to 500 characters before being sent to the model.
- One retry with exponential backoff on Groq API errors/rate limits, a 15s request timeout, and a clean fallback message on failure.

## Prerequisites

- Node.js 18+ (for built-in `fetch`/`AbortController` support used by the Groq SDK).
- A Slack app named "Agent" already created and installed to your workspace with Socket Mode enabled and the following scopes:
  - `app_mentions:read`
  - `chat:write`
  - `channels:history`
  - `im:history`
  - `im:read`
  - `im:write`
- A Groq API key.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your `.env` file from the example (skip this if `.env` already exists):

   ```bash
   cp .env.example .env
   ```

3. Fill in `.env` with your real values:

   ```
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   GROQ_API_KEY=gsk_...
   ```

   - `SLACK_BOT_TOKEN`: the bot token (`xoxb-...`) from **OAuth & Permissions**.
   - `SLACK_APP_TOKEN`: an app-level token (`xapp-...`) with the `connections:write` scope, generated under **Basic Information → App-Level Tokens**.
   - `GROQ_API_KEY`: your API key from the Groq console.

## Run

```bash
npm start
```

You should see:

```
⚡️ Agent is running (Socket Mode)
```

## Usage

- In a channel the bot has been invited to: `@Agent what's the capital of France?`
- In a DM: just send a message directly to the bot.

Replies in a channel are posted as a thread reply to the mention; DM context is kept per-DM-channel across messages (last 6 messages, each capped at 500 characters).

## Notes

- Memory is in-process only (a plain `Map`) — it resets when the process restarts. There is no database or vector store.
- If the Groq API errors, times out (15s), or is rate-limited, the bot retries once with exponential backoff before falling back to an apologetic message edited into the original "thinking..." post.
