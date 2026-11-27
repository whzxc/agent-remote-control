import ts from 'typescript';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const shared = 'ui/components/ui/';
const kit = 'ui/components/kit/';

// Feature folders are one consumer even when split across implementation files.
// The legacy flat components folder and the two Board/AX features use file ownership.
export function featureOwner(file) {
  const parts = file.split('/');
  if (parts[1] === 'coordination') return file;
  if (parts[1] === 'components') return parts.length === 3 ? file : parts.slice(0, 3).join('/');
  return parts.length > 2 ? parts.slice(0, 2).join('/') : file;
}

export function inspectConsumers(base = root) {
  const files = readdirSync(path.join(base, 'ui'), { recursive: true })
    .filter(file => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
    .map(file => `ui/${file.split(path.sep).join('/')}`);
  const modules = new Map();
  function resolve(file, specifier) {
    const candidate = specifier.startsWith('@/')
      ? path.posix.normalize(`ui/${specifier.slice(2)}`)
      : specifier.startsWith('.')
        ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
        : undefined;
    if (!candidate) return;
    return [candidate, `${candidate}.ts`, `${candidate}.tsx`, `${candidate}/index.ts`, `${candidate}/index.tsx`]
      .find(file => existsSync(path.join(base, file)) && statSync(path.join(base, file)).isFile());
  }
  for (const file of files) {
    const ast = ts.createSourceFile(file, readFileSync(path.join(base, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const imports = new Map(), definitions = new Map(), exports = new Map(), reexports = [], namespaces = new Map(), stars = [];
    for (const node of ast.statements) {
      if (ts.isImportDeclaration(node) && node.importClause && !node.importClause.isTypeOnly) {
        const target = resolve(file, node.moduleSpecifier.text), clause = node.importClause;
        if (!target) continue;
        if (clause.name) imports.set(clause.name.text, [target, 'default']);
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const entry of clause.namedBindings.elements) if (!entry.isTypeOnly) imports.set(entry.name.text, [target, (entry.propertyName ?? entry.name).text]);
        } else if (clause.namedBindings) namespaces.set(clause.namedBindings.name.text, target);
      }
      const exported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
      const defaultExport = node.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword);
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
        definitions.set(node.name.text, node);
        if (exported) exports.set(defaultExport ? 'default' : node.name.text, node.name.text);
      } else if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) if (ts.isIdentifier(declaration.name)) {
          definitions.set(declaration.name.text, declaration);
          if (exported) exports.set(declaration.name.text, declaration.name.text);
        }
      } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
        const target = node.moduleSpecifier && resolve(file, node.moduleSpecifier.text);
        if (node.exportClause && ts.isNamedExports(node.exportClause)) for (const entry of node.exportClause.elements) {
          if (entry.isTypeOnly) continue;
          if (target) reexports.push([entry.name.text, target, (entry.propertyName ?? entry.name).text]);
          else exports.set(entry.name.text, (entry.propertyName ?? entry.name).text);
        }
        else if (target && !node.exportClause) stars.push(target);
      } else if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) exports.set('default', node.expression.text);
    }
    modules.set(file, { ast, imports, definitions, exports, reexports, namespaces, stars });
  }
  function endpoint(file, name, visited = new Set()) {
    const id = `${file}#${name}`;
    if (visited.has(id)) return;
    visited.add(id);
    const module = modules.get(file);
    if (!module) return;
    const local = module.exports.get(name);
    if (local) {
      if (module.definitions.has(local)) return [file, local];
      if (module.imports.has(local)) return endpoint(...module.imports.get(local), visited);
    }
    const reexport = module.reexports.find(entry => entry[0] === name);
    if (reexport) return endpoint(reexport[1], reexport[2], visited);
    for (const target of module.stars) { const result = endpoint(target, name, visited); if (result) return result; }
  }
  function dependencies(file, node) {
    const module = modules.get(file), result = new Set();
    function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node)) return;
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && module.namespaces.has(node.expression.text)) {
        const target = endpoint(module.namespaces.get(node.expression.text), node.name.text);
        if (target) result.add(target.join('#'));
      }
      if (ts.isIdentifier(node)) {
        const entry = module.imports.get(node.text), target = entry && endpoint(...entry);
        if (target) result.add(target.join('#'));
        else if (module.definitions.has(node.text) && module.definitions.get(node.text) !== node) result.add(`${file}#${node.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(node);
    return result;
  }
  const edges = new Map(), consumers = new Map();
  for (const [file, module] of modules) for (const [name, node] of module.definitions) edges.set(`${file}#${name}`, dependencies(file, node));
  for (const [file, module] of modules) if (!file.startsWith(shared) && !file.startsWith(kit)) {
    const visited = new Set();
    function visit(id) {
      if (visited.has(id) || (!id.startsWith(shared) && !id.startsWith(kit))) return;
      visited.add(id);
      if (id.startsWith(shared)) {
        if (!consumers.has(id)) consumers.set(id, new Set());
        consumers.get(id).add(featureOwner(file));
      }
      for (const dependency of edges.get(id) ?? []) visit(dependency);
    }
    for (const id of dependencies(file, module.ast)) visit(id);
  }
  const parts = [];
  for (const [file, module] of modules) if (file.startsWith(shared)) for (const [name, local] of module.exports) {
    if (!module.definitions.has(local)) continue; // Reexports are counted at their defining source; types have no runtime owner.
    const owners = [...consumers.get(`${file}#${local}`) ?? []].sort();
    parts.push({ file, export: name, local, consumers: owners, count: owners.length });
  }
  return parts;
}

export function checkConsumers(base = root) {
  const parts = inspectConsumers(base);
  return { parts, errors: parts.filter(part => part.count < 2).map(part => `${part.file}#${part.export}: ${part.count} feature consumer(s) [${part.consumers.join(', ')}]; move this export to its feature or delete an unused part.`) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkConsumers();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else if (result.errors.length) console.error(result.errors.join('\n'));
  else console.log(`Shared consumer policy passed (${result.parts.length} runtime exports, at least two feature consumers each).`);
  if (result.errors.length) process.exitCode = 1;
}
