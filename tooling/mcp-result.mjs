// ARC control-source tools carry their result in a single JSON text block.
export function toolResult(response) {
  const text = response.content.find(block => block.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error('Invalid ARC tool result: expected JSON text content');
  return JSON.parse(text);
}
