export type ClipboardReplacement = { start: number; end: number; value: string };

// Positions identify selected stand-ins without changing matching ordinary text.
export function buildClipboardText(text: string, replacements: readonly ClipboardReplacement[]): string {
  let result = '', cursor = 0;
  for (const replacement of [...replacements].sort((a, b) => a.start - b.start)) {
    result += text.slice(cursor, replacement.start) + replacement.value;
    cursor = replacement.end;
  }
  return result + text.slice(cursor);
}

const values = new Map<HTMLElement, string>();

function selectedValue(value: string, prefix: string, selected: string) {
  const start = Array.from(prefix).length;
  return Array.from(value).slice(start, start + Array.from(selected).length).join('');
}

function onCopy(event: ClipboardEvent) {
  if (event.defaultPrevented || !event.clipboardData) return;
  const target = event.target;
  if (target instanceof HTMLInputElement && values.has(target)) {
    const start = target.selectionStart ?? 0, end = target.selectionEnd ?? start;
    if (start === end) return;
    event.clipboardData.setData('text/plain', selectedValue(values.get(target)!, target.value.slice(0, start), target.value.slice(start, end)));
    event.preventDefault();
    return;
  }
  const selection = (event.currentTarget as Document).getSelection();
  if (!selection || selection.isCollapsed) return;
  const text: string[] = [];
  let replaced = false;
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index), replacements: ClipboardReplacement[] = [];
    for (const [node, value] of values) {
      if (node instanceof HTMLInputElement || !range.intersectsNode(node)) continue;
      const contents = node.ownerDocument.createRange();
      contents.selectNodeContents(node);
      const intersection = range.cloneRange();
      if (range.compareBoundaryPoints(range.START_TO_START, contents) < 0) intersection.setStart(contents.startContainer, contents.startOffset);
      if (range.compareBoundaryPoints(range.END_TO_END, contents) > 0) intersection.setEnd(contents.endContainer, contents.endOffset);
      const selected = intersection.toString();
      if (!selected) continue;
      const before = range.cloneRange();
      before.setEnd(intersection.startContainer, intersection.startOffset);
      const prefix = contents.cloneRange();
      prefix.setEnd(intersection.startContainer, intersection.startOffset);
      const start = before.toString().length;
      replacements.push({ start, end: start + selected.length, value: selectedValue(value, prefix.toString(), selected) });
    }
    replaced ||= replacements.length > 0;
    text.push(buildClipboardText(range.toString(), replacements));
  }
  if (!replaced) return;
  event.clipboardData.setData('text/plain', text.join('\n'));
  event.preventDefault();
}

// Raw values stay in memory. One document handler also handles copies starting in ordinary text.
export function registerSensitiveCopy(node: HTMLElement, value: string) {
  if (!values.size) node.ownerDocument.addEventListener('copy', onCopy);
  values.set(node, value);
  return () => {
    values.delete(node);
    if (!values.size) node.ownerDocument.removeEventListener('copy', onCopy);
  };
}
