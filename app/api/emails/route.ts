import { NextRequest, NextResponse } from 'next/server';
import { getApprovedEmails, getSentEmails } from '@/lib/pipeline';

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get('status');
  if (status === 'sent') return NextResponse.json(await getSentEmails());
  return NextResponse.json(await getApprovedEmails());
}
