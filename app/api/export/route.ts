// Turns a completed valuation payload into the Koller-structured workbook.
// The client already holds the payload, so nothing is refetched or recomputed
// here — the download is exactly what is on screen.

import { buildValuationWorkbook, ValuationPayload, workbookFileName } from '@/lib/workbook';
import { buildEquityWorkbook, equityWorkbookFileName } from '@/lib/equityWorkbook';
import { EquityDcfResult } from '@/lib/equityDcf';
import { writeXlsx } from '@/lib/xlsx';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  let payload: ValuationPayload & { equityValuation?: EquityDcfResult | null };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return Response.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  if (!payload?.financials || !payload?.result || !payload?.assumptions) {
    return Response.json({ error: 'Run a valuation before exporting.' }, { status: 400 });
  }

  payload.reorganization = payload.reorganization ?? {
    investedCapitalBuild: [],
    nonoperatingAssetsBuild: [],
    debtEquivalentsBuild: [],
    adjustments: [],
  };
  payload.dataQuality = payload.dataQuality ?? [];

  // A bank gets an entirely different workbook, for the same reason it gets a
  // different page: the enterprise sheets would be exporting numbers the model
  // on screen never used.
  const eq = payload.equityValuation ?? null;
  const bytes = eq
    ? writeXlsx(
        buildEquityWorkbook({
          financials: payload.financials,
          assumptions: payload.assumptions,
          equityValuation: eq,
          dataQuality: payload.dataQuality,
        })
      )
    : writeXlsx(buildValuationWorkbook(payload));

  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${
        eq ? equityWorkbookFileName(payload.financials) : workbookFileName(payload.financials)
      }"`,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'no-store',
    },
  });
}
