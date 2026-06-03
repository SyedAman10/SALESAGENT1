import { NextResponse } from 'next/server';
import { getStats } from '@/lib/pipeline';

export async function GET() {
  return NextResponse.json(await getStats());
}
