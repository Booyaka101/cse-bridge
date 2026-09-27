/**
 * `cse-bridge scan`: find the places a codebase talks to Google's Custom
 * Search JSON API, and for each one say whether it already points somewhere
 * else and, if not, the one change that points it at the bridge.
 *
 * Line-based: every recipe in docs/migrating-from-google-cse.md is an override
 * within a few lines of where the client is built, so a regex for the
 * construction and one for the override are enough.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { parseCommand } from './cli.ts';
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
   * when no code in the scan has a `match` line for the rule, since most files
   * that import a client just use its types.
   */
  imports?: RegExp;
  /**
   * Seen within WINDOW lines of a call site, the client has already been pointed elsewhere.
   * Not in a trailing comment, and not on a line naming a googleapis.com host.
   */
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
export const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'target', 'coverage', '.next', '.nuxt', '.venv', 'venv', 'site-packages', '__pycache__', '.tox', '.nox']);
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SNIFF_BYTES = 8 * 1024;
const SNIPPET_MAX = 200;

export const WIDGET_MESSAGE = 'cse-bridge serves the JSON API only; this widget is not served by it';

export const RULES: readonly Rule[] = [
  {
    id: 'raw-url',
    lang: 'http',
    // Not the OpenSearch template every response carries in url.template, the
    // bridge's included, which would flag every recorded response.
    match: /googleapis\.com\/customsearch\/v1(?!\?q=\{searchTerms\}|element)|customsearch\.googleapis\.com/,
    override: null,
    fix: (b) => `swap the host: ${b}/customsearch/v1`,
  },
  {
    id: 'node-client',
    lang: 'node',
    // `customsearch)(` is the call TypeScript's CommonJS output makes. The class is what
    // the factory returns, and some code builds it directly.
    match: /(?<!\bfunction\s+)\bcustomsearch\)?\(|\bcustomsearch_v1\.Customsearch\s*\(/,
    imports: /@googleapis\/customsearch/,
    // The services ignore a rootUrl given to google.options().
    override: /^(?!.*\bgoogle\.options\s*\().*\brootUrl\b/,
    fix: (b) => `rootUrl: '${b}/'`,
  },
  {
    id: 'python-client',
    lang: 'python',
    // The second branch is the first argument of a build( call split across lines.
    match: /\bbuild\(\s*(?:serviceName\s*=\s*)?["']customsearch["']|^\s*(?:serviceName\s*=\s*)?["']customsearch["']\s*(?:,|$)/,
    // Not the client_options of another Google client, such as Vertex AI Search's.
    override: /\bapi_endpoint\b|(?<!Client\s*\(.*)\bclient_options\s*=/,
    fix: (b) => `client_options=ClientOptions(api_endpoint="${b}")`,
  },
  {
    id: 'langchain',
    lang: 'python',
    // Not a class statement: some projects vendor their own copy of the wrapper.
    match: /(?<!\bclass\s+)\bGoogleSearchAPIWrapper\s*\(|\bload_tools\s*\(.*["']google-search(?:-results-json)?["']/,
    imports: /(?<!\bclass\s+)\bGoogleSearchAPIWrapper\b/,
    // The wrapper's validator always builds its own search_engine, so only an
    // assignment after construction repoints it.
    override: /\.search_engine\s*=(?!=)/,
    fix: (b) =>
      `search.search_engine = build("customsearch", "v1", developerKey=KEY, client_options=ClientOptions(api_endpoint="${b}"))` +
      '  # after construction; extra="forbid" rejects client_options',
  },
  {
    id: 'langchain-js',
    lang: 'node',
    // The tool fetches a hardcoded Google URL, so a subclass is the only way to repoint it.
    match: /\bnew\s+GoogleCustomSearch\s*\(/,
    override: null,
    fix: (b) => `subclass GoogleCustomSearch and fetch ${b}/customsearch/v1 in _call`,
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
    match: /\b(?:Customsearch|CustomSearchAPI)\.Builder\s*\(|\bnew\s+(?:[\w.]*\.)?(?:Customsearch|CustomSearchAPI)\s*\(/,
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
    // The service's second argument. The client's base_path setting does not reach it, and
    // the legacy Google_Service_Customsearch class has no such argument.
    override: /\bnew\s+[\w\\]*CustomSearchAPI\s*\([^,()]+,\s*\S|\brootUrl\s*:/,
    fix: (b) => `new Google\\Service\\CustomSearchAPI($client, '${b}/')`,
  },
  {
    id: 'dotnet',
    lang: 'dotnet',
    // Semantic Kernel's GoogleConnector and GoogleTextSearch take the same Initializer.
    match: /\bnew\s+(?:[\w.]*\.)?(?:CustomSearchAPIService|CustomsearchService|GoogleConnector|GoogleTextSearch)\s*\(/,
    imports: /\bGoogle\.Apis\.(?:CustomSearchAPI|Customsearch)\.v1\b/,
    override: /\bBaseUri\s*=/,
    fix: (b) => `new BaseClientService.Initializer { ApiKey = key, BaseUri = "${b}/" }`,
  },
  {
    id: 'widget',
    lang: 'html',
    // v1element is the JSON endpoint behind the widget, which the bridge doesn't serve either.
    match: /cse\.google\.com\/cse\.js|www\.google\.com\/cse\/cse\.js|<gcse:|googleapis\.com\/customsearch\/v1element|cse\.google\.com\/cse\/element\/v1/,
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
  dotnet: ['cs', 'csx', 'csharp', 'c#'],
})) {
  for (const name of names) LANG_OF.set(name, lang);
}
const SCOPED = new Set(LANG_OF.values());
const MARKDOWN = new Set(['.md', '.mdx', '.markdown']);

/**
 * The code on a line: nothing for a whole-line comment, which is neither a call site nor an
 * override, and the rest after a leading closed block comment such as a JSDoc type.
 */
function codeOf(line: string, lang: string | undefined): string {
  const code = line.replace(/^\s*(?:\/\*.*?\*\/\s*)+/, '');
  const hash = lang !== undefined && lang in HASH_COMMENT ? HASH_COMMENT[lang] : /^\s*#(?=\s|#|$)/;
  return /^\s*(?:\/\/|\/\*|\*(?=\s|$)|<!--)/.test(code) || hash?.test(code) ? '' : code;
}

/**
 * A line-leading `#` that starts a comment. It is a private field in JavaScript, a `#[`
 * attribute in PHP and `#{` interpolation in a Ruby heredoc. In a file of no known language
 * it takes a space after it, so C's `#define` is code.
 */
const HASH_COMMENT: Record<string, RegExp | null> = { node: null, php: /^\s*#(?![!\[])/, ruby: /^\s*#(?![!{])/, python: /^\s*#(?!!)/ };

const TRAILING_COMMENT: Record<string, RegExp> = { python: /\s#.*$/, ruby: /\s#.*$/, php: /\s(?:\/\/|#).*$/, '*': /\s(?:\/\/|#).*$/ };

/** The line without a trailing comment, where a TODO can name an override that isn't there yet. */
function beforeComment(line: string, lang: string | undefined): string {
  return line.replace(TRAILING_COMMENT[lang ?? ''] ?? /\s\/\/.*$/, '');
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
  fenced: boolean;
}

/** A notebook keeps each line of a cell as a JSON string on a line of its own. */
function notebookLine(line: string): string {
  const m = /^(\s*)("(?:[^"\\]|\\.)*"),?\s*$/.exec(line);
  if (m === null) return line;
  try {
    return m[1] + (JSON.parse(m[2]!) as string).replace(/\r?\n$/, '');
  } catch {
    return line;
  }
}

function unitsOf(file: string, text: string): Unit[] {
  const ext = extname(file).toLowerCase();
  let lines = text.split(/\r?\n/);
  if (ext === '.ipynb') lines = lines.map(notebookLine);
  if (!MARKDOWN.has(ext)) return [{ lang: LANG_OF.get(ext.slice(1)), lines, first: 1, fenced: false }];

  // Prose in a README names these libraries all the time; only code blocks are call sites.
  const units: Unit[] = [];
  let open: { fence: string; unit: Unit } | undefined;
  lines.forEach((line, i) => {
    // A backtick fence's info string cannot hold a backtick, so "```x``` is" is prose.
    const m = /^\s*(`{3,}(?!.*`)|~{3,})\s*([^\s`{]*)/.exec(line);
    if (open === undefined) {
      if (m === null) return;
      const tag = m[2]!.toLowerCase();
      open = { fence: m[1]!, unit: { lang: tag === '' ? '*' : LANG_OF.get(tag), lines: [], first: i + 2, fenced: true } };
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
 * The sites that an override has repointed. Each override line belongs to one site
 * within WINDOW lines: its own line, else the one below that uses the variable it assigns,
 * else the nearest above it, as in a multi-line call or an assignment after construction, else the
 * nearest below. So a "before" line does not borrow the override of the "after" line
 * next to it, nor the next call its predecessor's.
 */
function repointed(rule: Rule, lang: string | undefined, lines: string[], sites: number[]): Set<number> {
  const owners = new Set<number>();
  if (rule.override === null) return owners;
  lines.forEach((line, j) => {
    const code = beforeComment(line, lang);
    if (!rule.override!.test(code) || /googleapis\.com/.test(code)) return;
    const below = sites.filter((s) => s > j && s - j <= WINDOW);
    const assigned = /^\s*(?:(?:const|let|var|val|final)\s+)?(\$?\w+)\s*:?=(?!=)/.exec(code)?.[1];
    const user = assigned === undefined ? undefined : below.find((s) => new RegExp(`(?<![\\w$])${assigned.replace('$', '\\$')}\\b`).test(lines[s]!));
    const owner = sites.includes(j) ? j : (user ?? sites.findLast((s) => s < j && j - s <= WINDOW) ?? below[0]);
    if (owner !== undefined) owners.add(owner);
  });
  return owners;
}

function snippetOf(line: string): string {
  const text = line.trim();
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}...` : text;
}

type Hit = Finding & { order: number; viaImport: boolean; fenced: boolean };

function hitsIn(file: string, text: string, bridgeUrl: string): Hit[] {
  // Not a longer host or another port that merely starts with the bridge URL.
  const bridged = new RegExp(`${bridgeUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.:-])`);
  const hits: Hit[] = [];
  for (const unit of unitsOf(file, text)) {
    const lines = unit.lines.map((line) => codeOf(line, unit.lang));
    RULES.forEach((rule, order) => {
      if (!applies(rule, unit.lang)) return;
      const calls: number[] = [];
      const imports: number[] = [];
      lines.forEach((line, i) => {
        if (rule.match.test(line)) calls.push(i);
        else if (rule.imports?.test(line)) imports.push(i);
      });
      const viaImport = calls.length === 0;
      const sites = viaImport ? imports : calls;
      const owners = repointed(rule, unit.lang, lines, sites);
      for (const i of sites) {
        const line = lines[i]!;
        if (rule.id === 'raw-url' && bridged.test(line)) continue;
        const status: Status = rule.outOfScope ? 'out-of-scope' : owners.has(i) ? 'repointed' : 'needs-change';
        hits.push({ rule: rule.id, lang: rule.lang, file, line: unit.first + i, status, snippet: snippetOf(line), fix: rule.fix(bridgeUrl), order, viaImport, fenced: unit.fenced });
      }
    });
  }
  return hits.sort((a, b) => a.line - b.line || a.order - b.order);
}

/**
 * Drops the import lines of any rule that some code among `hits` builds. A Markdown
 * example building one only answers for other Markdown examples, since it builds
 * nothing in the project.
 */
function settle(hits: Hit[]): Finding[] {
  const builtBy = (fenced: boolean) => new Set(hits.filter((h) => !h.viaImport && (fenced || !h.fenced)).map((h) => h.rule));
  const inCode = builtBy(false);
  const inDocs = builtBy(true);
  return hits
    .filter((h) => !(h.viaImport && (h.fenced ? inDocs : inCode).has(h.rule)))
    .map(({ order: _o, viaImport: _v, fenced: _f, ...finding }) => finding);
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

/**
 * The files git shows under `dir`, tracked or untracked but not ignored, relative to it.
 * Undefined outside a work tree, without git, or when `dir` is itself ignored, since a
 * directory named on the command line is scanned whatever .gitignore says.
 */
function gitFiles(dir: string): string[] | undefined {
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (git('check-ignore', '-q', '.').status !== 1) return undefined;
  const listed = git('ls-files', '-z', '--cached', '--others', '--exclude-standard');
  return listed.status === 0 ? listed.stdout.split('\0').filter(Boolean).sort() : undefined;
}

function walk(path: string, seen: Set<string>, out: Walk, named = false): void {
  let real: string;
  let stats;
  try {
    real = realpathSync(path);
    stats = statSync(real);
  } catch (err) {
    // A dangling symlink, or a file deleted but still in git's index, is not worth a warning.
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
  // A virtualenv, whatever it is called.
  if (!named && names.includes('pyvenv.cfg')) return;
  // Only a named path or a repository root is worth a git call; below that git has already answered.
  const listed = named || names.includes('.git') ? gitFiles(path) : undefined;
  const children = listed ?? names.sort();
  for (const child of children) {
    if (child.split('/').some((part) => SKIP_DIRS.has(part))) continue;
    walk(resolve(path, child), seen, out);
  }
}

const slashed = (path: string) => path.split(sep).join('/');

/** Undefined for a binary file, which the scan skips. */
function readText(file: string): string | undefined {
  const bytes = readFileSync(file);
  // Windows PowerShell 5.1 writes UTF-16 with a byte order mark by default.
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
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
  for (const { path } of absolute) walk(path, seen, out, true);

  let root = cwd;
  if (absolute.length === 1) root = absolute[0]!.isFile ? dirname(absolute[0]!.path) : absolute[0]!.path;

  const hits: Hit[] = [];
  let filesScanned = 0;
  for (const file of out.files) {
    let text: string | undefined;
    try {
      if (statSync(file).size > MAX_FILE_BYTES) {
        // Big images and data files are routine; big source is worth knowing about.
        if (LANG_OF.has(extname(file).slice(1).toLowerCase())) out.warnings.push(`${file}: skipped, over ${MAX_FILE_BYTES / 1024 / 1024} MB`);
        continue;
      }
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

  Lists the places the code under each path (default: the current directory)
  calls Google's Custom Search JSON API, whether each already points elsewhere,
  and the change that points it at the bridge (default ${DEFAULT_BRIDGE_URL}).
  Exits 1 if any call site still needs a change, 2 for a bad option or a
  missing path, and 0 otherwise.
`;

export type ScanIo = Pick<ImportIo, 'stdout' | 'stderr' | 'cwd'>;

/** `cse-bridge scan ...`. Returns the process exit code. */
export function runScan(argv: string[], io: ScanIo): number {
  const args = parseCommand(argv, { json: { type: 'boolean' }, 'bridge-url': { type: 'string' } });
  if ('problem' in args) {
    io.stderr(`cse-bridge scan: ${args.problem}\n${SCAN_USAGE}`);
    return 2;
  }
  const { json, 'bridge-url': rawUrl } = args.values;
  const paths = args.positionals;
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
