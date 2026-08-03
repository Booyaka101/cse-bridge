#!/usr/bin/env node
/**
 * cse-bridge CLI.
 *
 * Reads configuration from the environment (see --help), starts the HTTP
 * bridge, and shuts down cleanly on SIGINT/SIGTERM.
 */

import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const HELP = `cse-bridge ${pkg.version}

  A self-hosted stand-in for Google's Custom Search JSON API (retired
  2027-01-01), served from your own SearXNG instance.

USAGE
  cse-bridge                      start the bridge
  cse-bridge --help               show this message
  cse-bridge --version            print the version

ENDPOINTS
  GET /customsearch/v1            Google customsearch#search wire format
  GET /healthz                    liveness + backend reachability

ENVIRONMENT
  SEARXNG_URL             Base URL of your SearXNG instance
                          (default http://localhost:8888). Its settings.yml
                          must list 'json' under search.formats.
  PORT                    Listen port (default 8080)
  HOST                    Bind address (default 0.0.0.0)
  CSE_BRIDGE_KEYS         Comma-separated list of accepted 'key' values.
                          Unset or empty disables key checking entirely.
  PROFILES_FILE           Path to profiles.yml mapping cx -> backend profile
                          (default ./profiles.yml; missing file is fine)
  CSE_BRIDGE_TIMEOUT_MS   Per-request backend timeout (default 20000)

EXAMPLE
  SEARXNG_URL=http://localhost:8888 cse-bridge
  curl 'http://localhost:8080/customsearch/v1?key=k&cx=default&q=rust+async&num=3'
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  const unknown = argv.filter((a) => a.startsWith('-'));
  if (unknown.length > 0) {
    process.stderr.write(`cse-bridge: unknown option ${unknown[0]}\nRun 'cse-bridge --help'.\n`);
    process.exitCode = 2;
    return;
  }

  let mod;
  try {
    mod = await import('../dist/server.js');
  } catch (err) {
    process.stderr.write(
      `cse-bridge: build output is missing (dist/server.js).\n` +
        `If you are running from a git checkout, run 'npm install && npm run build' first.\n` +
        `Underlying error: ${err && err.message ? err.message : err}\n`,
    );
    process.exitCode = 1;
    return;
  }

  let bridge;
  try {
    bridge = mod.bridgeFromEnv(process.env);
  } catch (err) {
    process.stderr.write(`cse-bridge: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
    return;
  }

  let address;
  try {
    address = await bridge.listen();
  } catch (err) {
    const code = err && err.code;
    if (code === 'EADDRINUSE') {
      process.stderr.write(
        `cse-bridge: port ${bridge.config.port} is already in use. Set PORT to a free port.\n`,
      );
    } else if (code === 'EACCES') {
      process.stderr.write(
        `cse-bridge: not permitted to bind ${bridge.config.host}:${bridge.config.port}.\n`,
      );
    } else {
      process.stderr.write(`cse-bridge: could not start: ${err && err.message ? err.message : err}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const shown = address.host === '0.0.0.0' || address.host === '::' ? 'localhost' : address.host;
  process.stdout.write(
    `cse-bridge ${pkg.version}\n` +
      `  listening   http://${shown}:${address.port}\n` +
      `  endpoint    http://${shown}:${address.port}/customsearch/v1\n` +
      `  backend     ${bridge.config.searxngUrl}\n` +
      `  profiles    ${bridge.profiles.names().join(', ')}` +
      `${bridge.profiles.source ? ` (from ${bridge.profiles.source})` : ' (built-in default)'}\n` +
      `  auth        ${bridge.config.keys.size > 0 ? `${bridge.config.keys.size} key(s) required` : 'disabled (any key accepted)'}\n`,
  );

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`\ncse-bridge: ${signal} received, shutting down.\n`);
    bridge.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
    // Do not let a hung connection block shutdown forever.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`cse-bridge: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
