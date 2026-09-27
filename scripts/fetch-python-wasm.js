// Downloads the CPython WASI build used by the code_execution tool into
// sandbox/python.wasm (gitignored; ~26 MB) and verifies its checksum.
// Runs as a postinstall step. A failure here only disables code_execution,
// so it warns instead of failing the install.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const URL =
  'https://github.com/vmware-labs/webassembly-language-runtimes/releases/download/' +
  'python%2F3.12.0%2B20231211-040d5a6/python-3.12.0.wasm';
const SHA256 = 'e5dc5a398b07b54ea8fdb503bf68fb583d533f10ec3f930963e02b9505f7a763';
const DEST = path.join(__dirname, '..', 'sandbox', 'python.wasm');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function main() {
  if (fs.existsSync(DEST) && sha256(fs.readFileSync(DEST)) === SHA256) {
    console.log('python.wasm already present and verified.');
    return;
  }

  const response = await fetch(URL);
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = sha256(buffer);
  if (actual !== SHA256) throw new Error(`checksum mismatch (got ${actual})`);

  fs.writeFileSync(DEST, buffer);
  console.log(`Downloaded and verified python.wasm (${(buffer.length / 1e6).toFixed(1)} MB).`);
}

main().catch((error) => {
  console.warn(`Could not fetch python.wasm; the code_execution tool will be disabled: ${error.message}`);
});
