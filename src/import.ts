/**
 * `cse-bridge import`: turn a Programmable Search Engine's annotations file,
 * and optionally its context file, into a profiles.yml block.
 *
 * Both files come from the control panel (Overview, Search features,
 * Download). An annotation is a URL pattern plus labels; the context file's
 * BackgroundLabels say which label means include (mode FILTER) and which means
 * exclude (mode ELIMINATE). A background label in mode BOOST means the engine
 * searches the whole web and only promotes those sites. Every other label is a
 * refinement. The bridge has no equivalent for boosts or refinements.
 *
 * The XML is read with the regex tag scanner in markup.ts, not a parser: the
 * files are machine-written, flat, and the zero-runtime-dependency rule holds.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseCommand } from './cli.ts';
import { attributesOf, TAG_BODY } from './markup.ts';
import { parseSitePattern, parseYaml, profilesFromYaml, ProfilesError } from './profiles.ts';

/** Google's own cap on annotations per engine. */
export const GOOGLE_ANNOTATION_LIMIT = 5000;

export type LabelRole = 'include' | 'exclude' | 'boost';

export interface ImportResult {
  sites: string[];
  exclude: string[];
  /** Annotations found in the file, imported or not. */
  annotations: number;
  /** One line each, for stderr. */
  warnings: string[];
}

export class ImportError extends Error {}

// Lazy bodies, so a self-closing tag's `/` is not read as part of its attributes.
const LABEL_RE = new RegExp(String.raw`<Label\b(${TAG_BODY}?)/?>`, 'g');
const ANNOTATION_RE = new RegExp(String.raw`<Annotation\b(${TAG_BODY}?)(?:/>|>([\s\S]*?)</Annotation\s*>)`, 'g');

/** Comments are blanked rather than removed so match offsets still give the right line. */
function stripComments(xml: string): string {
  return xml.replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
}

function labelNames(body: string): string[] {
  const names: string[] = [];
  for (const m of body.matchAll(LABEL_RE)) {
    const name = attributesOf(m[1]!)['name'];
    if (name !== undefined && name !== '') names.push(name);
  }
  return names;
}

/**
 * Which labels mean include and which mean exclude, from the context file's
 * BackgroundLabels. Labels inside Facets are refinements and are not read.
 */
export function readLabelRoles(contextXml: string): Map<string, LabelRole> {
  const roles = new Map<string, LabelRole>();
  const xml = stripComments(contextXml);
  for (const block of xml.matchAll(/<BackgroundLabels\b[^>]*>([\s\S]*?)<\/BackgroundLabels\s*>/g)) {
    for (const m of block[1]!.matchAll(LABEL_RE)) {
      const attrs = attributesOf(m[1]!);
      const name = attrs['name'];
      const mode = attrs['mode']?.toUpperCase();
      if (name === undefined) continue;
      if (mode === 'FILTER') roles.set(name, 'include');
      else if (mode === 'ELIMINATE') roles.set(name, 'exclude');
      else if (mode === 'BOOST') roles.set(name, 'boost');
    }
  }
  return roles;
}

/**
 * Without a context file: the documented `_include_`/`_exclude_`, anything
 * with `exclude` in it, and `_cse_<id>`, the label Google generates for an
 * engine's own site list.
 */
function guessRole(name: string): LabelRole | undefined {
  const lower = name.toLowerCase();
  if (lower.includes('exclude')) return 'exclude';
  if (lower === '_include_' || lower.startsWith('_cse_')) return 'include';
  return undefined;
}

