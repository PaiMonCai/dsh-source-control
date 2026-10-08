/**
 * Convert a configured GitHub fetch remote into SAFE browser navigation URLs.
 *
 * Never return the raw remote URL: it may contain HTTPS credentials, custom
 * transports, or Git-specific URL rewrites. No network calls or Git mutations.
 * Only official github.com over HTTPS or SSH is supported for now.
 */
export function githubRemote(raw) {
  if (typeof raw !== 'string' || raw.length > 2048 || raw.trim() !== raw) return null;
  let path;
  if (/^git@github\.com:/i.test(raw)) {
    path = raw.slice(raw.indexOf(':') + 1);
  } else {
    let url;
    try { url = new URL(raw); } catch { return null; }
    if (url.hostname !== 'github.com' || url.port || url.password || url.search || url.hash) return null;
    if (url.protocol === 'https:') {
      if (url.username) return null;
    } else if (url.protocol === 'ssh:') {
      if (url.username !== 'git') return null;
    } else return null;
    path = url.pathname.startsWith('/') ? url.pathname.slice(1) : '';
  }
  if (!path || /[\\%?#\s\u0000-\u001f\u007f]/u.test(path)) return null;
  const components = path.replace(/\.git$/i, '').split('/');
  if (components.length !== 2 || components.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) return null;
  const [owner, name] = components;
  const url = `https://github.com/${owner}/${name}`;
  return { url, pullsUrl: `${url}/pulls`, issuesUrl: `${url}/issues` };
}
