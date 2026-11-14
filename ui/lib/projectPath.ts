const rootPattern = /^(?:[a-z]:\/|\/\/[^/]+\/[^/]+(?:\/|$)|\/\/|\/|~\/)/i;

// Paths are resolved lexically so the same display works for local and remote Agents.
function normalizePath(value: string) {
  const slash = value.replaceAll("\\", "/");
  const root = slash.match(rootPattern)?.[0] ?? "";
  const parts: string[] = [];
  for (const part of slash.slice(root.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !root) parts.push(part);
  }
  return root + parts.join("/");
}

export function projectLabelParts(name?: string | null, path?: string | null) {
  const recordedPath = path?.trim();
  const leaf = recordedPath && normalizePath(recordedPath).replace(/\/+$/, "").split("/").at(-1);
  const label = name?.trim() || leaf || recordedPath;
  return label ? { name: label, path: recordedPath || undefined } : undefined;
}

export function filePathParts(path: string, project?: string | null, cwd?: string | null) {
  const base = cwd || project;
  const absolute = rootPattern.test(path.replaceAll("\\", "/"));
  const fullPath = normalizePath(!absolute && base ? `${base}/${path}` : path) || path;
  const root = project ? normalizePath(project) : "";
  const prefix = root && (root.endsWith("/") ? root : `${root}/`);
  const windows = /^[a-z]:\//i.test(fullPath) || fullPath.startsWith("//");
  const inside = prefix && (windows ? fullPath.toLowerCase().startsWith(prefix.toLowerCase()) : fullPath.startsWith(prefix));
  const displayPath = inside ? fullPath.slice(prefix.length) : fullPath;
  const split = displayPath.lastIndexOf("/") + 1;
  return { fullPath, displayPath, directory: displayPath.slice(0, split), filename: displayPath.slice(split) };
}
