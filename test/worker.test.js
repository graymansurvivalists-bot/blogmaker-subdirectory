import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const bindings = { BLOGMAKER_ORIGIN: 'https://sample.bmaker.app', BLOG_URL: 'https://example.com/blog' };
function runtime(overrides = {}) {
  const fixture = { requests: [], reply: () => { throw new Error('Unexpected outbound fetch'); } };
  fixture.worker = new Miniflare({
    ...convertV4MiniflareOptions({
      modules: true,
      scriptPath: fileURLToPath(new URL('../src/index.js', import.meta.url)),
      compatibilityDate: '2026-09-01',
      bindings: { ...bindings, ...overrides },
      cf: false,
      outboundService: async request => {
        fixture.requests.push({ url: request.url, method: request.method, headers: request.headers, body: await request.text() });
        return fixture.reply();
      },
    }),
    telemetry: { enabled: false },
  });
  return fixture;
}

test('configured Worker proxies only the blog and preserves existing site behavior', async t => {
  const fixture = runtime();
  t.after(() => fixture.worker.dispose());
  const send = (path, options) => fixture.worker.dispatchFetch('https://example.com' + path, options);

  await t.test('blog root and query strings reach the Blogmaker origin', async () => {
    fixture.reply = () => new Response('home');
    assert.equal(await (await send('/blog?category=updates')).text(), 'home');
    assert.equal(fixture.requests.at(-1).url, 'https://sample.bmaker.app/?category=updates');
  });

  await t.test('similar prefixes and main-site paths pass through untouched', async () => {
    fixture.reply = () => new Response('main site');
    for (const path of ['/blogger', '/blog-post', '/', '/pricing']) {
      assert.equal(await (await send(path)).text(), 'main site');
      assert.equal(fixture.requests.at(-1).url, 'https://example.com' + path);
    }
  });

  await t.test('trailing slash redirect preserves query without an origin request', async () => {
    const count = fixture.requests.length;
    const response = await send('/blog/?page=2', { redirect: 'manual' });
    assert.equal(response.status, 301);
    assert.equal(response.headers.get('Location'), 'https://example.com/blog?page=2');
    assert.equal(fixture.requests.length, count);
  });

  await t.test('reader POST bodies, cookies, content type and query are preserved', async () => {
    fixture.reply = () => new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'reader=test; Path=/; Secure' } });
    const response = await send('/blog/internal/function?form=subscribe', {
      method: 'POST', body: 'email=reader%40example.com',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'reader=test' },
    });
    const request = fixture.requests.at(-1);
    assert.equal(request.url, 'https://sample.bmaker.app/internal/function?form=subscribe');
    assert.equal(request.method, 'POST');
    assert.equal(request.body, 'email=reader%40example.com');
    assert.equal(request.headers.get('Content-Type'), 'application/x-www-form-urlencoded');
    assert.equal(request.headers.get('Cookie'), 'reader=test');
    assert.equal(await response.text(), '{"ok":true}');
    assert.match(response.headers.get('Set-Cookie'), /reader=test/);
  });

  await t.test('POST requests with trailing slash are not converted to GET redirects', async () => {
    fixture.reply = () => new Response('saved');
    assert.equal((await send('/blog/internal/function/', { method: 'POST', body: 'payload' })).status, 200);
    assert.equal(fixture.requests.at(-1).method, 'POST');
    assert.equal(fixture.requests.at(-1).url, 'https://sample.bmaker.app/internal/function/');
  });

  await t.test('HTML rewriting preserves external and already-prefixed references', async () => {
    fixture.reply = () => new Response([
      '<a href="/post?x=1#section">Post</a>',
      '<img src="https://sample.bmaker.app/image.png">',
      '<form action="/internal/function"></form>',
      '<a href="/blog/already">Already public</a>',
      '<img src="//cdn.example.com/image.png">',
      '<a href="https://outside.example/page">External</a>',
      '<a href="#section">Fragment</a><a href="mailto:hello@example.com">Email</a>',
      '<a href="https://[broken">Malformed</a>',
    ].join(''), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    const html = await (await send('/blog/post')).text();
    for (const expected of ['href="/blog/post?x=1#section"', 'src="/blog/image.png"', 'action="/blog/internal/function"', 'href="/blog/already"', 'src="//cdn.example.com/image.png"', 'href="https://outside.example/page"', 'href="#section"', 'href="mailto:hello@example.com"', 'href="https://[broken"']) assert.ok(html.includes(expected), expected);
    assert.ok(!html.includes('/blog/blog/'));
  });

  await t.test('same-origin redirects stay on the public path without being followed', async () => {
    for (const location of ['/new?x=1#part', 'https://sample.bmaker.app/new?x=1#part', 'new?x=1#part']) {
      const count = fixture.requests.length;
      fixture.reply = () => new Response(null, { status: 302, headers: { Location: location } });
      const response = await send('/blog/old', { redirect: 'manual' });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('Location'), 'https://example.com/blog/new?x=1#part');
      assert.equal(fixture.requests.length, count + 1);
    }
  });

  await t.test('external redirects are returned without a fetch to the external host', async () => {
    const count = fixture.requests.length;
    fixture.reply = () => new Response(null, { status: 307, headers: { Location: 'https://external.example/login' } });
    const response = await send('/blog/login', { redirect: 'manual' });
    assert.equal(response.headers.get('Location'), 'https://external.example/login');
    assert.equal(fixture.requests.length, count + 1);
  });

  await t.test('binary responses are not passed through HTMLRewriter', async () => {
    const bytes = new Uint8Array([0, 255, 23, 60, 62]);
    fixture.reply = () => new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
    const response = await send('/blog/image.png');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  });

  await t.test('preview and mismatched hostnames never proxy another website', async () => {
    const count = fixture.requests.length;
    const response = await fixture.worker.dispatchFetch('https://unrelated.example/blog');
    assert.equal(response.status, 404);
    assert.equal(fixture.requests.length, count);
  });
});

