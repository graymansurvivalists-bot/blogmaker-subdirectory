function configuration(env) {
  const origin = new URL(env.BLOGMAKER_ORIGIN);
  const blog = new URL(env.BLOG_URL);
  const isBlogmakerOrigin = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:bmaker\.app|bstatic\.io)$/.test(origin.hostname);
  const usesCustomSubdomainOrigin = !isBlogmakerOrigin && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(origin.hostname);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port ||
      origin.pathname !== '/' || origin.search || origin.hash ||
      (!isBlogmakerOrigin && !usesCustomSubdomainOrigin)) {
    throw new Error('Invalid Blogmaker origin');
  }
  const path = blog.pathname.replace(/\/+$/, '');
  if (blog.protocol !== 'https:' || blog.username || blog.password || blog.port || blog.search || blog.hash ||
      !path || path.includes('//') || (blog.hostname === origin.hostname && isBlogmakerOrigin)) {
    throw new Error('Invalid public blog URL');
  }
  return { origin, blog, path };
}

function isBlogPath(pathname, path) {
  return pathname === path || pathname.startsWith(path + '/');
}

function publicPath(pathname, path) {
  return path + (pathname === '/' ? '' : pathname);
}

function rewriteAttribute(value, config) {
  if (!value) return value;
  const { origin, path } = config;
  try {
    if (value.startsWith('/') && !value.startsWith('//')) {
      // Renderer output may already include the configured public subdirectory.
      const url = new URL(value, origin);
      return (isBlogPath(url.pathname, path) ? url.pathname : publicPath(url.pathname, path)) + url.search + url.hash;
    }
    if (/^(?:https?:)?\/\//i.test(value)) {
      const url = new URL(value, origin);
      if (url.origin === origin.origin) return publicPath(url.pathname, path) + url.search + url.hash;
    }
  } catch {
    // A malformed link in a post must not break the entire response.
    return value;
  }
  return value;
}

export default {
  async fetch(request, env) {
    let config;
    try {
      config = configuration(env);
    } catch {
      return new Response('Set BLOGMAKER_ORIGIN and BLOG_URL using the values in Blogmaker Settings → Domains and URLs → /subdirectory.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    const { origin, blog, path } = config;
    const incoming = new URL(request.url);
    if (incoming.hostname !== blog.hostname) {
      return new Response('Worker configured. Add the Cloudflare Worker routes shown in Blogmaker, then visit your saved blog URL.', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    // A route like example.com/blog* also matches /blogger: leave the main site alone.
    if (!isBlogPath(incoming.pathname, path)) return fetch(request);

    if (['GET', 'HEAD'].includes(request.method) && incoming.pathname.endsWith('/')) {
      incoming.pathname = incoming.pathname.replace(/\/+$/, '');
      return Response.redirect(incoming.toString(), 301);
    }

    const upstream = new URL(incoming);
    upstream.protocol = origin.protocol;
    upstream.host = origin.host;
    upstream.pathname = incoming.pathname.slice(path.length) || '/';
    // Preserve methods, form bodies, cookies, and content negotiation, including internal/* calls.
    const forwarded = new Request(upstream, request);
    forwarded.headers.delete('Host');
    const response = await fetch(forwarded, { redirect: 'manual' });

    const location = response.headers.get('Location');
    if (location) {
      const destination = new URL(location, upstream);
      if (destination.origin === origin.origin) {
        const redirected = new Response(response.body, response);
        const destinationPath = isBlogPath(destination.pathname, path) ? destination.pathname : publicPath(destination.pathname, path);
        redirected.headers.set('Location', blog.origin + destinationPath + destination.search + destination.hash);
        return redirected;
      }
      return response;
    }

    if (request.method === 'HEAD' || !(response.headers.get('Content-Type') || '').toLowerCase().includes('text/html')) return response;
    const rewriter = new HTMLRewriter();
    for (const attribute of ['href', 'src', 'action']) {
      rewriter.on(`[${attribute}]`, {
        element(element) {
          const value = element.getAttribute(attribute);
          const rewritten = rewriteAttribute(value, config);
          if (rewritten !== value) element.setAttribute(attribute, rewritten);
        },
      });
    }
    return rewriter.transform(response);
  },
};
