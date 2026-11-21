import path from 'node:path';
import ts from 'typescript';

const kebab = name => name.startsWith('--') ? name : name.replace(/^Webkit(?=[A-Z])/, '').replace(/[A-Z]/g, c => '-' + c.toLowerCase()).replace(/^-/, '');
const propertyName = node => ts.isComputedPropertyName(node) ? node.expression.text : node.text;
function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node))) node = node.expression;
  return node;
}

// Inspect timing at its consumer. A field named "duration" in a task record is ordinary data.
export function inspectMotionScripts(base, files) {
  const sources = files.filter(file => /\.[cm]?[jt]sx?$/.test(file) && !file.endsWith('.d.ts'));
  const program = ts.createProgram(sources.map(file => path.join(base, file)), {
    noLib: true, noResolve: true, types: [], allowJs: true, jsx: ts.JsxEmit.Preserve,
  });
  const checker = program.getTypeChecker(), rows = [];
  function declaration(node) {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  }
  function resolve(node, seen = new Set()) {
    node = unwrap(node);
    if (!node || !ts.isIdentifier(node) || seen.has(node)) return node;
    const variable = declaration(node);
    if (!variable || !ts.isVariableDeclaration(variable) || !(variable.parent.flags & ts.NodeFlags.Const)) return node;
    return resolve(variable.initializer, seen.add(node));
  }
  function imported(node) {
    if (!node) return {};
    const part = ts.isPropertyAccessExpression(node) ? node.expression : node;
    const spec = declaration(part);
    if (!spec) return {};
    if (ts.isImportSpecifier(spec)) return { name: (spec.propertyName ?? spec.name).text, source: spec.parent.parent.parent.moduleSpecifier.text };
    if (ts.isNamespaceImport(spec)) return { name: node.name?.text, source: spec.parent.parent.moduleSpecifier.text };
    return {};
  }
  for (const file of sources) {
    const ast = program.getSourceFile(path.join(base, file));
    function tokenCall(node) {
      if (!node || !ts.isCallExpression(node)) return false;
      const { name, source } = imported(node.expression);
      return name === 'motionTransition' && path.posix.normalize(path.posix.join(path.posix.dirname(file), source)).replace(/\.ts$/, '') === 'ui/motion/tokens';
    }
    function tokenField(node, field) {
      node = resolve(node);
      if (!node) return false;
      if (ts.isConditionalExpression(node)) return tokenField(node.whenTrue, field) && tokenField(node.whenFalse, field);
      return (field === 'duration' && ts.isNumericLiteral(node) && Number(node.text) === 0) ||
        (ts.isPropertyAccessExpression(node) && node.name.text === field && tokenCall(resolve(node.expression)));
    }
    function options(node) {
      node = resolve(node);
      if (!node) return false;
      if (ts.isConditionalExpression(node)) return options(node.whenTrue) && options(node.whenFalse);
      if (tokenCall(node)) return true;
      if (!ts.isObjectLiteralExpression(node)) return false;
      let time = false, ease = false, instant = false;
      for (const prop of node.properties) {
        if (ts.isSpreadAssignment(prop)) {
          if (!tokenCall(resolve(prop.expression))) return false;
          time = ease = true;
          continue;
        }
        const value = ts.isShorthandPropertyAssignment(prop) ? prop.name : prop.initializer;
        const field = propertyName(prop.name);
        if (field === 'duration') {
          if (!tokenField(value, field)) return false;
          time = true;
          instant = resolve(value)?.text === '0';
        } else if (field === 'ease') {
          if (!tokenField(value, field)) return false;
          ease = true;
        } else if (field === 'delay' || field === 'repeatDelay') {
          if (!tokenField(value, 'duration')) return false;
        } else if (field === 'repeat' && ts.isNumericLiteral(resolve(value) ?? prop)) continue;
        else if (field === 'repeatType' && ['loop', 'reverse', 'mirror'].includes(resolve(value)?.text)) continue;
        else if (field === 'type' && resolve(value)?.text === 'tween') continue;
        else return false;
      }
      return time && (instant || ease);
    }
    function record(node, selector, property, value, issues) {
      rows.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart()).line + 1, selector, property, value, issues });
    }
    function css(node, name, expr) {
      if (typeof name !== 'string' || !expr) return;
      const prop = kebab(name);
      if (!/^(?:animation|transition)(?:-|$)/.test(prop) && !name.startsWith('--')) return;
      let ancestor = node.parent;
      while (ancestor && !ts.isJsxOpeningElement(ancestor) && !ts.isJsxSelfClosingElement(ancestor)) ancestor = ancestor.parent;
      const cls = ancestor?.attributes.properties.find(a => a.name?.text === 'className')?.initializer;
      const staticClass = cls && (ts.isStringLiteral(cls) ? cls.text :
        cls.expression && ts.isTemplateExpression(cls.expression) ? cls.expression.head.text.replace(/[^\s]*$/, '').trim() : '');
      const selector = staticClass ? '.' + staticClass.trim().split(/\s+/).join('.') : ancestor?.tagName.getText() ?? '<style>';
      const value = resolve(expr);
      record(node, selector, name.startsWith('--') ? name : prop,
        value && ts.isStringLiteralLike(value) ? value.text : expr.getText());
    }
    const invalid = ['use motionTransition() for duration and easing, or an instant transition'];
    function timing(node, target, expr) {
      record(node, target, 'transition', expr?.getText() ?? '(implicit)', options(expr) ? [] : invalid);
    }
    function webEase(value) {
      if (!value || !ts.isCallExpression(value)) return false;
      const call = value.expression.name?.text === 'trim' ? value.expression.expression : value;
      return ts.isCallExpression(call) && call.expression.name?.text === 'getPropertyValue' &&
        ts.isCallExpression(call.expression.expression) && call.expression.expression.expression.getText() === 'getComputedStyle' &&
        /^--ease-(enter|exit|running)$/.test(call.arguments[0]?.text);
    }
    // Web Animations takes milliseconds and a CSS easing string; Motion takes seconds and a tuple.
    function webTiming(node, target, expr) {
      const value = resolve(expr);
      const fields = value && ts.isObjectLiteralExpression(value) ? value.properties : [];
      const milliseconds = item => {
        item = resolve(item);
        return item && (ts.isNumericLiteral(item) && Number(item.text) === 0 ||
          ts.isBinaryExpression(item) && item.operatorToken.kind === ts.SyntaxKind.AsteriskToken &&
          tokenField(item.left, 'duration') && resolve(item.right)?.text === '1000');
      };
      let time = milliseconds(value), ease = time && value.text === '0';
      for (const field of fields) {
        const v = resolve(field.initializer);
        if (!field.name || !v) { time = false; break; }
        const name = propertyName(field.name);
        if (name === 'duration') { time = milliseconds(v); if (v.text === '0') ease = true; }
        else if (name === 'easing') {
          ease = webEase(v);
        } else if (name === 'delay' || name === 'endDelay') {
          if (!milliseconds(v)) { time = false; break; }
        } else if (name === 'iterations' && v.getText() === 'Infinity') { time = false; break; }
      }
      record(node, target, 'options', value?.getText() ?? '(implicit)', time && ease ? [] :
        ['Web Animations requires token-derived milliseconds and easing or instant timing']);
    }
    // A focus callback also runs on the next frame. Only a callback that schedules
    // itself (directly or through a React ref) owns an animation clock.
    function inspectFrame(node) {
      let callback = node.parent;
      while (callback && !ts.isFunctionLike(callback)) callback = callback.parent;
      let owner = callback;
      if (owner && !ts.isFunctionDeclaration(owner)) {
        owner = owner.parent;
        if (ts.isCallExpression(owner)) owner = owner.parent;
        if (!ts.isVariableDeclaration(owner)) return;
      }
      if (!owner?.name || !ts.isIdentifier(owner.name)) return;
      const target = node.arguments[0];
      if (!target) return;
      function invokesOwner(expr) {
        if (ts.isIdentifier(expr)) return declaration(expr) === owner;
        if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'current') {
          const ref = resolve(expr.expression);
          return ref && ts.isCallExpression(ref) && ref.expression.getText() === 'useRef' &&
            ref.arguments[0] && ts.isIdentifier(ref.arguments[0]) && declaration(ref.arguments[0]) === owner;
        }
        return false;
      }
      function callsOwner(child) {
        return ts.isCallExpression(child) && invokesOwner(child.expression) || ts.forEachChild(child, callsOwner);
      }
      if (!invokesOwner(target) && !callsOwner(target)) return;
      const selector = owner.name.text;
      const topology = (file === 'ui/topology/Topology.tsx' && selector === 'tick') ||
        (file === 'ui/components/ui/NodeCapsule.tsx' && selector === 'step');
      record(node, selector, 'requestAnimationFrame', target.getText(), topology ? [] :
        ['recurring frame interpolation requires the topology animator or named artwork']);
    }
    function visit(node) {
      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        const name = propertyName(node.name), value = node.initializer ?? node.name;
        if (name === 'transition' && (ts.isObjectLiteralExpression(resolve(value) ?? value) || tokenCall(resolve(value)))) timing(node, '<motion options>', value);
        else css(node, name, value);
        if (name === 'easing' && ts.isArrayLiteralExpression(node.parent.parent)) {
          record(node, '<keyframe>', 'easing', value.getText(), webEase(resolve(value)) ? [] : ['per-keyframe easing requires a token']);
        }
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const props = node.attributes.properties;
        const transition = props.find(p => p.name?.text === 'transition');
        const tag = node.tagName.getText();
        const component = imported(ts.isPropertyAccessExpression(node.tagName) ? node.tagName.expression : node.tagName);
        if (transition || component.source === 'motion/react' && props.some(p => ['animate','layout','exit','whileHover','whileTap','whileDrag'].includes(p.name?.text))) {
          timing(transition ?? node, tag, transition?.initializer?.expression);
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const lhs = node.left;
        if (ts.isPropertyAccessExpression(lhs) || ts.isElementAccessExpression(lhs)) css(node, lhs.name?.text ?? lhs.argumentExpression?.text, node.right);
      }
      if (ts.isCallExpression(node)) {
        const expr = resolve(node.expression), callee = imported(expr);
        if (expr && (expr.text === 'requestAnimationFrame' || expr.name?.text === 'requestAnimationFrame')) inspectFrame(node);
        if (callee.name === 'animate' && ['motion', 'motion/react'].includes(callee.source)) {
          timing(node, `animate(${node.arguments[0]?.getText() ?? ''})`, node.arguments[2]);
        } else if (ts.isPropertyAccessExpression(node.expression)) {
          if (node.expression.name.text === 'setProperty') css(node, node.arguments[0]?.text, node.arguments[1]);
          if (node.expression.name.text === 'animate') webTiming(node, 'Element.animate()', node.arguments[1]);
        }
      }
      if (ts.isNewExpression(node) && node.expression.getText() === 'KeyframeEffect') webTiming(node, 'KeyframeEffect', node.arguments?.[2]);
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return rows;
}
