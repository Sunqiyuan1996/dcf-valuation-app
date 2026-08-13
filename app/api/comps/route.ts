import { NextRequest, NextResponse } from 'next/server';
import { analyzeComparables, ComparableCompany } from '@/lib/comps';

export const dynamic = 'force-dynamic';

/**
 * Analyze a caller-supplied, dated peer set. Live peer fetching remains a
 * separate source-integration task; this endpoint keeps the normalization and
 * disclosure rules testable without inventing peers.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { target?: ComparableCompany; peers?: ComparableCompany[] };
    if (!body.target || !Array.isArray(body.peers)) {
      return NextResponse.json({ error: 'target and peers are required' }, { status: 400 });
    }
    return NextResponse.json(analyzeComparables(body.target, body.peers));
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Invalid comparable-company request' }, { status: 400 });
  }
}
