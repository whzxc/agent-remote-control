import ts from 'typescript';
import { parse, registerDynamicLanguage } from '@ast-grep/napi';
import rust from '@ast-grep/lang-rust';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
registerDynamicLanguage({ rust });

export function testFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
    .split('\0').filter(file => (/\.(?:test\.[cm]?[jt]sx?|rs)$/.test(file) || /^tests\/.*\.[cm]?[jt]sx?$/.test(file)) && existsSync(file));
}
export function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, child => { walk(child, visit); });
}
export { ts };
export function parseTests(file, source) {
  const cases = [];
  if (file.endsWith('.rs')) {
    const root = parse('rust', source).root();
    for (const node of root.findAll({ rule: { kind: 'function_item' } })) {
      const preceding = [];
      for (let previous = node.prev(); previous && /comment|attribute_item/.test(previous.kind()); previous = previous.prev()) preceding.unshift(previous.text());
      if (!preceding.some(text => /#\[(?:\w+::)*test(?:\([^]*\))?\]/.test(text))) continue;
      const body = node.field('body');
      cases.push({ name: node.field('name').text(), start: node.range().start.index, end: node.range().end.index,
        line: node.range().start.line + 1, bodyStart: body.range().start.index, node,
        comments: [...preceding.filter(s => s.startsWith('//')), ...body.findAll({ rule: { kind: 'line_comment' } }).map(n => n.text())],
        assertions: node.findAll({ rule: { kind: 'macro_invocation' } }).filter(n => /^(?:assert|debug_assert)(?:_\w+)?!/.test(n.text())).map(n => ({ text: n.text(), start: n.range().start.index, end: n.range().end.index, node: n })) });
    }
    return { cases, root };
  }
  const root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  walk(root, node => {
    if (!ts.isCallExpression(node) || !/^(?:(?:\w+\.)?(?:test|it))(?:\.(?:skip|only|todo))?$/.test(node.expression.getText(root))) return;
    const callback = node.arguments.find(n => ts.isArrowFunction(n) || ts.isFunctionExpression(n));
    const name = node.arguments[0]?.text ?? node.arguments[0]?.getText(root);
    const start = node.getStart(root), end = node.end;
    const comments = (ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []).map(r => source.slice(r.pos, r.end));
    // The scanner distinguishes comments from quoted and template strings.
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, callback ? source.slice(callback.body.getStart(root), callback.body.end) : '');
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan())
      if (token === ts.SyntaxKind.SingleLineCommentTrivia) comments.push(scanner.getTokenText());
    const assertions = [];
    if (callback) walk(callback.body, n => {
      if (ts.isCallExpression(n) && /^(?:assert(?:\.|\()|expect\()/.test(n.getText(root)) && !ts.isCallExpression(n.parent))
        assertions.push({ text: n.getText(root), start: n.getStart(root), end: n.end, node: n });
    });
    cases.push({ name, start, end, line: root.getLineAndCharacterOfPosition(start).line + 1, bodyStart: callback?.body.getStart(root) ?? start, comments, assertions, node });
  });
  return { cases, root };
}

// Compare syntax tokens so reformatting an assertion does not count as churn.
export function assertionSignature(testCase) {
  function tokens(node) {
    if (typeof node.kind === 'function') {
      if (/comment/.test(node.kind())) return [];
      const children = node.children();
      return children.length ? children.flatMap(tokens) : [node.text()];
    }
    if (ts.isStringLiteralLike(node)) return [JSON.stringify(node.text)];
    const children = node.getChildren();
    return children.length ? children.flatMap(tokens) : [node.getText()];
  }
  return JSON.stringify(testCase.assertions.map(a => tokens(a.node).filter((token, i, all) => token !== "," || !["}", "]", ")"].includes(all[i + 1]))));
}
