/**
 * `cse-bridge scan`: each rule finds its client and tells a repointed one from
 * one that still talks to Google, over real files on disk and through the CLI.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

import { MAX_FILE_BYTES, RULES, SKIP_DIRS, WIDGET_MESSAGE, runScan, scanText, type Finding } from '../src/scan.ts';

const repo = join(import.meta.dirname, '..');
const fixtures = join(import.meta.dirname, 'fixtures', 'scan');
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string };
const BRIDGE = 'http://localhost:8080';

function run(argv: string[], cwd = fixtures) {
  let stdout = '';
  let stderr = '';
  const code = runScan(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd });
  return { code, stdout, stderr };
}

/** A temp directory holding `files`, removed after the test. */
function tree(t: { after: (fn: () => void) => void }, files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cse-scan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const slashed = (path: string) => path.split(sep).join('/');
const pick = (findings: Finding[]) => findings.map((f) => `${f.status} ${f.rule} ${f.line}`);

// One call site that still goes to Google and one already pointed at the bridge, per rule.
const CASES: Array<{ rule: string; file: string; before: string; after: string }> = [
  {
    rule: 'raw-url',
    file: 'fetch.js',
    before: `const res = await fetch('https://www.googleapis.com/customsearch/v1?key=' + key);`,
    after: `const url = 'https://customsearch.googleapis.com/customsearch/v1'.replace('https://customsearch.googleapis.com', '${BRIDGE}');`,
  },
  {
    rule: 'siterestrict',
    file: 'search.py',
    before: `res = service.cse().siterestrict().list(q=q, cx=CX).execute()`,
    after: `res = service.cse().list(q=q, cx=CX).execute()`,
  },
  {
    rule: 'node-client',
    file: 'search.ts',
    before: `const client = google.customsearch('v1');`,
    after: `const client = customsearch({ version: 'v1', rootUrl: '${BRIDGE}/' });`,
  },
  {
    rule: 'python-client',
    file: 'search.py',
    before: `service = build('customsearch', 'v1', developerKey=KEY)`,
    after: `service = build("customsearch", "v1", developerKey=KEY,\n    client_options={"api_endpoint": "${BRIDGE}"})`,
  },
  {
    rule: 'langchain',
    file: 'agent.py',
    before: `search = GoogleSearchAPIWrapper()`,
    after: `search = GoogleSearchAPIWrapper()\nsearch.search_engine = engine`,
  },
  {
    rule: 'go',
    file: 'search.go',
    before: `svc, err := customsearch.NewService(ctx, option.WithAPIKey(key))`,
    after: `svc, err := customsearch.NewService(ctx,\n\toption.WithEndpoint("${BRIDGE}/"),\n)`,
  },
  {
    rule: 'java',
    file: 'Search.kt',
    before: `val cs = CustomSearchAPI.Builder(transport, json, null).build()`,
    after: `val cs = CustomSearchAPI.Builder(transport, json, null)\n    .setRootUrl("${BRIDGE}/")\n    .build()`,
  },
  {
    rule: 'ruby',
    file: 'search.rb',
    before: `service = Google::Apis::CustomsearchV1::CustomSearchAPIService.new`,
    after: `service = Google::Apis::CustomsearchV1::CustomSearchAPIService.new\nservice.root_url = '${BRIDGE}/'`,
  },
  {
    rule: 'php',
    file: 'search.php',
    before: `$service = new \\Google_Service_Customsearch($client);`,
    after: `$client->setConfig('base_path', '${BRIDGE}');\n$service = new Google\\Service\\CustomSearchAPI($client);`,
  },
];

describe('rules', () => {
  test('every rule is covered by a case here or by the widget test', () => {
    assert.deepEqual(
      RULES.map((r) => r.id),
      [...CASES.map((c) => c.rule), 'widget'],
    );
  });

  for (const c of CASES) {
    test(`${c.rule}: an untouched call site needs a change`, () => {
      const [finding, ...rest] = scanText(c.file, c.before, BRIDGE);
      assert.equal(rest.length, 0);
      assert.equal(finding!.rule, c.rule);
      assert.equal(finding!.status, 'needs-change');
      assert.equal(finding!.line, 1);
      assert.equal(finding!.snippet, c.before.trim());
    });

    test(`${c.rule}: a call site with its override nearby is repointed`, () => {
      const found = scanText(c.file, c.after, BRIDGE);
      if (c.rule === 'raw-url' || c.rule === 'siterestrict') {
        assert.deepEqual(found, [], 'nothing left to find');
      } else {
        assert.deepEqual(
          found.map((f) => `${f.status} ${f.rule}`),
          [`repointed ${c.rule}`],
        );
      }
    });
  }

  test('widget: always out of scope, with the fixed message and no claim about the widget itself', () => {
    const html = `<script async src="https://cse.google.com/cse.js?cx=abc"></script>\n<gcse:search></gcse:search>\n<!-- base_path rootUrl -->`;
    const found = scanText('index.html', html, BRIDGE);
    assert.deepEqual(pick(found), ['out-of-scope widget 1', 'out-of-scope widget 2']);
    assert.equal(found[0]!.fix, WIDGET_MESSAGE);
    assert.equal(WIDGET_MESSAGE, 'cse-bridge serves the JSON API only; this widget is not served by it');
  });

  test('the fix text matches the migration guide: trailing slash for rootUrl, none for api_endpoint', () => {
    const fix = (id: string) => RULES.find((r) => r.id === id)!.fix(BRIDGE);
    assert.equal(fix('raw-url'), 'swap the host: http://localhost:8080/customsearch/v1');
    assert.equal(fix('siterestrict'), 'the bridge has no siterestrict endpoint: call cse.list, and restrict sites in the cx profile');
    assert.equal(fix('node-client'), `rootUrl: 'http://localhost:8080/'`);
    assert.equal(fix('python-client'), 'client_options=ClientOptions(api_endpoint="http://localhost:8080")');
    assert.match(fix('langchain'), /^search\.search_engine = build\("customsearch", "v1", .*api_endpoint="http:\/\/localhost:8080"\)\)/);
    assert.equal(fix('go'), 'option.WithEndpoint("http://localhost:8080/")');
    assert.equal(fix('java'), '.setRootUrl("http://localhost:8080/")');
    assert.equal(fix('ruby'), `service.root_url = 'http://localhost:8080/'`);
    assert.equal(fix('php'), `$client->setConfig('base_path', 'http://localhost:8080');`);
  });
});

