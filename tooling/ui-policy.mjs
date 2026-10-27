import { createHash } from 'node:crypto';
import { matchesGlob, relative } from 'node:path';

export const uiFiles = ['ui/**/*.{ts,tsx,js,jsx,mjs}'];
// Keep ordinary feature controls inside enforcement.
export const uiIgnores = [
  'ui/components/ui/**', 'ui/components/composites/**', 'ui/components/objects/**',
  'ui/design-mount/**',
  'ui/topology/{geometry,solve,render,animate,orientation,Topology,Hub,accountViews}.{ts,tsx}',
];
export function isFeatureFile(file) {
  return file.startsWith('ui/') && !uiIgnores.some(pattern => matchesGlob(file, pattern));
}

export function fingerprint(sourceCode, node) {
  return createHash('sha256').update(JSON.stringify(sourceCode.getTokens(node).map(token => token.value))).digest('hex');
}
export function relativeFile(file) {
  return relative(process.cwd(), file).replaceAll('\\', '/');
}

const replacements = {
  button: 'Button or IconButton', input: 'Input, Switch or ChoiceControl inside FormField',
  select: 'ChoiceControl or SingleChoice', textarea: 'Textarea inside FormField', label: 'FormField or SettingRow',
  details: 'Disclosure', summary: 'Disclosure', dl: 'FactList', dt: 'FactList', dd: 'FactList',
};
function propertyName(node) {
  return node?.type === 'Identifier' ? node.name : typeof node?.value === 'string' ? node.value : undefined;
}
function memberName(node) {
  if (node?.type !== 'MemberExpression') return propertyName(node);
  return node.computed && node.property.type !== 'Literal' ? undefined : propertyName(node.property);
}
const layoutProperty = /^(?:margin|padding|gap|rowGap|columnGap|display|flex|grid|align|justify|place|order|float|clear|columns|columnCount|columnWidth|columnRule)/;
function unwrap(node) {
  while (node && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ChainExpression'].includes(node.type)) node = node.expression;
  return node;
}
function inRenderedExpression(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'JSXExpressionContainer') {
      const attribute = parent.parent;
      if (attribute.type !== 'JSXAttribute') return true;
      return !/^on[A-Z]/.test(attribute.name.name) && attribute.parent.name?.name !== 'DispatchSpec';
    }
    if (parent.type === 'FunctionDeclaration') return false;
  }
  return false;
}

// Match utility values, not arbitrary selectors such as [&>svg]:size-4.
// String literals inside cn/cva and conditional className expressions are included.
const arbitraryDesignValue = /(?:^|[\s:!])(?:-?(?:bg|text|font|leading|tracking|decoration|placeholder|border(?:-[xytrblse])?|divide|outline|ring(?:-offset)?|fill|stroke|shadow|accent|caret|rounded(?:-[a-z]+)?|[mp][xytrblse]?|space-[xy]|gap(?:-[xy])?|indent|size|[wh]|min-[wh]|max-[wh]))-(?:\[[^\]]+\]|\([^)]*\))|\[(?:color|background(?:-color)?|font[^:]*|line-height|letter-spacing|padding[^:]*|margin[^:]*|gap|border-radius):[^\]]+\]/g;
function inspectUtilityText(node, value, report) {
  if (typeof value !== 'string') return;
  arbitraryDesignValue.lastIndex = 0;
  const match = arbitraryDesignValue.exec(value);
  if (match) report(node, { value: match[0].trim() });
}