/** Parse an annotations file into include and exclude pattern lists. */
export function importAnnotations(annotationsXml: string, contextXml?: string): ImportResult {
  const roles = contextXml === undefined ? undefined : readLabelRoles(contextXml);
  if (roles !== undefined && roles.size === 0) {
    const swapped = /<Annotation\b/.test(contextXml!) && /<BackgroundLabels\b/.test(annotationsXml);
    throw new ImportError(
      swapped
        ? 'the two files look swapped: the annotations file goes first, the context file second.'
        : 'the context file has no BackgroundLabels with mode FILTER, ELIMINATE or BOOST.',
    );
  }
  const roleOf = (name: string): LabelRole | undefined => (roles === undefined ? guessRole(name) : roles.get(name));

  const xml = stripComments(annotationsXml);
  const sites = new Set<string>();
  const exclude = new Set<string>();
  const warnings: string[] = [];
  const ignored = new Set<string>();
  let annotations = 0;
  let unlabelled = 0;
  let boosted = 0;
  let guessedCse = false;

  let line = 1;
  let counted = 0;
  for (const m of xml.matchAll(ANNOTATION_RE)) {
    annotations++;
    for (; counted < m.index; counted++) if (xml.charCodeAt(counted) === 10) line++;
    const about = attributesOf(m[1]!)['about'];
    if (about === undefined || about.trim() === '') {
      warnings.push(`line ${line}: annotation has no about="..." attribute, skipped`);
      continue;
    }
    const pattern = parseSitePattern(about);
    if (pattern === undefined) {
      warnings.push(`line ${line}: about="${about}" is not a URL pattern, skipped`);
      continue;
    }
    const labels = labelNames(m[2] ?? '');
    const found = labels.map(roleOf);
    if (!found.includes('include') && !found.includes('exclude')) {
      if (found.includes('boost')) {
        boosted++;
        continue;
      }
      unlabelled++;
      const list = labels.length === 0 ? 'no labels' : `labels ${labels.join(', ')}`;
      warnings.push(`line ${line}: about="${about}" has ${list}, none of them include or exclude, skipped`);
      continue;
    }
    // An annotation carrying both is excluded anyway, since excludes win.
    (found.includes('exclude') ? exclude : sites).add(pattern.text);
    labels.forEach((name, i) => {
      if (found[i] === undefined || found[i] === 'boost') ignored.add(name);
      if (roles === undefined && found[i] === 'include' && name.toLowerCase().startsWith('_cse_')) guessedCse = true;
    });
  }

  if (annotations === 0) {
    const hint = /<BackgroundLabels\b/.test(xml) ? ' It looks like a context file; pass the annotations file first.' : '';
    throw new ImportError(`no <Annotation> elements found.${hint}`);
  }
  if (ignored.size > 0) {
    warnings.push(`labels with no cse-bridge equivalent (refinements, boosts) were ignored: ${[...ignored].join(', ')}`);
  }
  if (annotations > GOOGLE_ANNOTATION_LIMIT) {
    warnings.push(
      `${annotations} annotations is over Google's limit of ${GOOGLE_ANNOTATION_LIMIT}; importing all of them anyway`,
    );
  }
  if (guessedCse) {
    warnings.push(
      'no context file, so the _cse_ label was read as the include list. If the engine searches the entire web (the label is in mode BOOST), pass the context file',
    );
  }
  const wholeWeb = boosted > 0 && sites.size === 0;
  if (wholeWeb && exclude.size === 0) {
    throw new ImportError(
      `this engine searches the entire web and only boosts its ${boosted} site(s) (mode BOOST). ` +
        'The bridge cannot boost, so there is nothing to import; a profile with no sites searches the whole web.',
    );
  }
  if (wholeWeb) {
    warnings.push(`this engine searches the entire web and only boosts ${boosted} site(s) (mode BOOST); the bridge cannot boost, so only the excludes were imported`);
  } else if (boosted > 0) {
    warnings.push(`${boosted} annotation(s) with only a boost label were skipped: the include list already decides what this engine searches`);
  }
  if (sites.size === 0 && exclude.size === 0) {
    throw new ImportError(
      roles === undefined
        ? 'no annotation has a label that means include or exclude. Pass the context file so its BackgroundLabels can say which is which.'
        : 'no annotation carries one of the context file\'s include or exclude labels.',
    );
  }
  if (sites.size === 0 && !wholeWeb) {
    // Emitting excludes alone would turn a restricted engine into the whole web.
    if (unlabelled > 0) {
      throw new ImportError(
        `${unlabelled} annotation(s) could not be classified and none were includes, so this profile would search the whole web. ` +
          (roles === undefined ? 'Pass the context file.' : 'Check the context file belongs to this engine.'),
      );
    }
    if (roles !== undefined && [...roles.values()].includes('include')) {
      throw new ImportError(
        'the context file restricts this engine to an include label, but no annotation carries one, so this profile would search the whole web. ' +
          'Check both files come from the same engine.',
      );
    }
    warnings.push('only excludes were found, so this profile searches the whole web except them');
  }
  return { sites: [...sites], exclude: [...exclude], annotations, warnings };
}

function yamlKey(cx: string): string {
  return /^[A-Za-z0-9_-]+$/.test(cx) ? cx : `"${cx}"`;
}