test('siterestrict is found in every generated client and in LangChain', () => {
  const spellings = [
    ['a.js', 'const res = await client.cse.siterestrict.list({ q, cx });'],
    ['a.py', 'res = service.cse().siterestrict().list(q=q, cx=CX).execute()'],
    ['a.py', 'search = GoogleSearchAPIWrapper(siterestrict=True)'],
    ['a.go', 'resp, err := svc.Cse.Siterestrict.List().Cx(cx).Q(q).Do()'],
    ['A.java', 'var res = cs.cse().siterestrict().list().setQ(q).execute();'],
    ['a.rb', 'res = service.list_cse_siterestricts(q: q, cx: cx)'],
    ['a.php', "$res = $service->cse_siterestrict->listCseSiterestrict(['q' => $q]);"],
    ['a.sh', 'curl "https://customsearch.googleapis.com/customsearch/v1/siterestrict?cx=$CX&q=x"'],
  ];
  for (const [file, line] of spellings) {
    assert.ok(pick(scanText(file, line, BRIDGE)).includes('needs-change siterestrict 1'), line);
  }
  const off = 'siterestrict: bool = False\nsearch = GoogleSearchAPIWrapper(siterestrict=False)';
  assert.deepEqual(scanText('a.py', off, BRIDGE).filter((f) => f.rule === 'siterestrict'), []);
});

