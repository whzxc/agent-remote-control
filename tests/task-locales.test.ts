import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

test("task detail messages exist in both supported locales, including every dynamic decision", () => {
  // Recurring bug class: skipping a task question rendered the untranslated activity.cancel key.
  const config = ts.readConfigFile("ui/tsconfig.json", ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, "ui");
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const messages = ["en", "zh-CN"].map(locale => ({ locale, values: JSON.parse(readFileSync(`ui/locales/${locale}.json`, "utf8")) as Record<string, string> }));
  const components = new Set(["ActivityTimeline", "ActivityInteraction", "TimelineEntries", "TaskChanges", "TaskNeedsYou", "TaskOutcome", "TaskQuestion", "TaskOwnership", "RequestRouting"]);
  const keys = new Set<string>();
  const literals = (type: ts.Type): string[] => {
    if (type.isStringLiteral()) return [type.value];
    if (type.isUnion()) return type.types.flatMap(literals);
    throw new Error(`Task message key is not finite: ${checker.typeToString(type)}`);
  };
  const values = (node: ts.Expression): string[] => {
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isConditionalExpression(node)) return [...values(node.whenTrue), ...values(node.whenFalse)];
    if (ts.isTemplateExpression(node)) return node.templateSpans.reduce((prefixes, span) =>
      prefixes.flatMap(prefix => values(span.expression).map(value => prefix + value + span.literal.text)), [node.head.text]);
    return literals(checker.getTypeAtLocation(node));
  };
  for (const source of program.getSourceFiles()) {
    const component = source.fileName.match(/\/components\/([^/]+)\.tsx$/)?.[1];
    if (!components.has(component ?? "") && !source.fileName.endsWith("/state/taskReview.ts")) continue;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
        try { values(node.arguments[0]).forEach(key => keys.add(key)); }
        catch (error) { throw new Error(`${source.fileName}: ${node.getText()}\n${error}`); }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(keys.size > 0, "Task detail message calls must be covered");
  for (const { locale, values } of messages) {
    assert.deepEqual([...keys].filter(key => !Object.hasOwn(values, key) || !values[key].trim()), [], `${locale} is missing task detail messages`);
  }
});