/** The profiles.yml block for one imported engine. */
export function profileYaml(cx: string, result: Pick<ImportResult, 'sites' | 'exclude'>, source: string): string {
  const lines = [`# Imported by cse-bridge from ${source}.`, `${yamlKey(cx)}:`];
  for (const [key, list] of [['sites', result.sites], ['exclude', result.exclude]] as const) {
    if (list.length === 0) continue;
    lines.push(`  ${key}:`, ...list.map((p) => `    - "${p}"`));
  }
  return `${lines.join('\n')}\n`;
}

export const IMPORT_USAGE = `usage: cse-bridge import <annotations.xml> [context.xml] --cx NAME [--write]

  Prints a profiles.yml block for the engine NAME. With --write, appends it to
  $PROFILES_FILE (default ./profiles.yml) instead.
`;

export interface ImportIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** Exports are UTF-8, but a file re-saved from Notepad as "Unicode" is UTF-16 with a BOM. */
function readInput(path: string, cwd: string): string {
  try {
    const bytes = readFileSync(resolve(cwd, path));
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
    return bytes.toString('utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ImportError(`${path}: no such file.`);
    if (code === 'EISDIR') throw new ImportError(`${path}: is a directory.`);
    throw new ImportError(`${path}: ${(err as Error).message}`);
  }
}

/** `cse-bridge import ...`. Returns the process exit code. */
export function runImport(argv: string[], io: ImportIo): number {
  const args = parseCommand(argv, { cx: { type: 'string' }, write: { type: 'boolean' } });
  if ('problem' in args) {
    io.stderr(`cse-bridge import: ${args.problem}\n${IMPORT_USAGE}`);
    return 2;
  }
  const files = args.positionals;
  let { cx } = args.values;
  const write = args.values.write ?? false;
  let problem: string | undefined;
  if (files.length === 0) problem = 'no annotations file given';
  else if (files.length > 2) problem = `too many files: ${files.join(' ')}`;
  else if (cx === undefined || cx.trim() === '') problem = '--cx NAME is required';
  else if (/["\\\r\n]/.test(cx)) problem = `--cx ${JSON.stringify(cx)} cannot contain quotes, backslashes or newlines`;
  if (problem !== undefined) {
    io.stderr(`cse-bridge import: ${problem}\n${IMPORT_USAGE}`);
    return 2;
  }
  cx = cx!.trim();

  const [annotationsPath, contextPath] = files as [string, string | undefined];
  let block: string;
  let result: ImportResult;
  try {
    const annotations = readInput(annotationsPath, io.cwd);
    const context = contextPath === undefined ? undefined : readInput(contextPath, io.cwd);
    result = importAnnotations(annotations, context);
    const source = files.map((p) => basename(p)).join(' and ');
    block = profileYaml(cx, result, source);
  } catch (err) {
    if (!(err instanceof ImportError)) throw err;
    io.stderr(`cse-bridge import: ${err.message}\n`);
    return 1;
  }

  for (const w of result.warnings) io.stderr(`warning: ${w}\n`);
  const summary = `${result.sites.length} include and ${result.exclude.length} exclude pattern(s) from ${result.annotations} annotation(s)`;

  if (!write) {
    io.stdout(block);
    io.stderr(`${summary}\n`);
    return 0;
  }

  const target = resolve(io.cwd, io.env['PROFILES_FILE'] || 'profiles.yml');
  let existing = '';
  try {
    existing = readFileSync(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      io.stderr(`cse-bridge import: cannot read ${target}: ${(err as Error).message}\n`);
      return 1;
    }
  }
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const next = existing === '' ? block : `${existing.replace(/(\r?\n)*$/, eol)}${eol}${block.replace(/\n/g, eol)}`;
  try {
    if (Object.hasOwn(parseYaml(existing), cx)) {
      io.stderr(`cse-bridge import: ${target} already defines ${cx}. Remove it or pick another --cx.\n`);
      return 1;
    }
    // Refuse to leave behind a file the bridge would then fail to start on.
    const written = profilesFromYaml(next, target).get(cx);
    if (written.sites.length !== result.sites.length || written.exclude.length !== result.exclude.length) {
      throw new ProfilesError(`${cx} would not read back as imported`);
    }
  } catch (err) {
    if (!(err instanceof ProfilesError)) throw err;
    io.stderr(`cse-bridge import: not writing ${target}: ${err.message}\n`);
    return 1;
  }
  try {
    writeFileSync(target, next);
  } catch (err) {
    io.stderr(`cse-bridge import: cannot write ${target}: ${(err as Error).message}\n`);
    return 1;
  }
  io.stderr(`${summary}\nappended ${cx} to ${target}\n`);
  return 0;
}
