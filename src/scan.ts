/**
 * `cse-bridge scan`: find the places a codebase talks to Google's Custom
 * Search JSON API, and for each one say whether it already points somewhere
 * else and, if not, the one change that points it at the bridge.
 *
 * Line-based on purpose. Every recipe in docs/migrating-from-google-cse.md is
 * an override within a few lines of where the client is built, so a regex for
 * the construction and one for the override are enough.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { ConfigError, parseUrl } from './config.ts';
import type { ImportIo } from './import.ts';
import { VERSION } from './server.ts';

export type Status = 'needs-change' | 'repointed' | 'out-of-scope';

export interface Rule {
  id: string;
  /** A client rule only runs on that language's files; `http` and `html` rules run on every file. */
  lang: string;
  /** A line that builds or calls the client. */
  match: RegExp;
  /**
   * A line that only names the library, such as an import. These count only
   * when the whole scan finds no `match` line for the rule, since most files
   * that import a client just use its types.
   */
  imports?: RegExp;
  /** Seen within WINDOW lines of a call site, the client has already been pointed elsewhere. */
  override: RegExp | null;
  outOfScope?: true;
  fix: (bridgeUrl: string) => string;
}

export interface Finding {
  rule: string;
  lang: string;
  file: string;
  line: number;
  status: Status;
  snippet: string;
  fix: string;
}

export interface ScanSummary {
  callSites: number;
  needsChange: number;
  repointed: number;
  outOfScope: number;
  filesScanned: number;
}

export interface ScanResult {
  version: string;
  root: string;
  findings: Finding[];
  summary: ScanSummary;
}

export const DEFAULT_BRIDGE_URL = 'http://localhost:8080';
export const WINDOW = 5;
export const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.venv', 'venv', '__pycache__', 'target']);
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SNIFF_BYTES = 8 * 1024;
const SNIPPET_MAX = 200;

export const WIDGET_MESSAGE = 'cse-bridge serves the JSON API only; this widget is not served by it';

