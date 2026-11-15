// Values may combine tokens with structural CSS syntax. A fallback must obey the same rule.
export function tokenPaint(value, property) {
  let text = value.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  for (let index = text.indexOf('var('); index >= 0; index = text.indexOf('var(')) {
    let depth = 1, end = index + 4;
    for (; end < text.length && depth; end++) { if (text[end] === '(') depth++; if (text[end] === ')') depth--; }
    if (depth) return false;
    const body = text.slice(index + 4, end - 1), comma = body.indexOf(',');
    const name = (comma < 0 ? body : body.slice(0, comma)).trim();
    if (!/^--[a-zA-Z0-9_-]+$/.test(name) || comma >= 0 && !tokenPaint(body.slice(comma + 1), property)) return false;
    text = text.slice(0, index) + ' TOKEN ' + text.slice(end);
  }
  if (/[#"']/.test(text) || /(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\s*\(/i.test(text)) return false;
  // Percentages in color-mix are blending weights, not authored colors or dimensions.
  const mix = /color-mix\s*\(/i.test(text);
  text = text.replace(/color-mix\s*\(\s*in\s+(?:srgb|oklab|oklch)\s*,/g, '(');
  if (mix) text = text.replace(/\b\d+(?:\.\d+)?%/g, '');


  return text.replace(/\b(?:TOKEN|inherit|currentColor|transparent|none|normal|solid|dashed|dotted|double|inset|outset|bold|bolder|lighter|italic|oblique|tabular-nums|lining-nums|proportional-nums|small-caps|uppercase|lowercase|capitalize|underline|line-through|overline|auto)\b/gi, '')
    .replace(/(?<![\w.])0(?![\w.])/g, '').replace(/[\s(),/+*-]/g, '') === '';
}

