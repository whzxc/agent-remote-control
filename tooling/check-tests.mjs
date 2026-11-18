import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ESLint } from 'eslint';
import { parseTests, testFiles, ts, walk } from './test-cases.mjs';

const allowlist = JSON.parse(readFileSync('tooling/test-policy-allowlist.json', 'utf8'));
const legacyPath = 'tooling/test-policy-legacy.txt';
const legacy = new Set(readFileSync(legacyPath, 'utf8').split(/\r?\n/).filter(Boolean));
const seenCases = new Set();
const used = new Set(), failures = [], inventory = new Map();
for (const entry of allowlist) {
  if (!entry.file || !entry.test || !entry.reason?.trim() || !entry.rules?.length
      || Object.keys(entry).some(key => !['file', 'test', 'reason', 'rules'].includes(key)))
    throw new Error('Allowlist entries require file, test, reason and explicit rules.');
}
function report(file, name, line, rule, message) {
  const index = allowlist.findIndex(e => e.file === file && e.test === name && e.rules.includes(rule));
  if (index >= 0) { used.add(index); return; }
  failures.push(`${file}:${line} [${name}] ${rule}: ${message}`);
}
const assertion = /\b(?:assert(?:_\w+)?!?\s*[.(]|expect\s*\()/;
const mockCount = /(?:\b(?:mock|spy)\b[^;]*?(?:calls|callCount|calledTimes|times|len\(|length)|\b(?:calls|fallbacks|attempts|reads|invocations)\b[^;]*?(?:len\(|length|is_empty\()|\btoHaveBeenCalled(?:Times|Once)?\s*\()/;
const stateRoot = /\bARC_STATE_DIR\b|\b(?:root|state_dir|stateDir)\s*\(|["'`](?:[^"'`]*[\\/])?(?:\.agent-remote-control|\.local[\\/]state[\\/]agent-remote-control|Library[\\/]Application Support[\\/]agent-remote-control)/;
const fsOperation = /(?:^|[.:])(?:readFile(?:Sync)?|writeFile(?:Sync)?|appendFile(?:Sync)?|readdir(?:Sync)?|mkdir(?:Sync)?|rm(?:Sync)?|open(?:Sync)?|read_to_string|read|write|remove_file|remove_dir_all|create_dir_all|save|load)$/;
for (const file of testFiles()) {
  const source = readFileSync(file, 'utf8'), parsed = parseTests(file, source);
  inventory.set(file, parsed);
  const locate = offset => parsed.cases.filter(c => offset >= c.start && offset < c.end).at(-1);
  const emit = (offset, rule, message) => report(file, locate(offset)?.name ?? '<harness>', source.slice(0, offset).split('\n').length, rule, message);
  for (const c of parsed.cases) {
    const caseKey = `${file}\t${c.name}`;
    seenCases.add(caseKey);
    const tags = c.comments.filter(s => /^\/\/\s*(?:Contract|Algorithmic core|Recurring bug class|Regression|Property)\s*:/.test(s));
    if (tags.length !== 1 || !/^\/\/ (?:Contract|Algorithmic core|Recurring bug class|Regression|Property): \S[^\n]*$/.test(tags[0] ?? ''))
      report(file, c.name, c.line, 'tag', 'Each case requires exactly one // test type tag with a reason.');
    if (c.comments.some(s => /^\/\/\s*(?:Contract|Algorithmic core|Recurring bug class|Regression|Property)\b/.test(s) && !tags.includes(s)))
      report(file, c.name, c.line, 'tag', 'Malformed test tag.');
    for (const a of c.assertions) {
      if (mockCount.test(a.text)) emit(a.start, 'mock-count', 'Assert delivered facts or returned results, not mock invocation counts.');
      // Rust macros have token trees; JS literals are checked below with the TS AST.
      if (file.endsWith('.rs') && /(?:(?:b?r#*|b)?"[^]*?[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][^]*?"#*)/u.test(a.text))
        emit(a.start, 'assertion-copy', 'CJK literals in assertions couple tests to localized copy; use structured facts.');
    }
  }
  if (file.endsWith('.rs')) {
    for (const c of parsed.cases) {
      const body = source.slice(c.start, c.end);
      if (stateRoot.test(body) && /(?:std::fs|fs::|File::|save\(|load\()/.test(body))
        emit(c.start, 'state-access', 'Use public operations, not the ARC state directory.');
    }
    continue;
  }
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.getSourceFile = name => name === file ? parsed.root : undefined;
  const checker = ts.createProgram([file], { noLib: true, noResolve: true, allowJs: true }, host).getTypeChecker();
  const aliases = new Set();
  const nodes = []; walk(parsed.root, node => nodes.push(node));
  for (const node of nodes) {
    if (ts.isPropertyAssignment(node) && node.name.getText(parsed.root) === 'ARC_STATE_DIR' && ts.isIdentifier(node.initializer))
      aliases.add(checker.getSymbolAtLocation(node.initializer));
  }
  const tainted = node => !!node && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && (stateRoot.test(node.getText(parsed.root)) || nodesWithin(node).some(n => ts.isIdentifier(n) && checker.getSymbolAtLocation(n) && aliases.has(checker.getSymbolAtLocation(n))));
  function nodesWithin(node) { const result = []; walk(node, n => result.push(n)); return result; }
  for (let changed = true; changed;) {
    changed = false;
    for (const node of nodes) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && tainted(node.initializer) && !aliases.has(checker.getSymbolAtLocation(node.name))) {
        aliases.add(checker.getSymbolAtLocation(node.name)); changed = true;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && tainted(node.right) && !aliases.has(checker.getSymbolAtLocation(node.left))) {
        aliases.add(checker.getSymbolAtLocation(node.left)); changed = true;
      }
    }
  }
  for (const node of nodes) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(parsed.root), offset = node.getStart(parsed.root);
      if (/(?:^|\.)getComputedStyle$/.test(expression)) emit(offset, 'computed-style', 'Move visual assertions to accept:ui.');
      if (/\.querySelector(?:All)?$/.test(expression) && node.arguments.some(arg => /\.[a-z_-]/i.test(arg.text ?? arg.getText(parsed.root))))
        emit(offset, 'class-selector', 'Use accessible role/name queries.');
      if (fsOperation.test(expression) && !/^(?:read|write|load|save)$/.test(expression) && tainted(node.arguments[0])) emit(offset, 'state-access', 'Use public operations, not the ARC state directory.');
      if (assertion.test(expression)) {
        for (const literal of nodesWithin(node).filter(n => ts.isStringLiteralLike(n) || ts.isRegularExpressionLiteral(n) || ts.isTemplateExpression(n)))
          if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(literal.getText(parsed.root)))
            emit(offset, 'assertion-copy', 'CJK literals in assertions couple tests to localized copy; compare fixture data or structured facts.');
        if (mockCount.test(node.getText(parsed.root))) emit(offset, 'mock-count', 'Assert outcomes, not mock invocation counts.');
      }
    }
  }
}
const eslint = new ESLint();
for (const result of await eslint.lintFiles(['tests/**/*.{ts,tsx,js,mjs}'])) {
  const file = result.filePath.slice(process.cwd().length + 1), cases = inventory.get(file)?.cases ?? [];
  for (const m of result.messages) {
    const name = cases.filter(c => c.line <= m.line && c.node && (file.endsWith('.rs') || c.node.getSourceFile().getLineAndCharacterOfPosition(c.end).line + 1 >= m.line)).at(-1)?.name ?? '<harness>';
    report(file, name, m.line, m.ruleId ?? 'syntax', m.message);
  }
}
for (const key of legacy) if (!seenCases.has(key)) failures.push(`Stale legacy test-policy entry: ${key}`);
let baselineLegacy = new Set();
try { baselineLegacy = new Set(execFileSync('git', ['show', `HEAD:${legacyPath}`], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)); } catch {}
for (const key of legacy) if (baselineLegacy.size && !baselineLegacy.has(key)) failures.push(`Legacy test-policy list may only shrink: ${key}`);
for (const [index, entry] of allowlist.entries()) if (!used.has(index)) failures.push(`Stale allowlist entry: ${entry.file} [${entry.test}]`);
// The dispatch owner must grant this capability explicitly. CI can compare the full PR base.
const base = process.env.ARC_TEST_POLICY_BASE ?? 'HEAD';
const protectedPaths = ['tests/contract', 'tooling/test-policy-allowlist.json'];
const changed = execFileSync('git', ['diff', '--name-only', base, '--', ...protectedPaths], { encoding: 'utf8' })
  + execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...protectedPaths], { encoding: 'utf8' });
if (changed.trim() && process.env.ARC_TEST_POLICY_OWNER !== '1') failures.push('Protected test policy changed. Only an explicit control-source dispatch grant permits ARC_TEST_POLICY_OWNER=1.');
if (failures.length) { console.error([...new Set(failures)].join('\n')); process.exitCode = 1; }
else console.log(`Test policy passed: ${[...inventory.values()].reduce((n, v) => n + v.cases.length, 0)} cases; ${allowlist.length} scoped exceptions.`);