export const RULES: readonly Rule[] = [
  {
    id: 'raw-url',
    lang: 'http',
    // Not the OpenSearch template every response carries in url.template, the
    // bridge's included, which would flag every recorded response forever.
    match: /googleapis\.com\/customsearch\/v1(?!\?q=\{searchTerms\})|customsearch\.googleapis\.com/,
    override: null,
    fix: (b) => `swap the host: ${b}/customsearch/v1`,
  },
  {
    id: 'siterestrict',
    lang: 'http',
    // cse.siterestrict.list in each generated client's naming, the raw path, and LangChain's flag.
    match: /customsearch\/v1\/siterestrict|\.siterestrict\s*(?:\(\s*\)|\.list\b)|\.Siterestrict\.List\b|_siterestricts?\b|\bsiterestrict\s*=\s*True\b/,
    override: null,
    fix: () => 'the bridge has no siterestrict endpoint: call cse.list, and restrict sites in the cx profile',
  },
  {
    id: 'node-client',
    lang: 'node',
    // `customsearch)(` is the call TypeScript's CommonJS output makes.
    match: /\bcustomsearch\)?\(/,
    imports: /@googleapis\/customsearch/,
    override: /\brootUrl\b/,
    fix: (b) => `rootUrl: '${b}/'`,
  },
  {
    id: 'python-client',
    lang: 'python',
    // The second branch is the first argument of a build( call split across
    // lines. The optional backslashes are a notebook's JSON-escaped quotes.
    match: /\bbuild\(\s*(?:serviceName\s*=\s*)?\\?["']customsearch\\?["']|^\s*(?:serviceName\s*=\s*)?["']customsearch["']\s*(?:,|$)/,
    override: /\bapi_endpoint\b|\bclient_options\s*=/,
    fix: (b) => `client_options=ClientOptions(api_endpoint="${b}")`,
  },
  {
    id: 'langchain',
    lang: 'python',
    // Not a class statement: some projects vendor their own copy of the wrapper.
    match: /(?<!\bclass\s+)\bGoogleSearchAPIWrapper\s*\(/,
    imports: /(?<!\bclass\s+)\bGoogleSearchAPIWrapper\b/,
    // The wrapper's validator always builds its own search_engine, so only an
    // assignment after construction repoints it.
    override: /\.search_engine\s*=(?!=)/,
    fix: (b) =>
      `search.search_engine = build("customsearch", "v1", developerKey=KEY, client_options=ClientOptions(api_endpoint="${b}"))` +
      '  # after construction; extra="forbid" rejects client_options',
  },
  {
    id: 'go',
    lang: 'go',
    match: /\bcustomsearch\.New(?:Service)?\s*\(/,
    imports: /google\.golang\.org\/api\/customsearch/,
    override: /\bWithEndpoint\s*\(|\.BasePath\s*=/,
    fix: (b) => `option.WithEndpoint("${b}/")`,
  },
  {
    id: 'java',
    lang: 'java',
    match: /\b(?:Customsearch|CustomSearchAPI)\.Builder\s*\(/,
    imports: /com\.google\.api\.services\.customsearch/,
    override: /\bsetRootUrl\s*\(/,
    fix: (b) => `.setRootUrl("${b}/")`,
  },
  {
    id: 'ruby',
    lang: 'ruby',
    match: /\bCustomsearchV1::\w+\.new\b/,
    imports: /\bCustomsearchV1\b|google\/apis\/customsearch_v1/,
    override: /\.root_url\s*=/,
    fix: (b) => `service.root_url = '${b}/'`,
  },
  {
    id: 'php',
    lang: 'php',
    match: /\bnew\s+[\w\\]*(?:CustomSearchAPI|Google_Service_Customsearch)\s*\(/,
    imports: /\bCustomSearchAPI\b|\bGoogle_Service_Customsearch\b/,
    override: /\bbase_path\b/,
    fix: (b) => `$client->setConfig('base_path', '${b}');`,
  },
  {
    id: 'widget',
    lang: 'html',
    match: /cse\.google\.com\/cse\.js|www\.google\.com\/cse\/cse\.js|<gcse:/,
    override: null,
    outOfScope: true,
    fix: () => WIDGET_MESSAGE,
  },
];

/** File extensions, and Markdown fence tags, for the languages the client rules cover. */
const LANG_OF = new Map<string, string>();
for (const [lang, names] of Object.entries({
  node: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'astro', 'javascript', 'typescript', 'node'],
  python: ['py', 'pyi', 'pyw', 'ipynb', 'python', 'python3', 'py3', 'ipython', 'pycon'],
  go: ['go', 'golang'],
  java: ['java', 'kt', 'kts', 'groovy', 'scala', 'kotlin'],
  ruby: ['rb', 'rake', 'gemspec', 'ruby'],
  php: ['php', 'phtml'],
})) {
  for (const name of names) LANG_OF.set(name, lang);
}
const SCOPED = new Set(LANG_OF.values());
const MARKDOWN = new Set(['.md', '.mdx', '.markdown']);
/** A whole-line comment, which is neither a call site nor an override. In JavaScript `#` starts a private field. */
function isComment(line: string, lang: string | undefined): boolean {
  return /^\s*(?:\/\/|\/\*|\*(?!\/)|<!--)/.test(line) || (lang !== 'node' && /^\s*#(?!!)/.test(line));
}

/**
 * A stretch of lines scanned as one: a whole source file, or one fenced code
 * block of a Markdown file. `lang` is undefined where only the unscoped rules
 * apply and `*` for an untagged fence, where every rule does.
 */
interface Unit {
  lang: string | undefined;
  lines: string[];
  /** File line number of lines[0]. */
  first: number;
}

function unitsOf(file: string, text: string): Unit[] {
  const lines = text.split(/\r?\n/);
  const ext = extname(file).toLowerCase();
  if (!MARKDOWN.has(ext)) return [{ lang: LANG_OF.get(ext.slice(1)), lines, first: 1 }];

  // Prose in a README names these libraries all the time; only code blocks are call sites.
  const units: Unit[] = [];
  let open: { fence: string; unit: Unit } | undefined;
  lines.forEach((line, i) => {
    const m = /^\s*(`{3,}|~{3,})\s*([^\s`{]*)/.exec(line);
    if (open === undefined) {
      if (m === null) return;
      const tag = m[2]!.toLowerCase();
      open = { fence: m[1]!, unit: { lang: tag === '' ? '*' : LANG_OF.get(tag), lines: [], first: i + 2 } };
      units.push(open.unit);
    } else if (m !== null && m[1]![0] === open.fence[0] && m[1]!.length >= open.fence.length && m[2] === '') {
      open = undefined;
    } else {
      open.unit.lines.push(line);
    }
  });
  return units;
}

function applies(rule: Rule, lang: string | undefined): boolean {
  return !SCOPED.has(rule.lang) || lang === '*' || lang === rule.lang;
}

/**
 * Looks outward from a call site for the override, up to WINDOW lines each way
 * and never past another call site of the same rule, so a "before" line does
 * not borrow the override from the "after" line next to it.
 */
function isRepointed(rule: Rule, lines: string[], at: number, sites: Set<number>): boolean {
  if (rule.override === null) return false;
  if (rule.override.test(lines[at]!)) return true;
  for (const step of [-1, 1]) {
    for (let j = at + step; Math.abs(j - at) <= WINDOW && j >= 0 && j < lines.length && !sites.has(j); j += step) {
      if (rule.override.test(lines[j]!)) return true;
    }
  }
  return false;
}

function snippetOf(line: string): string {
  const text = line.trim();
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}...` : text;
}

type Hit = Finding & { order: number; viaImport: boolean };

function hitsIn(file: string, text: string, bridgeUrl: string): Hit[] {
  const hits: Hit[] = [];
  for (const unit of unitsOf(file, text)) {
    const lines = unit.lines.map((line) => (isComment(line, unit.lang) ? '' : line));
    RULES.forEach((rule, order) => {
      if (!applies(rule, unit.lang)) return;
      const sites = new Map<number, boolean>();
      lines.forEach((line, i) => {
        if (rule.match.test(line)) sites.set(i, false);
        else if (rule.imports?.test(line)) sites.set(i, true);
      });
      const at = new Set(sites.keys());
      for (const [i, viaImport] of sites) {
        const line = lines[i]!;
        if (rule.id === 'raw-url' && line.includes(bridgeUrl)) continue;
        const status: Status = rule.outOfScope
          ? 'out-of-scope'
          : isRepointed(rule, lines, i, at)
            ? 'repointed'
            : 'needs-change';
        hits.push({ rule: rule.id, lang: rule.lang, file, line: unit.first + i, status, snippet: snippetOf(line), fix: rule.fix(bridgeUrl), order, viaImport });
      }
    });
  }
  return hits.sort((a, b) => a.line - b.line || a.order - b.order);
}

/** Drops the import lines of any rule that has a real call site among `hits`. */
function settle(hits: Hit[]): Finding[] {
  const built = new Set(hits.filter((h) => !h.viaImport).map((h) => h.rule));
  return hits.filter((h) => !(h.viaImport && built.has(h.rule))).map(({ order: _o, viaImport: _v, ...finding }) => finding);
}

/** Findings for one file's text. `file` is the path reported, and its extension picks the language. */
export function scanText(file: string, text: string, bridgeUrl: string): Finding[] {
  return settle(hitsIn(file, text, bridgeUrl));
}

export class ScanError extends Error {}

interface Walk {
  files: string[];
  warnings: string[];
}

function walk(path: string, seen: Set<string>, out: Walk): void {
  let real: string;
  let stats;
  try {
    real = realpathSync(path);
    stats = statSync(real);
  } catch (err) {
    // A dangling symlink is not worth a warning.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') out.warnings.push(`${path}: ${(err as Error).message}`);
    return;
  }
  // Following symlinks, but each real directory once, is what stops a link loop.
  if (seen.has(real)) return;
  seen.add(real);
  if (stats.isFile()) {
    out.files.push(path);
    return;
  }
  if (!stats.isDirectory()) return;
  let names: string[];
  try {
    names = readdirSync(path);
  } catch (err) {
    out.warnings.push(`${path}: ${(err as Error).message}`);
    return;
  }
  for (const name of names.sort()) {
    if (SKIP_DIRS.has(name)) continue;
    walk(resolve(path, name), seen, out);
  }
}

const slashed = (path: string) => path.split(sep).join('/');

/** Undefined for a file that is too big or binary, which the scan skips. */
function readText(file: string): string | undefined {
  if (statSync(file).size > MAX_FILE_BYTES) return undefined;
  const bytes = readFileSync(file);
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return undefined;
  return bytes.toString('utf8');
}

/** Walk each path and scan every text file under it. Throws ScanError for a path that is missing. */
export function scan(paths: string[], cwd: string, bridgeUrl: string): ScanResult & { warnings: string[] } {
  const absolute = paths.map((p) => {
    const path = resolve(cwd, p);
    try {
      return { path, isFile: statSync(path).isFile() };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new ScanError(code === 'ENOENT' ? `${p}: no such file or directory` : `${p}: ${(err as Error).message}`);
    }
  });
  const out: Walk = { files: [], warnings: [] };
  const seen = new Set<string>();
  for (const { path } of absolute) walk(path, seen, out);

  let root = cwd;
  if (absolute.length === 1) root = absolute[0]!.isFile ? dirname(absolute[0]!.path) : absolute[0]!.path;

  const hits: Hit[] = [];
  let filesScanned = 0;
  for (const file of out.files) {
    let text: string | undefined;
    try {
      text = readText(file);
    } catch (err) {
      out.warnings.push(`${file}: ${(err as Error).message}`);
      continue;
    }
    if (text === undefined) continue;
    filesScanned++;
    hits.push(...hitsIn(slashed(relative(root, file)), text, bridgeUrl));
  }
  const findings = settle(hits);

  const count = (status: Status) => findings.filter((f) => f.status === status).length;
  return {
    version: VERSION,
    root: slashed(root),
    findings,
    summary: {
      callSites: findings.length,
      needsChange: count('needs-change'),
      repointed: count('repointed'),
      outOfScope: count('out-of-scope'),
      filesScanned,
    },
    warnings: out.warnings,
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function summaryLine(s: ScanSummary): string {
  return (
    `${plural(s.callSites, 'call site', 'call sites')}: ${plural(s.needsChange, 'needs a change', 'need a change')}, ` +
    `${s.repointed} already repointed, ${s.outOfScope} out of scope`
  );
}

/** The human-readable report: one line per finding, the fix indented under anything not yet repointed. */
export function formatText(findings: Finding[], summary: ScanSummary): string {
  const ruleWidth = Math.max(...RULES.map((r) => r.id.length));
  const lines: string[] = [];
  for (const f of findings) {
    lines.push(`${f.status.padEnd(12)}  ${f.rule.padEnd(ruleWidth)}  ${f.file}:${f.line}`);
    if (f.status !== 'repointed') lines.push(`    ${f.fix}`);
  }
  if (lines.length > 0) lines.push('');
  lines.push(summaryLine(summary));
  return `${lines.join('\n')}\n`;
}

export const SCAN_USAGE = `usage: cse-bridge scan [path...] [--json] [--bridge-url URL]

  Lists every place the code under each path (default: the current directory)
  calls Google's Custom Search JSON API, whether it already points elsewhere,
  and the change that points it at the bridge (default ${DEFAULT_BRIDGE_URL}).
  Exits 1 if anything still needs a change, 0 if not.
`;

export type ScanIo = Pick<ImportIo, 'stdout' | 'stderr' | 'cwd'>;

/** `cse-bridge scan ...`. Returns the process exit code. */
export function runScan(argv: string[], io: ScanIo): number {
  const paths: string[] = [];
  let json = false;
  let rawUrl: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--bridge-url') rawUrl = argv[i + 1]?.startsWith('-') ? '' : (argv[++i] ?? '');
    else if (arg.startsWith('--bridge-url=')) rawUrl = arg.slice('--bridge-url='.length);
    else if (arg.startsWith('-')) {
      io.stderr(`cse-bridge scan: unknown option ${arg}\n${SCAN_USAGE}`);
      return 2;
    } else paths.push(arg);
  }
  if (rawUrl === '') {
    io.stderr(`cse-bridge scan: --bridge-url needs a URL\n${SCAN_USAGE}`);
    return 2;
  }
  let bridgeUrl: string;
  try {
    bridgeUrl = parseUrl(rawUrl, '--bridge-url', DEFAULT_BRIDGE_URL);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    io.stderr(`cse-bridge scan: ${err.message}\n`);
    return 2;
  }

  let result: ReturnType<typeof scan>;
  try {
    result = scan(paths.length === 0 ? ['.'] : paths, io.cwd, bridgeUrl);
  } catch (err) {
    if (!(err instanceof ScanError)) throw err;
    io.stderr(`cse-bridge scan: ${err.message}\n`);
    return 2;
  }

  const { warnings, ...report } = result;
  for (const w of warnings) io.stderr(`warning: ${w}\n`);
  io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : formatText(report.findings, report.summary));
  return report.summary.needsChange > 0 ? 1 : 0;
}
