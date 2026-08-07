import { ReactNode } from 'react';

export function Card({ title, subtitle, chapter, children }: { title: string; subtitle?: string; chapter?: string; children: ReactNode }) {
  return <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
    <div className="flex flex-wrap items-baseline justify-between gap-2 px-6 pb-3 pt-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {chapter && <span className="text-[11px] uppercase tracking-wide text-slate-400">{chapter}</span>}
    </div>
    {subtitle && <p className="px-6 pb-4 text-xs text-slate-500">{subtitle}</p>}
    <div className="px-6 pb-6">{children}</div>
  </section>;
}

export function Panel({ title, subtitle, chapter, badge, defaultOpen = false, children }: { title: string; subtitle?: string; chapter?: string; badge?: string; defaultOpen?: boolean; children: ReactNode }) {
  return <details open={defaultOpen} className="group rounded-xl border border-slate-200 bg-white shadow-sm">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-6 py-4">
      <div><h3 className="text-sm font-semibold">{title}{chapter && <span className="ml-2 text-[11px] font-normal uppercase tracking-wide text-slate-400">{chapter}</span>}</h3>{subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}</div>
      <div className="flex shrink-0 items-center gap-2">{badge && <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600">{badge}</span>}<span className="text-xs text-slate-400 group-open:hidden">Show</span><span className="hidden text-xs text-slate-400 group-open:inline">Hide</span></div>
    </summary>
    <div className="border-t border-slate-100 px-6 py-5">{children}</div>
  </details>;
}

export function Headline({ label, value, accent, tone }: { label: string; value: string; accent?: boolean; tone?: 'good' | 'bad' }) {
  const toneClass = tone === 'good' ? 'text-positive' : tone === 'bad' ? 'text-negative' : accent ? 'text-accent' : 'text-ink';
  return <div className="px-6 py-5"><div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div><div className={`mt-1 text-3xl font-semibold tracking-tight tabular-nums ${toneClass}`}>{value}</div></div>;
}

export function Tile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'good' | 'bad' | 'warn' }) {
  const border = tone === 'good' ? 'border-l-positive' : tone === 'bad' ? 'border-l-negative' : tone === 'warn' ? 'border-l-warn' : 'border-l-slate-300';
  return <div className={`rounded-xl border border-slate-200 border-l-4 bg-slate-50 px-4 py-3 ${border}`}><div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div><div className="mt-0.5 text-xl font-semibold tabular-nums">{value}</div><div className="text-[11px] text-slate-500">{sub}</div></div>;
}
