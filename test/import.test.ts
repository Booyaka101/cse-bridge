/**
 * `cse-bridge import`: Google's downloaded annotations and context files in,
 * a profiles.yml block out, and that block loading back as the same site list.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  importAnnotations,
  profileYaml,
  readLabelRoles,
  runImport,
  ImportError,
  GOOGLE_ANNOTATION_LIMIT,
} from '../src/import.ts';
import { matchUrl, profilesFromYaml } from '../src/profiles.ts';

const fixtures = join(import.meta.dirname, 'fixtures');
const annotationsXml = readFileSync(join(fixtures, 'annotations.xml'), 'utf8');
const contextXml = readFileSync(join(fixtures, 'context.xml'), 'utf8');

const EXPECTED_YAML = `# Imported by cse-bridge from annotations.xml and context.xml.
webmd:
  sites:
    - "www.webmd.com/hw/*"
    - "*.mayoclinic.org/*"
    - "www.nhs.uk/conditions"
    - "xn--bcher-kva.example/di%C3%A4t/*"
  exclude:
    - "www.webmd.com/hw/cancer/*"
`;

function run(argv: string[], env: NodeJS.ProcessEnv = {}, cwd = fixtures) {
  let stdout = '';
  let stderr = '';
  const code = runImport(argv, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    env,
    cwd,
  });
  return { code, stdout, stderr };
}

function annotation(about: string, label: string): string {
  return `<Annotation about="${about}"><Label name="${label}"/></Annotation>`;
}

describe('importAnnotations', () => {
  test('the fixture pair gives exactly the expected YAML', () => {
    const result = importAnnotations(annotationsXml, contextXml);
    assert.equal(profileYaml('webmd', result, 'annotations.xml and context.xml'), EXPECTED_YAML);
    assert.equal(result.annotations, 6, 'the commented-out annotation is not counted');
  });

  test('the imported block round-trips through the profile loader and enforces the list', () => {
    const profile = profilesFromYaml(EXPECTED_YAML, 'profiles.yml').get('webmd');
    const result = importAnnotations(annotationsXml, contextXml);
    assert.deepEqual(profile.sites, result.sites);
    assert.deepEqual(profile.exclude, result.exclude);

    const allowed = (url: string) => matchUrl(url, profile.sites, profile.exclude);
    assert.equal(allowed('https://www.webmd.com/hw/diet/keto'), true);
    assert.equal(allowed('https://www.webmd.com/hw/cancer/lung'), false);
    assert.equal(allowed('https://www.mayoclinic.org/diseases'), true);
    assert.equal(allowed('https://www.nhs.uk/conditions/'), true);
    assert.equal(allowed('https://bücher.example/diät/rezepte'), true);
    assert.equal(allowed('https://forum.example.org/t/1'), false, 'the boost-only annotation was skipped');
  });

  test('unknown labels are reported with a line number and skipped', () => {
    const { warnings } = importAnnotations(annotationsXml, contextXml);
    assert.deepEqual(warnings, [
      'line 22: about="forum.example.org/*" has labels boost_only, none of them include or exclude, skipped',
      'labels with no cse-bridge equivalent (refinements, boosts) were ignored: nutrition',
    ]);
  });

  test('facet labels are refinements, not includes', () => {
    const roles = readLabelRoles(contextXml);
    assert.deepEqual([...roles], [
      ['_cse_abcdefghijk', 'include'],
      ['_cse_exclude_abcdefghijk', 'exclude'],
    ]);
  });

  test('without a context file, Google\'s generated and documented label names are recognised', () => {
    const result = importAnnotations(annotationsXml);
    assert.deepEqual(result.exclude, ['www.webmd.com/hw/cancer/*']);
    assert.equal(result.sites.length, 4);

    const documented = importAnnotations(
      `<Annotations>${annotation('a.test/*', '_include_')}${annotation('a.test/x/*', '_exclude_')}${annotation(
        'b.test',
        'my_exclude_list',
      )}</Annotations>`,
    );
    assert.deepEqual(documented.sites, ['a.test/*']);
    assert.deepEqual(documented.exclude, ['a.test/x/*', 'b.test']);

    // Only the generated label can really be a boost, so only it is flagged.
    assert.ok(result.warnings.some((w) => w.startsWith('no context file, so the _cse_ label')));
    assert.deepEqual(documented.warnings, []);
  });

  test('a whole-web engine (site label in mode BOOST) imports only its excludes', () => {
    const boostContext = contextXml.replace('name="_cse_abcdefghijk" mode="FILTER"', 'name="_cse_abcdefghijk" mode="BOOST"');
    assert.notEqual(boostContext, contextXml);
    const result = importAnnotations(annotationsXml, boostContext);
    assert.deepEqual(result.sites, []);
    assert.deepEqual(result.exclude, ['www.webmd.com/hw/cancer/*']);
    assert.ok(
      result.warnings.includes(
        'this engine searches the entire web and only boosts 4 site(s) (mode BOOST); the bridge cannot boost, so only the excludes were imported',
      ),
      result.warnings.join('\n'),
    );
  });

  test('a whole-web engine with no excludes has nothing to import', () => {
    const context = '<CustomSearchEngine><BackgroundLabels><Label name="_cse_x" mode="BOOST"/></BackgroundLabels></CustomSearchEngine>';
    assert.throws(
      () => importAnnotations(`<Annotations>${annotation('a.test', '_cse_x')}</Annotations>`, context),
      /searches the entire web and only boosts its 1 site\(s\).*nothing to import/,
    );
  });

  test('in a restricted engine a boost-only annotation is skipped, since the engine never searches it', () => {
    const context =
      '<CustomSearchEngine><BackgroundLabels><Label name="_cse_x" mode="FILTER"/><Label name="promo" mode="BOOST"/></BackgroundLabels></CustomSearchEngine>';
    const result = importAnnotations(
      `<Annotations>${annotation('a.test', '_cse_x')}${annotation('b.test', 'promo')}<Annotation about="c.test"><Label name="_cse_x"/><Label name="promo"/></Annotation></Annotations>`,
      context,
    );
    assert.deepEqual(result.sites, ['a.test', 'c.test']);
    assert.deepEqual(result.warnings, [
      'labels with no cse-bridge equivalent (refinements, boosts) were ignored: promo',
      '1 annotation(s) with only a boost label were skipped: the include list already decides what this engine searches',
    ]);
  });

  test('an annotation labelled both ways is an exclude', () => {
    const result = importAnnotations(
      `<Annotations>${annotation('a.test', '_include_')}<Annotation about="b.test"><Label name="_include_"/><Label name="_exclude_"/></Annotation></Annotations>`,
    );
    assert.deepEqual(result.sites, ['a.test']);
    assert.deepEqual(result.exclude, ['b.test']);
  });

  test('malformed annotations are warned about, the rest still import', () => {
    const result = importAnnotations(
      `<Annotations>\n<Annotation score="1"><Label name="_include_"/></Annotation>\n${annotation(
        'has space.test',
        '_include_',
      )}\n${annotation('ok.test', '_include_')}\n</Annotations>`,
    );
    assert.deepEqual(result.sites, ['ok.test']);
    assert.deepEqual(result.warnings, [
      'line 2: annotation has no about="..." attribute, skipped',
      'line 3: about="has space.test" is not a URL pattern, skipped',
    ]);
  });

  test(`more than ${GOOGLE_ANNOTATION_LIMIT} annotations import with a warning`, () => {
    const many = Array.from({ length: GOOGLE_ANNOTATION_LIMIT + 1 }, (_, i) => annotation(`s${i}.test`, '_include_'));
    const result = importAnnotations(`<Annotations>${many.join('\n')}</Annotations>`);
    assert.equal(result.sites.length, GOOGLE_ANNOTATION_LIMIT + 1);
    assert.deepEqual(result.warnings, [
      `${GOOGLE_ANNOTATION_LIMIT + 1} annotations is over Google's limit of ${GOOGLE_ANNOTATION_LIMIT}; importing all of them anyway`,
    ]);
  });

  test('refuses input that would silently produce the wrong profile', () => {
    assert.throws(() => importAnnotations(contextXml, annotationsXml), /look swapped/);
    assert.throws(() => importAnnotations(contextXml), /looks like a context file/);
    assert.throws(() => importAnnotations('<Annotations/>'), ImportError);
    assert.throws(() => importAnnotations(annotationsXml, '<CustomSearchEngine/>'), /no BackgroundLabels/);
    assert.throws(
      () => importAnnotations(`<Annotations>${annotation('a.test', 'mystery')}</Annotations>`),
      /Pass the context file so its BackgroundLabels/,
    );
    // Excludes alone, with the includes unrecognised, would widen the cx to the whole web.
    assert.throws(
      () => importAnnotations(`<Annotations>${annotation('a.test', 'mystery')}${annotation('b.test', '_exclude_')}</Annotations>`),
      /would search the whole web/,
    );
    // The context says the engine is restricted, yet no annotation carries the include label.
    const restricted =
      '<CustomSearchEngine><BackgroundLabels><Label name="_include_" mode="FILTER"/><Label name="_exclude_" mode="ELIMINATE"/></BackgroundLabels></CustomSearchEngine>';
    assert.throws(
      () => importAnnotations(`<Annotations>${annotation('bad.test/*', '_exclude_')}</Annotations>`, restricted),
      /restricts this engine to an include label, but no annotation carries one/,
    );
  });

  test('excludes alone, with nothing saying the engine is restricted, import with a warning', () => {
    const result = importAnnotations(`<Annotations>${annotation('bad.test/*', '_cse_exclude_x')}</Annotations>`);
    assert.deepEqual(result.sites, []);
    assert.deepEqual(result.exclude, ['bad.test/*']);
    assert.deepEqual(result.warnings, ['only excludes were found, so this profile searches the whole web except them']);
  });
});

describe('cse-bridge import', () => {
  test('prints the YAML block and a summary', () => {
    const { code, stdout, stderr } = run(['annotations.xml', 'context.xml', '--cx', 'webmd']);
    assert.equal(code, 0);
    assert.equal(stdout, EXPECTED_YAML);
    assert.match(stderr, /^warning: line 22: /m);
    assert.match(stderr, /4 include and 1 exclude pattern\(s\) from 6 annotation\(s\)/);
  });

  test('usage errors exit 2, bad input exits 1', () => {
    assert.equal(run(['annotations.xml']).code, 2, 'no --cx');
    assert.equal(run(['--cx', 'x']).code, 2, 'no file');
    assert.equal(run(['a', 'b', 'c', '--cx', 'x']).code, 2, 'too many files');
    assert.equal(run(['annotations.xml', '--cx', 'x', '--frob']).code, 2);
    const swallowed = run(['annotations.xml', '--cx', '--write']);
    assert.equal(swallowed.code, 2, '--write is not taken as the cx name');
    assert.match(swallowed.stderr, /--cx NAME is required/);
    assert.equal(swallowed.stdout, '');
    assert.equal(run(['annotations.xml', '--cx', 'a"b']).code, 2);
    const missing = run(['nope.xml', '--cx=x']);
    assert.equal(missing.code, 1);
    assert.equal(missing.stderr, 'cse-bridge import: nope.xml: no such file.\n');
  });

  test('--write appends to PROFILES_FILE, refuses a duplicate, and the bridge can load the result', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cse-bridge-import-'));
    try {
      const target = join(dir, 'profiles.yml');
      writeFileSync(target, 'default:\n  categories: [general]\n');
      const env = { PROFILES_FILE: target };
      const args = [join(fixtures, 'annotations.xml'), join(fixtures, 'context.xml'), '--write'];

      const first = run([...args, '--cx', 'webmd'], env, dir);
      assert.equal(first.code, 0, first.stderr);
      assert.equal(first.stdout, '');
      assert.match(first.stderr, /appended webmd to /);

      const written = readFileSync(target, 'utf8');
      assert.ok(written.startsWith('default:\n  categories: [general]\n\n# Imported by cse-bridge from '));
      const set = profilesFromYaml(written, target);
      assert.deepEqual(set.names().sort(), ['default', 'webmd']);
      assert.deepEqual(set.get('webmd').exclude, ['www.webmd.com/hw/cancer/*']);

      const again = run([...args, '--cx', 'webmd'], env, dir);
      assert.equal(again.code, 1);
      assert.match(again.stderr, /already defines webmd/);
      assert.equal(readFileSync(target, 'utf8'), written, 'a refused write leaves the file alone');

      // A Google-shaped cx with a colon is quoted so it reads back as one key.
      const colon = run([...args, '--cx', '012345678901234567890:abcdefghij'], env, dir);
      assert.equal(colon.code, 0, colon.stderr);
      assert.equal(profilesFromYaml(readFileSync(target, 'utf8'), target).get('012345678901234567890:abcdefghij').sites.length, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--write creates profiles.yml in the working directory when none exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cse-bridge-import-'));
    try {
      const out = run([join(fixtures, 'annotations.xml'), join(fixtures, 'context.xml'), '--cx', 'webmd', '--write'], {}, dir);
      assert.equal(out.code, 0, out.stderr);
      assert.equal(readFileSync(join(dir, 'profiles.yml'), 'utf8'), EXPECTED_YAML);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reads an export re-saved as UTF-16, and appends to a CRLF file in CRLF', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cse-bridge-import-'));
    try {
      const utf16 = join(dir, 'annotations.xml');
      writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(annotationsXml, 'utf16le')]));
      const target = join(dir, 'profiles.yml');
      writeFileSync(target, 'default:\r\n  categories: [general]\r\n');
      const out = run([utf16, join(fixtures, 'context.xml'), '--cx', 'webmd', '--write'], { PROFILES_FILE: target }, dir);
      assert.equal(out.code, 0, out.stderr);
      const written = readFileSync(target, 'utf8');
      assert.doesNotMatch(written, /(?<!\r)\n/, 'no bare LF');
      assert.deepEqual(profilesFromYaml(written, target).get('webmd').exclude, ['www.webmd.com/hw/cancer/*']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--write refuses to touch a profiles file that does not parse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cse-bridge-import-'));
    try {
      const target = join(dir, 'profiles.yml');
      writeFileSync(target, 'just a line with no colon\n');
      const out = run([join(fixtures, 'annotations.xml'), '--cx', 'webmd', '--write'], { PROFILES_FILE: target }, dir);
      assert.equal(out.code, 1);
      assert.match(out.stderr, /not writing /);
      assert.equal(readFileSync(target, 'utf8'), 'just a line with no colon\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
