// Routing Middleware: serve a Markdown version of a public page to agents that ask for it (Accept: text/markdown).
// It runs before the static files, which is the only way to answer "/" differently from public/index.html.
import { next } from '@vercel/functions';
import agentDocs from './lib/agentdocs.js';

export const config = {
  matcher: ['/', '/index.html', '/club.html', '/join.html', '/live.html', '/about.html', '/contact.html', '/terms.html', '/privacy.html'],
};

export default function middleware(request) {
  const accept = request.headers.get('accept') || '';
  if (/\btext\/markdown\b/.test(accept) && ['GET', 'HEAD'].includes(request.method)) {
    const url = new URL(request.url);
    const md = agentDocs.markdownFor(url.pathname, url.origin);
    if (md) {
      return new Response(request.method === 'HEAD' ? null : md, {
        headers: { 'Content-Type': 'text/markdown; charset=utf-8', Vary: 'Accept', 'Cache-Control': 'public, max-age=3600' },
      });
    }
  }
  return next();
}
