# Agent

A Slack bot named **Agent** that answers when @mentioned in a channel or messaged directly (DM), powered by Groq's `openai/gpt-oss-20b` model. Built with `@slack/bolt` in Socket Mode.

## Features

- Responds to `@mentions` in channels and to direct messages.
- Posts a "thinking..." placeholder, then edits it in place as the response streams in (`chat.update`), rather than waiting for the full completion.
- Keeps the last 6 messages of context per thread in an in-memory `Map` (no database) — each message truncated to 500 characters before being sent to the model.
- **PDF generation**: a message starting with `pdf:` (case-insensitive) generates a one-page PDF instead of a chat reply — see [PDF generation](#pdf-generation) below.
- One retry with exponential backoff on Groq API errors/rate limits, a 15s request timeout, and a clean fallback message on failure (applies to the plain-chat completion, the PDF content-structuring call, and the file upload step).

## Prerequisites

- Node.js 18+ (for built-in `fetch`/`AbortController` support used by the Groq SDK).
- A Slack app named "Agent" already created and installed to your workspace with Socket Mode enabled and the following scopes:
  - `app_mentions:read`
  - `chat:write`
  - `channels:history`
  - `im:history`
  - `im:read`
  - `im:write`
  - `files:write` — **required for PDF uploads** (`files.uploadV2`); add this scope under **OAuth & Permissions** and reinstall the app if it wasn't already granted.
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

## PDF generation

Start a message with `pdf:` (case-insensitive) to get a one-page PDF instead of a chat reply:

```
@Agent pdf: a one-pager on our Q3 roadmap, goals and risks
```

```
pdf: meeting notes template with sections for agenda, decisions, and action items
```

What happens under the hood:

1. Groq (same `openai/gpt-oss-20b` model, JSON mode) turns your instruction into structured content: `{ title, sections: [{ heading?, body?, bullets? }] }`.
2. `pdf-lib` renders that content onto a single US Letter page (50pt margins, Helvetica body / Helvetica-Bold headings), wrapping text to fit and truncating gracefully if the content would overflow the page — it never spills onto a second page.
3. The PDF is uploaded straight into the thread via `files.uploadV2`, and the "thinking..." message is edited to a short confirmation once it posts.

PDF requests are a separate flow from plain chat — they are not added to the per-thread conversation history used for regular replies.

## Notes

- Memory is in-process only (a plain `Map`) — it resets when the process restarts. There is no database or vector store.
- If the Groq API errors, times out (15s), or is rate-limited, the bot retries once with exponential backoff before falling back to an apologetic message edited into the original "thinking..." post. The same retry/timeout/fallback pattern applies to the PDF content-generation call and to the file upload step.