test('nested paths and legacy Blogmaker hosts work', async t => {
  const fixture = runtime({ BLOGMAKER_ORIGIN: 'https://sample.bstatic.io', BLOG_URL: 'https://www.example.com/news/blog' });
  t.after(() => fixture.worker.dispose());
  fixture.reply = () => new Response('post');
  assert.equal(await (await fixture.worker.dispatchFetch('https://www.example.com/news/blog/post?x=1')).text(), 'post');
  assert.equal(fixture.requests.at(-1).url, 'https://sample.bstatic.io/post?x=1');
});

test('an existing custom subdomain can also host its public subdirectory', async t => {
  const fixture = runtime({ BLOGMAKER_ORIGIN: 'https://news.example.com', BLOG_URL: 'https://news.example.com/archive' });
  t.after(() => fixture.worker.dispose());
  fixture.reply = () => new Response(null, { status: 302, headers: { Location: 'https://news.example.com/archive/next' } });
  const response = await fixture.worker.dispatchFetch('https://news.example.com/archive/start', { redirect: 'manual' });
  assert.equal(fixture.requests.at(-1).url, 'https://news.example.com/start');
  assert.equal(response.headers.get('Location'), 'https://news.example.com/archive/next');
});

test('an existing custom subdomain can serve a different public hostname and path', async t => {
  const fixture = runtime({ BLOGMAKER_ORIGIN: 'https://news.example.com', BLOG_URL: 'https://www.new-example.net/archive' });
  t.after(() => fixture.worker.dispose());
  fixture.reply = () => new Response('post');
  const response = await fixture.worker.dispatchFetch('https://www.new-example.net/archive/post');
  assert.equal(await response.text(), 'post');
  assert.equal(fixture.requests.at(-1).url, 'https://news.example.com/post');
});

test('invalid configuration fails closed without any outbound requests', async t => {
  for (const overrides of [
    { BLOGMAKER_ORIGIN: '', BLOG_URL: '' },
    { BLOGMAKER_ORIGIN: 'https://169.254.169.254' },
    { BLOGMAKER_ORIGIN: 'https://localhost' },
    { BLOGMAKER_ORIGIN: 'https://user:password@sample.bmaker.app' },
    { BLOGMAKER_ORIGIN: 'https://same.bmaker.app', BLOG_URL: 'https://same.bmaker.app/blog' },
    { BLOG_URL: 'https://example.com/' },
    { BLOG_URL: 'https://example.com/blog?query=1' },
  ]) {
    await t.test(JSON.stringify(overrides), async () => {
      const fixture = runtime(overrides);
      try {
        assert.equal((await fixture.worker.dispatchFetch('https://example.com/blog')).status, 503);
        assert.equal(fixture.requests.length, 0);
      } finally { await fixture.worker.dispose(); }
    });
  }
});
