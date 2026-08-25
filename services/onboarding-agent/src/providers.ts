export type Provider = 'github' | 'gitlab';

export interface ParsedRepo {
  provider: Provider;
  host: string;
  /** owner/repo, or group/subgroup/project on GitLab. */
  path: string;
  /** Normalised https URL, no credentials, no trailing .git. */
  url: string;
}

/**
 * Hostnames that must never be cloned from.
 *
 * Self-hosted GitLab means accepting arbitrary hosts, which turns this endpoint
 * into a request forger: anyone who can POST a job could aim it at the
 * platform's own backends or at cloud metadata. The runner is off the `obs`
 * network, but that is one control, and it should not be the only one.
 */
const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal|169\.254\.\d+\.\d+|metadata\.google\.internal)$/i;
const BLOCKED_IP =
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|::1$|fc|fd)/i;

export interface ParseOptions {
  /** Extra hosts to treat as GitLab, for self-hosted instances. */
  gitlabHosts?: string[];
  /** Explicit override when the host is not recognisable. */
  provider?: string;
  /**
   * Hosts to refuse outright, on top of the loopback/private rules.
   *
   * The server passes its own platform addresses here. Those are ordinary
   * public IPs — 20.x is Azure space, not RFC1918 — so the private-range check
   * does not cover them, and a caller who states `provider` explicitly could
   * otherwise aim a job at the platform itself.
   */
  blockedHosts?: string[];
}

export type ParseResult = { ok: true; repo: ParsedRepo } | { ok: false; error: string };

export function parseRepoUrl(raw: string, opts: ParseOptions = {}): ParseResult {
  const input = raw.trim();
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, error: 'repoUrl must be a full https URL, e.g. https://gitlab.com/acme/orders' };
  }

  if (u.protocol !== 'https:') {
    return { ok: false, error: 'repoUrl must use https' };
  }
  // Credentials in the URL would end up in logs and job records; tokens belong
  // in the gitToken field, which is never persisted.
  if (u.username || u.password) {
    return { ok: false, error: 'do not put credentials in repoUrl — use the gitToken field' };
  }

  const host = u.hostname.toLowerCase();
  if (BLOCKED_HOST.test(host) || BLOCKED_IP.test(host)) {
    return { ok: false, error: `refusing to clone from ${host}: internal and loopback addresses are blocked` };
  }
  if ((opts.blockedHosts ?? []).some((h) => h.toLowerCase() === host)) {
    return { ok: false, error: `refusing to clone from ${host}: that is this platform's own address` };
  }

  const path = u.pathname.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  // GitHub is owner/repo; GitLab allows nested subgroups, so only a floor.
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(path)) {
    return { ok: false, error: 'repoUrl must include a project path, e.g. https://gitlab.com/group/project' };
  }

  const gitlabHosts = new Set(['gitlab.com', ...(opts.gitlabHosts ?? []).map((h) => h.toLowerCase())]);
  let provider: Provider;
  if (opts.provider === 'github' || opts.provider === 'gitlab') {
    provider = opts.provider;
  } else if (host === 'github.com') {
    provider = 'github';
  } else if (gitlabHosts.has(host)) {
    provider = 'gitlab';
  } else {
    return {
      ok: false,
      error:
        `cannot tell which provider ${host} is. Pass "provider":"gitlab" (or "github"), ` +
        'or add the host to ONBOARD_GITLAB_HOSTS on the server.',
    };
  }

  return { ok: true, repo: { provider, host, path, url: `https://${host}/${path}` } };
}

/** What a merge request is called, so messages read naturally per provider. */
export function requestNoun(p: Provider): string {
  return p === 'gitlab' ? 'merge request' : 'pull request';
}
