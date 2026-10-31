// Copied from tvdavies/brwsr@0d22bf8 (container/agent/cookies.mjs) for Kantel's browser runtime
// (packages/browser/CONTRACT.md). Kantel changes: none.
// Cookie metadata for a saved context: which sites it's signed in to.
/**
 * Which sites a profile is signed in to, for the dashboard: per domain the
 * number of cookies and when the persistent ones expire. Never cookie names or
 * values. HttpOnly cookies are the ones sign-ins usually live in, so their
 * expiry is preferred when a domain has any.
 */
export function cookieDomains(cookies, limit = 300) {
  const by = new Map();
  for (const c of cookies) {
    const domain = String(c.domain || "").replace(/^\./, "").toLowerCase();
    if (!domain) continue;
    let d = by.get(domain);
    if (!d) by.set(domain, (d = { domain, cookies: 0, sessionCookies: 0, exp: [], expHttpOnly: [] }));
    d.cookies++;
    if (c.session || !(c.expires > 0)) d.sessionCookies++;
    else {
      d.exp.push(c.expires);
      if (c.httpOnly) d.expHttpOnly.push(c.expires);
    }
  }
  const iso = (s) => (s === undefined ? null : new Date(s * 1000).toISOString());
  return [...by.values()]
    .sort((a, b) => b.cookies - a.cookies || a.domain.localeCompare(b.domain))
    .slice(0, limit)
    .map((d) => {
      const exp = d.expHttpOnly.length ? d.expHttpOnly : d.exp;
      return {
        domain: d.domain,
        cookies: d.cookies,
        sessionCookies: d.sessionCookies,
        earliestExpiry: iso(exp.length ? Math.min(...exp) : undefined),
        latestExpiry: iso(exp.length ? Math.max(...exp) : undefined),
      };
    });
}
