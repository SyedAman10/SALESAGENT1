import { handleOAuthCallback } from '@/lib/gmail';
import { NextRequest, NextResponse } from 'next/server';
import { config } from '@/lib/config';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  if (!code) return NextResponse.redirect(`${config.baseUrl}/?gmail=error`);

  try {
    await handleOAuthCallback(code);
    return NextResponse.redirect(`${config.baseUrl}/?gmail=connected`);
  } catch (e) {
    console.error('Gmail OAuth callback error:', e);
    return NextResponse.redirect(`${config.baseUrl}/?gmail=error`);
  }
}