export function createUiPlugin(baseline) {
  function rule(name, message, visit) {
    return {
      meta: { type: 'problem', schema: [], messages: { violation: message, stale: 'UI debt was removed. Remove or reduce stale {{rule}} baseline entry {{key}} and update docs/dev/ui-debt.md; never reuse it for new code.' } },
      create(context) {
        const source = context.sourceCode;
        const allowed = baseline.files?.[relativeFile(context.filename)]?.[name] ?? {};
        const seen = new Map();
        function report(node, data) {
          const key = fingerprint(source, node), count = (seen.get(key) ?? 0) + 1;
          seen.set(key, count);
          if (count > (allowed[key] ?? 0)) context.report({ node, messageId: 'violation', data });
        }
        return {
          ...visit(report),
          'Program:exit'(node) {
            for (const [key, count] of Object.entries(allowed)) {
              if ((seen.get(key) ?? 0) < count) context.report({ node, messageId: 'stale', data: { rule: name, key } });
            }
          },
        };
      },
    };
  }
  return { rules: {
    'shared-controls': rule('shared-controls', 'Use {{component}} from the shared UI components instead of raw <{{tag}}>. Add a missing pattern to the shared layer when a screen needs it.', report => ({
      JSXOpeningElement(node) {
        if (node.name.type === 'JSXIdentifier' && replacements[node.name.name]) report(node, { tag: node.name.name, component: replacements[node.name.name] });
      },
    })),
    'semantic-utilities': rule('semantic-utilities', 'Use Tailwind scale utilities and semantic tokens; arbitrary color, spacing, radius and typography values are forbidden ({{value}}).', report => ({
      Literal(node) { inspectUtilityText(node, node.value, report); },
      TemplateElement(node) { inspectUtilityText(node, node.value.raw, report); },
    })),
    'single-choice': rule('single-choice', 'Use SingleChoice or ChoiceControl; direct Select and ToggleGroup belong in ui/components/ui.', report => ({
      ImportDeclaration(node) {
        if (/(?:\/(?:select|toggle-group|radio-group)(?:\.[cm]?[jt]sx?)?$|^@radix-ui\/react-(?:select|toggle-group|radio-group)$)/.test(node.source.value)) report(node);
        if (node.source.value === 'radix-ui' && node.specifiers.some(specifier => ['Select', 'RadioGroup', 'ToggleGroup'].includes(specifier.imported?.name))) report(node);
      },
    })),
    'dispatch-spec': rule('dispatch-spec', 'Render recorded model, effort and service-tier fields through DispatchSpec; do not build a dispatch summary in feature JSX.', report => ({
      MemberExpression(node) {
        if (!['model', 'effort', 'serviceTier'].includes(memberName(node))) return;
        if (['dispatchSummary', 'task'].includes(memberName(unwrap(node.object))) && inRenderedExpression(node)) report(node);
      },
    })),
    'shared-layout': rule('shared-layout', 'Replace inline layout property "{{property}}" with Tailwind utilities or a shared shell (EntityRow, EntityCard, FormSection, SettingRow, SectionHeader or ActionGroup). Geometry styles (top/left/width/height/transform) remain allowed.', report => ({
      JSXAttribute(node) {
        if (node.name.name !== 'style' || node.value?.type !== 'JSXExpressionContainer') return;
        function inspect(expression) {
          const object = unwrap(expression);
          if (object?.type !== 'ObjectExpression') return;
          for (const prop of object.properties) {
            if (prop.type === 'SpreadElement') { inspect(prop.argument); continue; }
            const name = prop.computed && prop.key.type !== 'Literal' ? undefined : propertyName(prop.key);
            if (name && layoutProperty.test(name)) report(prop, { property: name });
          }
        }
        inspect(node.value.expression);
      },
    })),
  } };
}

// Dedicated CSS is a closed brand boundary, never a feature/shared-layout escape.
export const brandStylesheets = new Map([
  ['ui/brand/topology.css', /\.(?:connection-(?:core|action|switch-track|knob|graph)|core-toggle|graph-(?:node|node-name|error|wires)|sources|source-(?:icon|brand)|agent-brand|status-hint|topology-(?!tuner|parameter|section|import|custom)[\w-]+|portrait-(?:wires|rail|task)|hub-[\w-]+|activity-slot|agent-auto-compact|agent-task-count|activity-flow)\b/],
  ['ui/brand/task-bubbles.css', /\.(?:activity-(?:bubble[\w-]*|mark-read|source-badge|preview|edge-fade)|update-blocking-tag|phase-[\w-]+|step-trail)\b|^\[data-phase=/],
  ['ui/brand/quota.css', /\.(?:agent-quota-icon|quota-[\w-]+|activity-arc|dual-quota)\b/],
  ['ui/components/composites/AgentQuotaIcon.css', /\.(?:agent-quota-icon|dual-quota|topology-node)\b/],
]);
export function isBrandSelector(file, selector) {
  return !!brandStylesheets.get(file)?.test(selector) && !/\.(?:topology-(?:tuner|parameter|section|import|custom)|dialog|activity-panel|workspace|settings)[\w-]*(?![\w-])/.test(selector);
}

export function isFoundationSelector(selector) {
  return /^(?::root(?:\[[^\]]+\]|:not\(\[[^\]]+\]\))*|(?:html|body|button|input|textarea|a|h[123]|p|pre|code)(?::disabled)?|\[tabindex\]|:focus-visible|\*(?:::(?:before|after))?|:root\[data-reduced-motion="true"\] \*(?:::(?:before|after))?)$/.test(selector);
}
