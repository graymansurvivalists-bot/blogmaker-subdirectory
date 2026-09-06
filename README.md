# Blogmaker subdirectory Worker

Serve a Blogmaker blog at a path such as `https://example.com/blog`, while leaving the rest of
the existing website with its current host.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/blogmaker-app/blogmaker-subdirectory-worker)

## Setup

1. In Blogmaker, open **Settings → Domains and URLs → /subdirectory** and save your full blog URL.
   Subdirectory hosting requires Blogmaker's Expert plan. The existing domain must use
   Cloudflare DNS, with its web records proxied. Keep its existing origin and email records.
2. Click **Deploy to Cloudflare**. Sign in to Cloudflare and connect GitHub or GitLab. The flow
   copies this template into your Git account; it does not require access to Blogmaker's code.
3. Enter the two values shown in Blogmaker's setup panel:

   | Variable | Example |
   | --- | --- |
   | `BLOGMAKER_ORIGIN` | `https://your-blog.bmaker.app`, or an existing custom subdomain such as `https://news.example.com` |
   | `BLOG_URL` | `https://example.com/blog` |

   If the deploy screen does not ask for these values, add them under the Worker's
   **Settings → Variables and Secrets** after deploying. Use plain-text variables, not API keys.
   If you edit `vars` in your copied repository, keep them consistent with the dashboard values.
   Deployments from Git use the repository's Wrangler configuration.
4. In the Worker, open **Settings → Domains & Routes → Add → Route**. Select your domain's zone,
   use **Fail open (proceed)**, and add both routes shown in Blogmaker, for example:

   ```text
   example.com/blog*
   example.com/blog/*
   ```

   Include `www` if it is part of the saved blog URL. Do not add a route for your entire site.
   Do not replace an existing Worker route without reviewing what it does.
5. Confirm the domain's SSL/TLS mode is **Full** and visit your saved blog URL. The `workers.dev`
   preview address only shows a setup message; the blog is served on its configured hostname.

The button deploys the Worker only. It does not change nameservers, DNS records, SSL settings,
or existing routes. No customer API credentials are needed. Blank/invalid configuration returns
a setup message without contacting an origin.

## Behavior

- Only the configured hostname and path are sent to the configured Blogmaker origin.
- Blogmaker origins are restricted to a single blog subdomain of `bmaker.app` or `bstatic.io`, or to the existing custom subdomain shown by Blogmaker.
- Other paths on the configured hostname pass through to the existing site.
- Query strings, methods, request bodies, and cookies are preserved.
- HTML links, images, and forms and same-origin redirects are rewritten to the public blog path.
- External URLs, binary assets, and JSON responses are left intact.
- The Worker does not cache personalized responses or follow upstream redirects automatically.

## Local checks

Use Node.js 22 or newer:

```sh
npm ci
npm test
npm run check
```

Tests run in a local Workers runtime with mocked outbound requests. `npm run check` bundles the
Worker with Wrangler's dry-run mode; neither command deploys or changes Cloudflare resources.

See [Cloudflare's deploy-button documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
for account prerequisites and how the import flow works.