describe('proximity', () => {
  const pad = (n: number) => Array.from({ length: n }, (_, i) => `x${i} = 1`).join('\n');

  test('the override counts up to 5 lines either side and not at 6', () => {
    const call = 'service = build("customsearch", "v1")';
    const opt = 'opts = {"api_endpoint": URL}';
    assert.deepEqual(pick(scanText('a.py', `${call}\n${pad(4)}\n${opt}`, BRIDGE)), ['repointed python-client 1']);
    assert.deepEqual(pick(scanText('a.py', `${call}\n${pad(5)}\n${opt}`, BRIDGE)), ['needs-change python-client 1']);
    assert.deepEqual(pick(scanText('a.py', `${opt}\n${pad(4)}\n${call}`, BRIDGE)), ['repointed python-client 6']);
    assert.deepEqual(pick(scanText('a.py', `${opt}\n${pad(5)}\n${call}`, BRIDGE)), ['needs-change python-client 7']);
  });

  test('a "before" line does not borrow the override from the "after" line next to it', () => {
    const js = [
      "import { customsearch } from '@googleapis/customsearch';",
      '',
      '// Before',
      "const client = customsearch({ version: 'v1' });",
      '',
      '// After',
      `const client = customsearch({ version: 'v1', rootUrl: '${BRIDGE}/' });`,
    ].join('\n');
    assert.deepEqual(pick(scanText('a.js', js, BRIDGE)), ['needs-change node-client 4', 'repointed node-client 7']);
  });

  test('an import is not a call site when the file also builds the client', () => {
    const js = `import { customsearch } from '@googleapis/customsearch';\n${pad(20)}\nconst c = customsearch({ rootUrl: u });`;
    assert.deepEqual(pick(scanText('a.js', js, BRIDGE)), ['repointed node-client 22']);
  });

  test('an import is reported when the construction is not one the rule recognises', () => {
    const go = `import "google.golang.org/api/customsearch/v1"\n${pad(10)}\nsvc := build(ctx)`;
    assert.deepEqual(pick(scanText('a.go', go, BRIDGE)), ['needs-change go 1']);
  });

  test('comment lines are neither call sites nor overrides', () => {
    const java = [
      '// cs = new CustomSearchAPI.Builder(t, j, null).build();',
      'cs = new CustomSearchAPI.Builder(t, j, null)',
      '    // .setRootUrl("http://localhost:8080/")',
      '    .build();',
      '/* new CustomSearchAPI.Builder(', ' * new CustomSearchAPI.Builder(', ' */',
    ].join('\n');
    assert.deepEqual(pick(scanText('A.java', java, BRIDGE)), ['needs-change java 2']);
    assert.deepEqual(scanText('a.py', '# service = build("customsearch", "v1")', BRIDGE), []);
    assert.deepEqual(scanText('a.html', '<!-- <script src="https://cse.google.com/cse.js"></script> -->', BRIDGE), []);
  });

  test('a JavaScript private field is code, not a comment', () => {
    const ts = "class Search {\n  #cs = customsearch({ version: 'v1' });\n}";
    assert.deepEqual(pick(scanText('search.ts', ts, BRIDGE)), ['needs-change node-client 2']);
  });

  test('a class statement named GoogleSearchAPIWrapper is not a call site', () => {
    const py = 'class GoogleSearchAPIWrapper(BaseModel):\n    pass\n\n\n\n\n\n\nsearch = GoogleSearchAPIWrapper()';
    assert.deepEqual(pick(scanText('a.py', py, BRIDGE)), ['needs-change langchain 9']);
    assert.deepEqual(scanText('a.py', 'class GoogleSearchAPIWrapper(BaseModel):\n    siterestrict: bool = False', BRIDGE), []);
    const imported = 'from langchain_community.utilities import (\n    GoogleSearchAPIWrapper,\n)';
    assert.deepEqual(pick(scanText('a.py', imported, BRIDGE)), ['needs-change langchain 2']);
  });

  test("TypeScript's CommonJS output of a customsearch() call is found", () => {
    const js = 'const customsearch_1 = require("@googleapis/customsearch");\nconst client = (0, customsearch_1.customsearch)("v1");';
    assert.deepEqual(pick(scanText('a.js', js, BRIDGE)), ['needs-change node-client 2']);
  });

  test('the LangChain override has to be an assignment after construction', () => {
    const py = 'search = GoogleSearchAPIWrapper(search_engine=engine)';
    assert.deepEqual(pick(scanText('a.py', py, BRIDGE)), ['needs-change langchain 1']);
  });

  test('importing ClientOptions is not an override', () => {
    const py = 'from google.api_core.client_options import ClientOptions\nservice = build("customsearch", "v1")';
    assert.deepEqual(pick(scanText('a.py', py, BRIDGE)), ['needs-change python-client 2']);
  });

  test('a build( call split one argument per line is found on its "customsearch" line', () => {
    const py = 'service = build(\n    "customsearch",\n    "v1",\n    client_options=ClientOptions(api_endpoint=URL),\n)';
    assert.deepEqual(pick(scanText('a.py', py, BRIDGE)), ['repointed python-client 2']);
  });
});

