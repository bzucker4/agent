# Agent

A Slack bot named **Agent** that answers when @mentioned in a channel or messaged directly (DM), powered by Groq's `openai/gpt-oss-20b` model. Built with `@slack/bolt` in Socket Mode.

## Features

- Responds to `@mentions` in channels and to direct messages.
- **Natural-language tool use**: every message goes to the model with three tools attached — `web_search`, `generate_pdf`, and `draft_email` — and the model decides whether to call none, one, or several, chaining them when one needs another's output (e.g. "search for X and email bob@example.com a summary" searches, then drafts the email from the results). No prefixes needed — see [How tool use works](#how-tool-use-works).
- Posts a "thinking..." placeholder and updates it with the current step ("searching...", "generating PDF...", "drafting email...") before editing in the final reply.
- Keeps the last 6 messages of context per thread in an in-memory `Map` (no database) — each message truncated to 500 characters before being sent to the model.
- **Web search**: questions needing current information are answered using Groq's built-in `browser_search` tool.
- **PDF generation**: asking for a PDF / one-pager / document generates a one-page PDF and uploads it to the thread — see [PDF generation](#pdf-generation) below.
- **Email drafting and sending**: asking to email someone drafts an email and, only after you reply "send it", sends it via the Gmail API — see [Email drafting and sending](#email-drafting-and-sending) below.
- One retry with exponential backoff on Groq/Gmail API errors/rate limits, a 15s request timeout (30s for web search), and a clean fallback message on failure.

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
   - `ALLOWED_EMAIL_USER_ID` (optional, needed for email): your Slack user ID (e.g. `U0123ABCDEF` — find it via your Slack profile → **More** → **Copy member ID**). Only this user gets the email tool; if unset, email is disabled for everyone.

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

Once the bot has replied in a channel thread, further replies in that same thread don't need another `@Agent` mention — any plain reply there is treated as directed at the bot. Mentioning it again also still works (and is what's required to address it in a brand-new thread). This doesn't apply across different threads or to unrelated channel messages — only to a thread the bot has already posted into.

## How tool use works

Each message is sent to `openai/gpt-oss-20b` along with the thread history and these tool definitions:

| Tool | Arguments | What it does |
|---|---|---|
| `web_search` | `query` | Runs a separate `openai/gpt-oss-20b` call with Groq's built-in `browser_search` tool and returns a short summary with sources (capped at 3,000 chars, marked as untrusted content). |
| `generate_pdf` | `title`, `sections[]` (`heading?`, `body?`, `bullets?`) | Renders a one-page PDF and uploads it to the thread. |
| `draft_email` | `recipient`, `subject`, `body` | Shows a draft preview in the thread. **Never sends** — see below. Only offered to `ALLOWED_EMAIL_USER_ID`. |

If the model calls tools, the bot runs them, feeds the results back, and lets the model decide what to do next — call another tool or reply. This repeats for up to 4 rounds, after which the model must answer in text. Per message, `web_search` can run at most 3 times and `generate_pdf` / `draft_email` once each. Only your messages and the final replies are stored in thread history — tool results aren't.

## PDF generation

Ask naturally, e.g.:

```
@Agent make me a one-pager on our Q3 roadmap, goals and risks
```

The model fills in the `generate_pdf` arguments (`{ title, sections: [{ heading?, body?, bullets? }] }`), then `pdf-lib` renders them onto a single US Letter page (50pt margins, Helvetica body / Helvetica-Bold headings), wrapping text to fit and truncating gracefully if the content would overflow — it never spills onto a second page. Characters the standard PDF fonts can't draw (e.g. non-breaking hyphens, arrows) are mapped to ASCII equivalents or dropped. The PDF is uploaded into the thread via `files.uploadV2`.

## Email drafting and sending

Ask naturally, e.g.:

```
@Agent email jane@example.com a friendly note recapping our roadmap call and asking her to send over the slides
@Agent search for this week's Starship news and email me a summary
```

What happens:

1. The model writes the recipient, subject, and body and calls `draft_email`.
2. The bot posts a preview in the thread — recipient, subject, and body — and asks you to confirm.
3. Reply **"send it"** (case-insensitive) in that same thread to send it via the Gmail API, or **"cancel"** to discard it. This check happens in code before the model sees the message; the model has no tool that sends email. Unconfirmed drafts expire after 10 minutes and are silently discarded (nothing is ever sent automatically).

While a draft is pending you can also ask for changes ("make it shorter") and the model will redraft it.

Safety rules:

- Only the Slack user set as `ALLOWED_EMAIL_USER_ID` is offered the `draft_email` tool (and the tool re-checks this when it runs). Everyone else is told they aren't authorized.
- The recipient must be an address **you typed yourself** in the thread, or the connected Gmail account's own address (for "email me"). Addresses the model picked up elsewhere — e.g. from a web search result — are refused, and the model asks you to type the address.
- "Email me" uses the connected Gmail account's address, looked up at startup via the `userinfo.email` scope. Tokens created before that scope was added can't do this lookup; the bot logs a warning and asks for your address instead until you re-run `node authorize-gmail.js`.

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

If `credentials.json`/`token.json` aren't present, the email tool isn't offered, and the bot tells anyone who asks to email that an admin needs to run `npm run authorize-gmail`.

### Gmail setup on Railway (or other deploys without a persistent filesystem)

`credentials.json`/`token.json` are gitignored, so a git-based deploy won't have them. Instead, set two env vars with the file contents as JSON strings:

- `GOOGLE_CREDENTIALS_JSON` — contents of your local `credentials.json`
- `GOOGLE_TOKEN_JSON` — contents of your local `token.json` (generated by `authorize-gmail.js` above)

When both are set, the bot reads Gmail auth from them instead of the local files. Note the access token googleapis refreshes internally won't be persisted anywhere in this mode (Railway's filesystem doesn't survive redeploys) — that's fine as long as the refresh token in `GOOGLE_TOKEN_JSON` stays valid, which is what actually gets reused on each restart.

## Notes

- Memory is in-process only (a plain `Map`) — it resets when the process restarts. There is no database or vector store.
- If the Groq API errors, times out (15s; 30s for web search), or is rate-limited, the bot retries once with exponential backoff before falling back to an apologetic message edited into the original "thinking..." post. The same retry/timeout pattern applies to the file upload and the Gmail send call. A failing tool doesn't end the turn — the model is told it failed and explains that to the user.
- Pending email drafts live in-process only (a plain `Map`, one per thread) — they're lost on restart, same as chat history.
