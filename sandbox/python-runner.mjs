// Runs one Python snippet (read from stdin) in CPython compiled to WASI.
//
// Spawned by index.js as a separate Node process with an empty environment
// and Node's permission model limiting file reads to this directory. Inside
// that, WASI is the actual sandbox: no directories are preopened, so the
// interpreter sees no host files; WASI preview1 has no way to open sockets,
// so there's no network; and env is empty. Unlike Pyodide, there's no JS
// bridge for the Python code to escape through.
import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';

const wasmPath = new URL('./python.wasm', import.meta.url);
const code = readFileSync(0, 'utf8');

const wasi = new WASI({
  version: 'preview1',
  args: ['python', '-I', '-c', code],
  env: {},
  preopens: {},
  returnOnExit: true,
});

const module = await WebAssembly.compile(readFileSync(wasmPath));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
process.exitCode = wasi.start(instance);