describe('what gets scanned', () => {
  test('client rules only run on their own language', () => {
    const java = 'import com.google.api.services.customsearch.v1.CustomSearchAPI;\nvar cs = new CustomSearchAPI.Builder(t, j, null).build();';
    assert.deepEqual(pick(scanText('Search.java', java, BRIDGE)), ['needs-change java 2']);
    assert.deepEqual(scanText('notes.txt', 'service = build("customsearch", "v1")', BRIDGE), []);
    assert.deepEqual(scanText('search.py', "const c = customsearch({ version: 'v1' });", BRIDGE), []);
  });

  test('raw URLs and the widget are found in any text file', () => {
    assert.deepEqual(pick(scanText('config.yaml', 'endpoint: https://www.googleapis.com/customsearch/v1', BRIDGE)), ['needs-change raw-url 1']);
    assert.deepEqual(pick(scanText('layout.erb', '<script src="https://www.google.com/cse/cse.js?cx=x"></script>', BRIDGE)), ['out-of-scope widget 1']);
  });

  test('the url.template every response carries is not a call site', () => {
    const json = '"template": "https://www.googleapis.com/customsearch/v1?q={searchTerms}&num={count?}&start={startIndex?}&cx={cx?}"';
    assert.deepEqual(scanText('recorded.json', json, BRIDGE), []);
  });

  test('Markdown: only fenced code, with the fence tag as the language and real line numbers', () => {
    const md = [
      '# Migrating', // 1
      '', // 2
      'We used GoogleSearchAPIWrapper and build("customsearch", "v1") before.', // 3
      '', // 4
      '```python', // 5
      'service = build("customsearch", "v1")', // 6
      '```', // 7
      '', // 8
      '```', // 9
      'service = build("customsearch", "v1", client_options=opts)', // 10
      '```', // 11
      '', // 12
      '```bash', // 13
      'service = build("customsearch", "v1")', // 14
      "curl 'https://www.googleapis.com/customsearch/v1?q=x'", // 15
      '```', // 16
      '', // 17
      '1. In a list:', // 18
      '', // 19
      '    ~~~js', // 20
      "    const c = customsearch({ version: 'v1' });", // 21
      '    ~~~', // 22
    ].join('\n');
    assert.deepEqual(pick(scanText('README.md', md, BRIDGE)), [
      'needs-change python-client 6',
      'repointed python-client 10',
      'needs-change raw-url 15',
      'needs-change node-client 21',
    ]);
  });

  test('a fence with an info string does not close a block, and a longer fence needs a longer close', () => {
    const md = ['```', '```python', 'service = build("customsearch", "v1")', '```', '````md', '```', "curl 'https://www.googleapis.com/customsearch/v1?q=x'", '````'].join('\n');
    assert.deepEqual(pick(scanText('a.md', md, BRIDGE)), ['needs-change python-client 3', 'needs-change raw-url 7']);
  });

  test('each code block is its own unit, so an override in the next block does not count', () => {
    const md = '```python\nservice = build("customsearch", "v1")\n```\n\n```python\nclient_options=ClientOptions(api_endpoint=URL)\n```';
    assert.deepEqual(pick(scanText('a.md', md, BRIDGE)), ['needs-change python-client 2']);
  });

  test('CRLF files report the same line numbers', () => {
    const lines = ['# header', '', 'import os', 'service = build("customsearch", "v1")', '', "u = 'https://www.googleapis.com/customsearch/v1'"];
    const lf = scanText('a.py', lines.join('\n'), BRIDGE);
    const crlf = scanText('a.py', lines.join('\r\n'), BRIDGE);
    assert.deepEqual(pick(crlf), ['needs-change python-client 4', 'needs-change raw-url 6']);
    assert.deepEqual(crlf, lf, 'no stray \\r in snippets either');
  });

  test('a line matching two rules reports each rule once, and a rule matching twice reports once', () => {
    const py = `r = build("customsearch", "v1"); u = "https://www.googleapis.com/customsearch/v1" + "https://customsearch.googleapis.com/"`;
    assert.deepEqual(pick(scanText('a.py', py, BRIDGE)), ['needs-change raw-url 1', 'needs-change python-client 1']);
  });

  test('a notebook cell is scanned through its JSON escaping', () => {
    const cell = '    "service = build(\\"customsearch\\", \\"v1\\", developerKey=KEY)\\n",';
    assert.deepEqual(pick(scanText('explore.ipynb', cell, BRIDGE)), ['needs-change python-client 1']);
  });

  test('a long line is cut in the snippet', () => {
    const [f] = scanText('bundle.js', `${'a'.repeat(500)}https://www.googleapis.com/customsearch/v1`, BRIDGE);
    assert.equal(f!.snippet.length, 203);
    assert.ok(f!.snippet.endsWith('...'));
  });
});

