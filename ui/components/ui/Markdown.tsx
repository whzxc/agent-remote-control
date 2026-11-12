import { Fragment, type ReactNode } from "react";

// Render the supported Markdown subset as React nodes; raw HTML stays text.
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g).map((part, i) =>
    part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> :
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> :
    part.startsWith('*') && part.endsWith('*') ? <em key={i}>{part.slice(1, -1)}</em> : part);
}
export function Markdown({ children }: { children: string }) {
  const lines = children.split(/\r?\n/), blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!, fence = line.match(/^\s*(```|~~~)(.*)$/);
    if (fence) {
      const code: string[] = []; i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) code.push(lines[i++]!);
      i++; blocks.push(<pre key={i}><code>{code.join('\n')}</code></pre>); continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const Tag = `h${heading[1]!.length}` as 'h1';
      blocks.push(<Tag key={i}>{inline(heading[2]!)}</Tag>); i++; continue;
    }
    const list = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
    if (list) {
      const ordered = /^\d/.test(list[1]!), items: ReactNode[] = [];
      while (i < lines.length) {
        const item = lines[i]!.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        if (!item || /^\d/.test(item[1]!) !== ordered) break;
        items.push(<li key={i}>{inline(item[2]!)}</li>); i++;
      }
      blocks.push(ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>); continue;
    }
    if (line.trim()) blocks.push(<p key={i}>{inline(line)}</p>);
    i++;
  }
  return <div className="markdown">{blocks.map((block, i) => <Fragment key={i}>{block}</Fragment>)}</div>;
}
