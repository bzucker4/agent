# Agent

A Slack bot named **Agent** that answers when @mentioned in a channel or messaged directly (DM), powered by Groq's `openai/gpt-oss-20b` model. Built with `@slack/bolt` in Socket Mode.

## Features

- Responds to `@mentions` in channels and to direct messages.
- Posts a "thinking..." placeholder, then edits it in place as the response streams in (`chat.update`), rather than waiting for the full completion.
- Keeps the last 6 messages of context per thread in an in-memory `Map` (no database) — each message truncated to 500 characters before being sent to the model.
- **PDF generation**: a message starting with `pdf:` (case-insensitive) generates a one-page PDF instead of a chat reply — see [PDF generation](#pdf-generation) below.
- **Search mode**: a message starting with `search:` (case-insensitive) routes the request to Groq's `groq/compound` model instead of the default chat model, for questions that benefit from web-grounded answers.
- **Email drafting and sending**: a message starting with `email:` drafts and, on confirmation, sends an email via the Gmail API — see [Email drafting and sending](#email-drafting-and-sending) below.
- One retry with exponential backoff on Groq/Gmail API errors/rate limits, a 15s request timeout, and a clean fallback message on failure (applies to the plain-chat completion, the PDF content-structuring call, the file upload step, the email draft call, and the Gmail send call).

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
- (Optional, for email) A Google Cloud OAuth client of type **Desktop app**, with the Gmail API enabled on that project — see [Email drafting and sending](#email-drafting-and-sending).

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
   - `ALLOWED_EMAIL_USER_ID` (optional, needed for email): your Slack user ID (e.g. `U0123ABCDEF` — find it via your Slack profile → **More** → **Copy member ID**). Only this user can trigger the `email:` flow; if unset, email is disabled for everyone.

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

## Email drafting and sending

Trigger with `email: to <address> | subject: <subject> | <description of what to write>`:

```
@Agent email: to jane@example.com | subject: Q3 roadmap | a friendly note recapping our roadmap call and asking her to send over the slides
```

What happens:

1. Groq (same `openai/gpt-oss-20b` model) drafts the email body from your description.
2. The bot posts a preview in the thread — recipient, subject, and body — and asks you to confirm.
3. Reply **"send it"** (case-insensitive) in that same thread to send it via the Gmail API, or **"cancel"** to discard it. Unconfirmed drafts expire after 10 minutes and are silently discarded (nothing is ever sent automatically).

Email requests, drafts, and the confirm/cancel exchange are a separate flow from plain chat — none of it is added to the per-thread conversation history.

Only the Slack user set as `ALLOWED_EMAIL_USER_ID` can use this flow — everyone else gets a polite "not authorized" reply, since triggering it sends real email from your connected Gmail account.

### Gmail setup (one-time)

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a project, enable the **Gmail API**, and create an OAuth client ID of type **Desktop app**. Download it as `credentials.json` into the project root (already gitignored).
2. Run the authorization script to get a consent URL:

   ```bash
   node authorize-gmail.js
   ```

3. Open the printed URL, sign in, and grant access. The browser will then try to redirect to `localhost` and fail to load — that's expected, nothing is listening there. Copy either the full URL from the address bar or just the `code=` value from it.
4. Exchange that code for a refresh token:

   ```bash
   node authorize-gmail.js "<code or full redirected URL>"
   ```

   This writes `token.json` (also gitignored), so the bot won't ask you to re-authorize on restart.
5. Start (or restart) the bot as usual.

If `credentials.json`/`token.json` aren't present when someone triggers `email:`, the bot replies with a message telling them to run `npm run authorize-gmail` instead of failing silently.

### Gmail setup on Railway (or other deploys without a persistent filesystem)

`credentials.json`/`token.json` are gitignored, so a git-based deploy won't have them. Instead, set two env vars with the file contents as JSON strings:

- `GOOGLE_CREDENTIALS_JSON` — contents of your local `credentials.json`
- `GOOGLE_TOKEN_JSON` — contents of your local `token.json` (generated by `authorize-gmail.js` above)

When both are set, the bot reads Gmail auth from them instead of the local files. Note the access token googleapis refreshes internally won't be persisted anywhere in this mode (Railway's filesystem doesn't survive redeploys) — that's fine as long as the refresh token in `GOOGLE_TOKEN_JSON` stays valid, which is what actually gets reused on each restart.

## Notes

- Memory is in-process only (a plain `Map`) — it resets when the process restarts. There is no database or vector store.
- If the Groq API errors, times out (15s), or is rate-limited, the bot retries once with exponential backoff before falling back to an apologetic message edited into the original "thinking..." post. The same retry/timeout/fallback pattern applies to the PDF content-generation call, the file upload step, the email draft call, and the Gmail send call.
- Pending email drafts live in-process only (a plain `Map`, one per thread) — they're lost on restart, same as chat history.
