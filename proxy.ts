import { NextRequest, NextResponse } from 'next/server';

// When a portfolio domain's DNS points at this app, serve its storefront at the
// root instead of the dashboard. The dashboard stays on the app's own host.
export function proxy(req: NextRequest) {
  const host = (req.headers.get('host') ?? '').toLowerCase().replace(/^www\./, '').split(':')[0];
  const appHost = (process.env.NEXT_PUBLIC_BASE_URL ?? '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .toLowerCase();

  const isAppHost = !host || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.vercel.app') || host === appHost;
  const { pathname } = req.nextUrl;

  if (isAppHost || pathname.startsWith('/api') || pathname.startsWith('/buy') || pathname.startsWith('/_next')
      || pathname === '/robots.txt' || pathname === '/sitemap.xml') {
    return NextResponse.next();
  }
  return NextResponse.rewrite(new URL(`/buy/${host}`, req.url));
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.svg).*)'],
};