describe('walking the tree', () => {
  const hit = "curl 'https://www.googleapis.com/customsearch/v1?q=x'\n";

  test('skips dependency and build directories at any depth', (t) => {
    const files: Record<string, string> = { 'src/search.sh': hit };
    for (const name of SKIP_DIRS) {
      files[`${name}/search.sh`] = hit;
      files[`pkg/${name}/deep/search.sh`] = hit;
    }
    const dir = tree(t, files);
    const { code, stdout } = run(['--json'], dir);
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(stdout).findings.map((f: Finding) => f.file), ['src/search.sh']);
  });

  test('a directory named on the command line is scanned even if it has a skipped name', (t) => {
    const dir = tree(t, { 'build/search.sh': hit });
    assert.match(run(['build'], dir).stdout, /^needs-change {2}raw-url {8}search\.sh:1$/m);
  });

  test('skips binary files and files over 2 MB', (t) => {
    const nulEarly = Buffer.concat([Buffer.from(hit), Buffer.from([0])]);
    const nulLate = Buffer.concat([Buffer.from(hit), Buffer.alloc(8 * 1024, 0x20), Buffer.from([0])]);
    const huge = hit + ' '.repeat(MAX_FILE_BYTES);
    const dir = tree(t, { 'a.sh': nulEarly, 'b.sh': nulLate, 'c.sh': huge, 'd.sh': hit });
    const report = JSON.parse(run(['--json'], dir).stdout);
    assert.deepEqual(report.findings.map((f: Finding) => f.file), ['b.sh', 'd.sh'], 'a NUL past the first 8 KB does not make a file binary');
    assert.equal(report.summary.filesScanned, 2);
  });

  test('does not loop on a symlink cycle', (t) => {
    const dir = tree(t, { 'src/search.sh': hit });
    // A junction needs no privileges on Windows and is a plain symlink elsewhere.
    symlinkSync(dir, join(dir, 'src', 'loop'), 'junction');
    const report = JSON.parse(run(['--json'], dir).stdout);
    assert.deepEqual(report.findings.map((f: Finding) => f.file), ['src/search.sh']);
  });

  test('paths are relative to the root, with forward slashes', (t) => {
    const dir = tree(t, { 'a/b/c/search.sh': hit });
    const report = JSON.parse(run(['--json', 'a'], dir).stdout);
    assert.equal(report.root, slashed(join(dir, 'a')));
    assert.equal(report.findings[0].file, 'b/c/search.sh');
  });

  test('a single file is reported relative to its own directory; several paths relative to the cwd', (t) => {
    const dir = tree(t, { 'a/search.sh': hit, 'b/search.sh': hit });
    assert.equal(JSON.parse(run(['--json', 'a/search.sh'], dir).stdout).findings[0].file, 'search.sh');
    const both = JSON.parse(run(['--json', 'a', 'b', 'a/search.sh'], dir).stdout);
    assert.equal(both.root, slashed(dir));
    assert.deepEqual(both.findings.map((f: Finding) => f.file), ['a/search.sh', 'b/search.sh'], 'a file named twice is scanned once');
  });

  test('imports stand in for a call site only when no file in the scan builds the client', (t) => {
    const types = 'package search\n\nimport "google.golang.org/api/customsearch/v1"\n\nfunc q(r *customsearch.Search) {}';
    const built = 'package search\n\nfunc New() { svc, _ := customsearch.NewService(ctx) }';
    const both = tree(t, { 'types.go': types, 'client.go': built });
    assert.deepEqual(JSON.parse(run(['--json'], both).stdout).findings.map((f: Finding) => `${f.file}:${f.line}`), ['client.go:3']);
    const alone = tree(t, { 'types.go': types });
    assert.deepEqual(JSON.parse(run(['--json'], alone).stdout).findings.map((f: Finding) => `${f.file}:${f.line}`), ['types.go:3']);
  });

  test('an empty tree reports 0 call sites and exits 0', (t) => {
    const dir = tree(t, {});
    const { code, stdout } = run([], dir);
    assert.equal(code, 0);
    assert.equal(stdout, '0 call sites: 0 need a change, 0 already repointed, 0 out of scope\n');
  });
});

