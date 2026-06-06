import { getAuthUrl } from '@/lib/gmail';
import { NextResponse } from 'next/server';

export async function GET() {
  const url = getAuthUrl();
  return NextResponse.redirect(url);
}
