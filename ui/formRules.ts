export function validDomain(value: string): boolean {
  const domain=value.trim();
  return domain.length<=253 && domain.includes('.') && domain.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

// Connection origins use a hostname; pasted product URLs may include /mcp or query strings.
export function connectionDomain(value: string): string {
  const input = value.trim();
  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.hostname : input;
  } catch { return input; }
}