describe('runScan', () => {
  test('the fixture directory lists every rule', () => {
    const { code, stdout } = run([]);
    assert.equal(code, 1);
    for (const rule of RULES) assert.match(stdout, new RegExp(`  ${rule.id} `), rule.id);
    assert.match(stdout, /^19 call sites: 10 need a change, 8 already repointed, 1 out of scope$/m);
  });

  test('the worked example: text output and summary', (t) => {
    const app = [
      '"""Search helpers."""',
      'import os',
      '',
      'from google.api_core.client_options import ClientOptions',
      'from googleapiclient.discovery import build',
      '',
      'KEY = os.environ["CSE_KEY"]',
      'RAW = "https://www.googleapis.com/customsearch/v1"',
      '',
      '',
      'def legacy():',
      '    service = build("customsearch", "v1", developerKey=KEY)',
      '    return service',
      '',
      '',
      '',
      '',
      'def bridged():',
      '    return build("customsearch", "v1", developerKey=KEY,',
      '                 client_options=ClientOptions(api_endpoint="http://localhost:8080"))',
    ].join('\n');
    const dir = tree(t, { 'app.py': app });
    const { code, stdout } = run([], dir);
    assert.equal(code, 1);
    assert.equal(
      stdout,
      [
        'needs-change  raw-url        app.py:8',
        '    swap the host: http://localhost:8080/customsearch/v1',
        'needs-change  python-client  app.py:12',
        '    client_options=ClientOptions(api_endpoint="http://localhost:8080")',
        'repointed     python-client  app.py:19',
        '',
        '3 call sites: 2 need a change, 1 already repointed, 0 out of scope',
        '',
      ].join('\n'),
    );
  });

  test('--json prints the documented shape and parses', () => {
    const { code, stdout } = run(['--json']);
    assert.equal(code, 1);
    const report = JSON.parse(stdout);
    assert.deepEqual(Object.keys(report), ['version', 'root', 'findings', 'summary']);
    assert.equal(report.version, pkg.version);
    assert.equal(report.root, slashed(fixtures));
    assert.deepEqual(Object.keys(report.findings[0]), ['rule', 'lang', 'file', 'line', 'status', 'snippet', 'fix']);
    assert.deepEqual(report.summary, { callSites: 19, needsChange: 10, repointed: 8, outOfScope: 1, filesScanned: 9 });
    const py = report.findings.find((f: Finding) => f.file === 'search.py' && f.status === 'needs-change');
    assert.deepEqual(py, {
      rule: 'python-client',
      lang: 'python',
      file: 'search.py',
      line: 6,
      status: 'needs-change',
      snippet: 'service = build("customsearch", "v1", developerKey=KEY)',
      fix: 'client_options=ClientOptions(api_endpoint="http://localhost:8080")',
    });
  });

  test('exit 0 when everything is repointed, and for out-of-scope findings alone', (t) => {
    const dir = tree(t, {
      'ok.js': `const c = customsearch({ version: 'v1', rootUrl: '${BRIDGE}/' });`,
      'page.html': '<script src="https://cse.google.com/cse.js?cx=x"></script>',
    });
    const { code, stdout } = run([], dir);
    assert.equal(code, 0);
    assert.match(stdout, /^2 call sites: 0 need a change, 1 already repointed, 1 out of scope$/m);
  });

  test('exit 1 with one call site uses the singular', (t) => {
    const dir = tree(t, { 'a.sh': "curl 'https://www.googleapis.com/customsearch/v1'" });
    const { code, stdout } = run([], dir);
    assert.equal(code, 1);
    assert.match(stdout, /^1 call site: 1 needs a change, 0 already repointed, 0 out of scope$/m);
  });

  test('exit 2 for bad arguments and a missing path, with a clear message', () => {
    const cases: Array<[string[], RegExp]> = [
      [['--bogus'], /unknown option --bogus\nusage: cse-bridge scan/],
      [['--bridge-url'], /--bridge-url needs a URL/],
      [['--bridge-url', '--json'], /--bridge-url needs a URL/],
      [['--bridge-url', 'localhost:8080'], /--bridge-url must use http:\/\/ or https:\/\//],
      [['--bridge-url=not a url'], /--bridge-url must be an absolute http\(s\) URL/],
      [['no-such-dir'], /^cse-bridge scan: no-such-dir: no such file or directory\n$/],
    ];
    for (const [argv, message] of cases) {
      const { code, stdout, stderr } = run(argv);
      assert.equal(code, 2, argv.join(' '));
      assert.equal(stdout, '', argv.join(' '));
      assert.match(stderr, message, argv.join(' '));
    }
  });

  test('--bridge-url with trailing slashes: one slash on rootUrl, none on api_endpoint', () => {
    for (const url of ['https://search.example.com:9000/', 'https://search.example.com:9000///', 'https://search.example.com:9000']) {
      const report = JSON.parse(run(['--json', `--bridge-url=${url}`]).stdout);
      const fix = (rule: string) => report.findings.find((f: Finding) => f.rule === rule).fix;
      assert.equal(fix('node-client'), `rootUrl: 'https://search.example.com:9000/'`, url);
      assert.equal(fix('python-client'), 'client_options=ClientOptions(api_endpoint="https://search.example.com:9000")', url);
      assert.equal(fix('raw-url'), 'swap the host: https://search.example.com:9000/customsearch/v1', url);
    }
  });

  test('a raw URL on a line that already names the custom bridge URL is skipped', (t) => {
    const dir = tree(t, { 'a.js': "const u = process.env.CSE || 'https://www.googleapis.com/customsearch/v1'; // was, now https://bridge.lan" });
    assert.equal(run(['--bridge-url', 'https://bridge.lan/'], dir).code, 0);
    assert.equal(run([], dir).code, 1);
  });
});

describe('the cse-bridge bin', () => {
  let bin: string;
  let dir: string;

  // CI's test job does not build, so the bin under test gets its own dist next to it.
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'cse-scan-bin-'));
    mkdirSync(join(dir, 'bin'));
    copyFileSync(join(repo, 'bin', 'cse-bridge.js'), join(dir, 'bin', 'cse-bridge.js'));
    copyFileSync(join(repo, 'package.json'), join(dir, 'package.json'));
    const tsc = spawnSync(process.execPath, [join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(repo, 'tsconfig.json'), '--outDir', join(dir, 'dist')], { encoding: 'utf8' });
    assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
    bin = join(dir, 'bin', 'cse-bridge.js');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (...argv: string[]) => spawnSync(process.execPath, [bin, ...argv], { cwd: fixtures, encoding: 'utf8' });

  test('scan --help prints the help, scan included', () => {
    const r = cli('scan', '--help');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /cse-bridge scan \[path\.\.\.\] \[--json\] \[--bridge-url URL\]/);
  });

  test('scan with an unknown flag exits 2', () => {
    const r = cli('scan', '--bogus');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cse-bridge scan: unknown option --bogus/);
  });

  test('scan runs end to end and exits 1 on the fixtures', () => {
    const r = cli('scan', '--json');
    assert.equal(r.status, 1, r.stderr);
    assert.equal(JSON.parse(r.stdout).summary.callSites, 19);
  });

  test('import still dispatches', () => {
    const r = cli('import');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cse-bridge import: no annotations file given/);
  });
});
