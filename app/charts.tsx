'use client';

// Hand-drawn SVG exhibits. The app ships no chart library on purpose: these are
// small, deterministic and styled to match the exhibits in Koller, Goedhart &
// Wessels' Valuation — a value-driver tree, a value build-up, an
// enterprise-to-equity waterfall, an economic-profit column chart, a ROIC vs
// WACC spread chart and a football-field range.

import { ForecastYear, LineItem } from '@/lib/types';
import { C, fmtPct, money } from './format';

const ok = (n: number) => Number.isFinite(n);

/** Split a label into short lines so it fits under a column. */
function wrap(text: string, max = 16): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > max && line) {
      lines.push(line);
      line = w;
    } else {
      line = (line + ' ' + w).trim();
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Football field: where the fair value sits against the market price.
// ---------------------------------------------------------------------------

export function RangeBar({
  bands,
  fairValue,
  marketPrice,
  currency,
}: {
  bands: { label: string; low: number; high: number; color: string }[];
  fairValue: number;
  marketPrice: number;
  currency: string;
}) {
  const live = bands.filter((b) => ok(b.low) && ok(b.high) && b.high > b.low);
  const values = [fairValue, marketPrice, ...live.flatMap((b) => [b.low, b.high])].filter(ok);
  if (values.length === 0) return null;

  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const pad = Math.max((rawMax - rawMin) * 0.18, rawMax * 0.05, 1e-6);
  const min = Math.max(0, rawMin - pad);
  const max = rawMax + pad;
  const W = 720;
  // The band labels are right-anchored at `left - 10` and run leftwards, so the
  // gutter has to fit the longest of them or the start of the text falls off the
  // viewBox and is silently clipped -- which is what turned "Cost of equity /
  // growth range" into "f equity / growth range". 6.1px per character is the
  // rough advance width of the 11px UI sans at these sizes.
  const labelWidth = live.reduce((n, b) => Math.max(n, b.label.length), 0) * 6.1;
  const left = Math.max(132, Math.round(labelWidth) + 18);
  const right = 24;
  const rowH = 34;
  const top = 16;
  const H = top + live.length * rowH + 62;
  const x = (v: number) => left + ((v - min) / (max - min)) * (W - left - right);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Valuation range versus market price">
      {live.map((b, i) => {
        const y = top + i * rowH;
        return (
          <g key={b.label}>
            <text x={left - 10} y={y + 15} textAnchor="end" fontSize={11} fill={C.slate}>
              {b.label}
            </text>
            <rect x={x(b.low)} y={y + 3} width={Math.max(x(b.high) - x(b.low), 2)} height={18} rx={9} fill={b.color} />
            <text x={x(b.low) - 6} y={y + 16} textAnchor="end" fontSize={10} fill={C.neutral}>
              {money(b.low, currency, false)}
            </text>
            <text x={x(b.high) + 6} y={y + 16} fontSize={10} fill={C.neutral}>
              {money(b.high, currency, false)}
            </text>
          </g>
        );
      })}

      {/* Market price: the reference the whole page is arguing with. */}
      {ok(marketPrice) && (
        <g>
          <line x1={x(marketPrice)} y1={top - 8} x2={x(marketPrice)} y2={top + live.length * rowH + 8} stroke={C.ink} strokeWidth={2} />
          <text x={x(marketPrice)} y={top + live.length * rowH + 26} textAnchor="middle" fontSize={11} fill={C.ink} fontWeight={600}>
            Market {money(marketPrice, currency, false)}
          </text>
        </g>
      )}

      {/* DCF point estimate. */}
      {ok(fairValue) && (
        <g>
          <polygon
            points={`${x(fairValue)},${top - 12} ${x(fairValue) + 7},${top - 3} ${x(fairValue)},${top + 6} ${x(fairValue) - 7},${top - 3}`}
            fill={C.accent}
          />
          <text x={x(fairValue)} y={top + live.length * rowH + 44} textAnchor="middle" fontSize={11} fill={C.accent} fontWeight={600}>
            DCF {money(fairValue, currency, false)}
          </text>
        </g>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Value driver tree (Koller Ch. 2/8): what the fair value is actually made of.
// ---------------------------------------------------------------------------

export function ValueDriverTree({
  growth,
  ronic,
  wacc,
  roic,
  reinvestmentRate,
  enterpriseValue,
  equityValue,
  fairValuePerShare,
  currency,
}: {
  growth: number;
  ronic: number;
  wacc: number;
  roic: number;
  reinvestmentRate: number;
  enterpriseValue: number;
  equityValue: number;
  fairValuePerShare: number;
  currency: string;
}) {
  const W = 860;
  const H = 236;
  const creates = roic >= wacc;

  const driver = (x: number, y: number, label: string, value: string, tint: string, stroke: string) => (
    <g>
      <rect x={x} y={y} width={168} height={52} rx={10} fill={tint} stroke={stroke} />
      <text x={x + 14} y={y + 21} fontSize={11} fill={C.slate}>
        {label}
      </text>
      <text x={x + 14} y={y + 40} fontSize={17} fontWeight={700} fill={C.ink}>
        {value}
      </text>
    </g>
  );

  const arrow = (x1: number, y1: number, x2: number, y2: number) => (
    <path
      d={`M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`}
      stroke={C.line}
      strokeWidth={2}
      fill="none"
      markerEnd="url(#vdt-arrow)"
    />
  );

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Value driver tree">
      <defs>
        <marker id="vdt-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={C.line} />
        </marker>
      </defs>

      {driver(8, 12, 'Revenue growth', fmtPct(growth), '#f8fafc', C.line)}
      {driver(8, 92, 'Return on new capital', fmtPct(ronic), '#f8fafc', C.line)}
      {driver(8, 172, 'Cost of capital', fmtPct(wacc), '#f8fafc', C.line)}

      {arrow(176, 38, 236, 92)}
      {arrow(176, 118, 236, 118)}
      {arrow(176, 198, 236, 144)}

      <g>
        <rect x={240} y={78} width={186} height={80} rx={10} fill={C.accentSoft} stroke={C.accent} />
        <text x={254} y={100} fontSize={11} fill={C.accent}>
          Free cash flow engine
        </text>
        <text x={254} y={122} fontSize={12} fill={C.ink}>
          Reinvest {fmtPct(reinvestmentRate)} of NOPAT
        </text>
        <text x={254} y={142} fontSize={12} fill={creates ? C.positive : C.negative} fontWeight={600}>
          ROIC {fmtPct(roic)} {creates ? '>' : '<'} WACC {fmtPct(wacc)}
        </text>
      </g>

      {arrow(430, 118, 476, 118)}
      {driver(480, 92, 'Enterprise value', money(enterpriseValue, currency), '#f8fafc', C.line)}
      {arrow(652, 118, 692, 118)}
      {driver(688, 60, 'Equity value', money(equityValue, currency), '#f8fafc', C.line)}
      {driver(688, 140, 'Fair value / share', money(fairValuePerShare, currency, false), C.accentSoft, C.accent)}

      <text x={8} y={H - 6} fontSize={10} fill={C.neutral}>
        {creates
          ? 'Growth creates value because the return on new capital clears the cost of capital.'
          : 'Growth destroys value: the return on new capital sits below the cost of capital.'}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Value build-up: how much of the enterprise value is the continuing value.
// ---------------------------------------------------------------------------

export function ValueBuildBar({
  pvExplicit,
  pvContinuing,
  currency,
}: {
  pvExplicit: number;
  pvContinuing: number;
  currency: string;
}) {
  const total = pvExplicit + pvContinuing;
  if (!ok(total) || total <= 0) return null;
  const share = pvExplicit / total;
  return (
    <div>
      <div className="flex h-9 w-full overflow-hidden rounded-lg">
        <div className="flex items-center justify-center bg-accent text-[11px] font-medium text-white" style={{ width: `${share * 100}%` }}>
          {share > 0.14 ? fmtPct(share, 0) : ''}
        </div>
        <div
          className="flex items-center justify-center bg-slate-300 text-[11px] font-medium text-slate-700"
          style={{ width: `${(1 - share) * 100}%` }}
        >
          {1 - share > 0.14 ? fmtPct(1 - share, 0) : ''}
        </div>
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-slate-500">
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-accent align-middle" />
          Forecast years {money(pvExplicit, currency)}
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-slate-300 align-middle" />
          Continuing value {money(pvContinuing, currency)}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Enterprise-to-equity waterfall (Koller Ch. 14).
// ---------------------------------------------------------------------------

export function Waterfall({ rows, currency }: { rows: LineItem[]; currency: string }) {
  if (rows.length < 2) return null;
  const steps = rows.map((r, i) => ({ ...r, kind: i === 0 ? 'base' : i === rows.length - 1 ? 'total' : 'delta' }));

  // Running total so each delta bar floats where it belongs.
  let running = 0;
  const bars = steps.map((s) => {
    if (s.kind === 'base') {
      running = s.value;
      return { ...s, from: 0, to: s.value };
    }
    if (s.kind === 'total') return { ...s, from: 0, to: s.value };
    const from = running;
    running += s.value;
    return { ...s, from, to: running };
  });

  const values = bars.flatMap((b) => [b.from, b.to]).filter(ok);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  if (!ok(max) || max === min) return null;

  const W = 860;
  const plotTop = 24;
  const plotH = 190;
  const labelH = 58;
  const H = plotTop + plotH + labelH;
  const slot = W / bars.length;
  const barW = Math.min(slot * 0.56, 74);
  const y = (v: number) => plotTop + plotH - ((v - min) / (max - min)) * plotH;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Enterprise value to equity value bridge">
      <line x1={0} y1={y(0)} x2={W} y2={y(0)} stroke={C.line} />
      {bars.map((b, i) => {
        const cx = i * slot + slot / 2;
        const top = y(Math.max(b.from, b.to));
        const height = Math.max(Math.abs(y(b.to) - y(b.from)), 2);
        const fill = b.kind === 'delta' ? (b.value >= 0 ? C.positive : C.negative) : C.ink;
        return (
          <g key={b.label}>
            {i > 0 && b.kind === 'delta' && (
              <line x1={(i - 1) * slot + slot / 2 + barW / 2} y1={y(b.from)} x2={cx - barW / 2} y2={y(b.from)} stroke={C.line} strokeDasharray="3 3" />
            )}
            <rect x={cx - barW / 2} y={top} width={barW} height={height} rx={3} fill={fill} opacity={b.kind === 'delta' ? 0.85 : 1} />
            <text x={cx} y={top - 6} textAnchor="middle" fontSize={10.5} fontWeight={600} fill={C.ink}>
              {money(b.value, currency)}
            </text>
            {wrap(b.label, 15).map((line, li) => (
              <text
                key={line + li}
                x={cx}
                y={plotTop + plotH + 18 + li * 12}
                textAnchor="middle"
                fontSize={10}
                fill={b.kind === 'delta' ? C.slate : C.ink}
                fontWeight={b.kind === 'delta' ? 400 : 600}
              >
                {line}
              </text>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Economic profit columns (Koller Ch. 8/10).
// ---------------------------------------------------------------------------

export function EconomicProfitChart({ forecast, currency }: { forecast: ForecastYear[]; currency: string }) {
  const vals = forecast.map((f) => f.economicProfit).filter(ok);
  if (vals.length === 0) return null;
  const max = Math.max(...vals, 0);
  const min = Math.min(...vals, 0);
  const span = max - min || Math.abs(max) || 1;

  const W = 860;
  const H = 190;
  const padTop = 18;
  const padBottom = 26;
  const plotH = H - padTop - padBottom;
  const slot = W / forecast.length;
  const barW = Math.min(slot * 0.5, 40);
  const y = (v: number) => padTop + plotH - ((v - min) / span) * plotH;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Economic profit by forecast year">
      <line x1={0} y1={y(0)} x2={W} y2={y(0)} stroke={C.line} />
      {forecast.map((f, i) => {
        const cx = i * slot + slot / 2;
        const top = Math.min(y(f.economicProfit), y(0));
        const height = Math.max(Math.abs(y(f.economicProfit) - y(0)), 1.5);
        const positive = f.economicProfit >= 0;
        return (
          <g key={f.year}>
            <rect x={cx - barW / 2} y={top} width={barW} height={height} rx={2} fill={positive ? C.positive : C.negative} opacity={0.85} />
            <text x={cx} y={positive ? top - 5 : top + height + 11} textAnchor="middle" fontSize={9.5} fill={C.slate}>
              {money(f.economicProfit, currency)}
            </text>
            <text x={cx} y={H - 8} textAnchor="middle" fontSize={10} fill={C.neutral}>
              {f.year}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// ROIC versus WACC (Koller Ch. 10): the spread is the whole argument.
// ---------------------------------------------------------------------------

export function RoicVsWaccChart({ forecast, wacc }: { forecast: ForecastYear[]; wacc: number }) {
  const points = forecast.filter((f) => ok(f.roic));
  if (points.length < 2 || !ok(wacc)) return null;

  const values = [...points.map((p) => p.roic), wacc];
  const max = Math.max(...values) * 1.15;
  const min = Math.min(Math.min(...values) * 0.85, 0);
  const W = 860;
  const H = 170;
  const padTop = 16;
  const padBottom = 26;
  const padLeft = 44;
  const plotH = H - padTop - padBottom;
  const x = (i: number) => padLeft + (i / (points.length - 1)) * (W - padLeft - 16);
  const y = (v: number) => padTop + plotH - ((v - min) / (max - min || 1)) * plotH;

  const roicPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.roic)}`).join(' ');
  const areaPath = `${roicPath} L ${x(points.length - 1)} ${y(wacc)} L ${x(0)} ${y(wacc)} Z`;
  const creates = points[0].roic >= wacc;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="ROIC versus WACC across the forecast">
      <path d={areaPath} fill={creates ? C.positiveSoft : C.negativeSoft} opacity={0.7} />
      <line x1={padLeft} y1={y(wacc)} x2={W - 16} y2={y(wacc)} stroke={C.negative} strokeWidth={1.5} strokeDasharray="5 4" />
      <text x={padLeft - 6} y={y(wacc) + 3} textAnchor="end" fontSize={10} fill={C.negative}>
        {fmtPct(wacc)}
      </text>
      <path d={roicPath} stroke={C.accent} strokeWidth={2.5} fill="none" />
      {points.map((p, i) => (
        <g key={p.year}>
          <circle cx={x(i)} cy={y(p.roic)} r={3} fill={C.accent} />
          <text x={x(i)} y={H - 8} textAnchor="middle" fontSize={10} fill={C.neutral}>
            {p.year}
          </text>
        </g>
      ))}
      <text x={padLeft - 6} y={y(points[0].roic) + 3} textAnchor="end" fontSize={10} fill={C.accent}>
        {fmtPct(points[0].roic)}
      </text>
      <text x={W - 16} y={padTop - 4} textAnchor="end" fontSize={10} fill={C.slate}>
        ROIC (line) vs WACC (dashed)
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Data-quality mix.
// ---------------------------------------------------------------------------

export function ConfidenceBar({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total === 0) return null;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-100">
      {segments.map((s) => (
        <div key={s.label} title={`${s.label}: ${s.value}`} style={{ width: `${(s.value / total) * 100}%`, backgroundColor: s.color }} />
      ))}
    </div>
  );
}

/** Background for a sensitivity cell: distance from the market price, clamped. */
export function heatStyle(value: number, marketPrice: number): { backgroundColor: string; color: string } {
  if (!ok(value) || !ok(marketPrice) || marketPrice === 0) return { backgroundColor: 'transparent', color: C.neutral };
  const gap = Math.max(-1, Math.min(1, (value - marketPrice) / marketPrice));
  const intensity = Math.min(Math.abs(gap) / 0.5, 1);
  const [r, g, b] = gap >= 0 ? [4, 120, 87] : [185, 28, 28];
  return {
    backgroundColor: `rgba(${r}, ${g}, ${b}, ${0.06 + intensity * 0.28})`,
    color: intensity > 0.6 ? (gap >= 0 ? C.positive : C.negative) : C.ink,
  };
}
