// One-time Gmail OAuth setup.
//   Step 1: node authorize-gmail.js            -> prints a URL to open
//   Step 2: node authorize-gmail.js "<code>"    -> exchanges the code you
//           got back (either the bare code, or the full redirected URL if
//           the browser couldn't load localhost) for a refresh token.
// Writes the refresh token to token.json (gitignored, alongside
// credentials.json) so the bot never needs to re-authorize on restart.
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const SCOPES = ['https://www.googleapis.com/auth/gmail.send'];
// Must match the "http://localhost" redirect URI registered on the Desktop
// OAuth client (any port is accepted, but Google controls the exact path it
// redirects to, so no custom path here). Nothing actually listens on this —
// after approving, the browser will fail to load the address, but the
// authorization code still shows up in its address bar as a query param.
const REDIRECT_URI = 'http://localhost:4321';

function extractCode(input) {
  if (input.includes('code=')) {
    const url = new URL(input, 'http://localhost');
    const code = url.searchParams.get('code');
    if (code) return code;
  }
  return input;
}

function buildOAuthClient() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_id, client_secret } = credentials.installed || credentials.web;
  return new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
}

async function main() {
  const oauth2Client = buildOAuthClient();
  const rawInput = process.argv[2];

  if (!rawInput) {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
    });

    console.log('\n1. Open this URL in your browser and grant access to your Gmail account:\n');
    console.log(authUrl);
    console.log(
      '\n2. After you approve, the browser will try to redirect to localhost and fail to load — ' +
        "that's expected. Copy either the full URL from the address bar or just the \"code=\" value from it."
    );
    console.log('\n3. Run: node authorize-gmail.js "<code or full redirected URL>"\n');
    return;
  }

  const code = extractCode(rawInput);
  const { tokens } = await oauth2Client.getToken(code);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

  console.log(`\n✅ Saved refresh token to ${TOKEN_PATH}. The bot can now draft and send email.`);
}

main().catch((error) => {
  console.error('\nGmail authorization failed:', error.message);
  process.exit(1);
});
