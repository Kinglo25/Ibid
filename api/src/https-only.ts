/**
 * A fetch that follows redirects itself, and only over HTTPS.
 *
 * CELLAR answers a request for a document with a `303` to the document's own address, and that
 * address is plain `http://publications.europa.eu/resource/cellar/…`. Followed as given, every
 * judgment, opinion and act Ibid shows was downloaded unencrypted, so nothing stood between
 * the Publications Office and the reviewer's screen to say the text had not been altered on
 * the way — for a tool whose whole claim is that the passage shown is the official one. The
 * same address answers over HTTPS, so each hop is taken over HTTPS instead; a redirect to any
 * other scheme is not followed, and the redirect itself is returned for the caller to treat as
 * the failure it is.
 */
const MAX_REDIRECTS = 5;

export function httpsOnly(fetcher: typeof fetch): typeof fetch {
  return async (input, init = {}) => {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    for (let hop = 0; ; hop += 1) {
      const response = await fetcher(url, { ...init, redirect: 'manual' });
      if (response.status < 300 || response.status >= 400 || response.status === 304) return response;
      const location = response.headers.get('location');
      if (!location || hop >= MAX_REDIRECTS) return response;
      const next = new URL(location, url);
      if (next.protocol === 'http:') next.protocol = 'https:';
      if (next.protocol !== 'https:') return response;
      url = next.toString();
    }
  };
}
