import { useRef, useLayoutEffect, useState, useMemo } from 'react';
import { CashFlowEntry, LineItem } from '../services/api';
import TimelineScrubber from './TimelineScrubber';

interface ChartSeries {
  i: number;
  d: Date;
  balP: number;
  balM: number;
  bal: number;
  events: LineItem[];
}

interface ReadoutState {
  xPct: number;
  yPx: number;
  html: string;
}

const fmtAUD = (n: number) =>
  (n < 0 ? '−A$' : 'A$') + Math.abs(Math.round(n)).toLocaleString('en-AU');

const fmtMD = (d: Date) =>
  d.toLocaleDateString('en-AU', { month: 'short', day: '2-digit' });

const fmtLong = (d: Date) =>
  d.toLocaleDateString('en-AU', { month: 'short', day: '2-digit', year: 'numeric' });

function buildChartSVG(
  series: ChartSeries[],
  adjustedSeries: ChartSeries[] | null,
  scrubIndex: number,
  bucketFilter: string
): { svgHTML: string; readout: ReadoutState | null } {
  if (series.length < 2) return { svgHTML: '', readout: null };

  const W = 1000, H = 360;
  const pad = { l: 64, r: 18, t: 32, b: 34 };
  const xs = (i: number) => pad.l + (i / (series.length - 1)) * (W - pad.l - pad.r);

  const showSplit = bucketFilter === 'all';
  type SD = { color: string; label: string; getVal: (s: ChartSeries) => number };
  const seriesDefs: SD[] = showSplit
    ? [
        { color: '#1f4f7a', label: 'Personal', getVal: (s) => s.balP },
        { color: '#6b3fa0', label: 'Maple', getVal: (s) => s.balM },
      ]
    : bucketFilter === 'personal'
    ? [{ color: '#1f4f7a', label: 'Personal', getVal: (s) => s.balP }]
    : [{ color: '#6b3fa0', label: 'Maple', getVal: (s) => s.balM }];

  const allVals: number[] = [];
  for (const sd of seriesDefs) for (const s of series) allVals.push(sd.getVal(s));
  if (adjustedSeries) {
    for (const sd of seriesDefs) for (const s of adjustedSeries) allVals.push(sd.getVal(s));
  }
  const vMax = Math.max(...allVals) * 1.12;
  const vMin = Math.min(0, Math.min(...allVals) * 0.88);
  const ys = (v: number) => pad.t + (1 - (v - vMin) / (vMax - vMin)) * (H - pad.t - pad.b);

  let g = '';

  g += `<defs>
    <linearGradient id="area-p" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1f4f7a" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#1f4f7a" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="area-m" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#6b3fa0" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#6b3fa0" stop-opacity="0"/>
    </linearGradient>
  </defs>`;

  // horizontal grid + y-axis labels
  const steps = 4;
  for (let k = 0; k <= steps; k++) {
    const v = vMin + (vMax - vMin) * k / steps;
    const y = ys(v);
    g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" stroke="rgba(19,18,17,0.06)"/>`;
    g += `<text x="${pad.l - 10}" y="${y + 4}" font-size="10.5" fill="#8a8275" text-anchor="end" font-family="JetBrains Mono,monospace">A$${Math.round(v / 1000)}k</text>`;
  }
  if (vMin < 0) {
    g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${ys(0)}" y2="${ys(0)}" stroke="#c7442b" stroke-width="1" stroke-dasharray="3,3" opacity="0.4"/>`;
  }

  // month gridlines + labels
  let curMonth = -1;
  for (const s of series) {
    const m = s.d.getMonth();
    if (m !== curMonth) {
      curMonth = m;
      const x = xs(s.i);
      g += `<line x1="${x}" x2="${x}" y1="${pad.t}" y2="${H - pad.b}" stroke="rgba(19,18,17,0.05)"/>`;
      g += `<text x="${x + 5}" y="${H - 14}" font-size="10.5" fill="#8a8275" font-family="Inter,sans-serif" font-weight="500">${s.d.toLocaleDateString('en-AU', { month: 'short' })}</text>`;
    }
  }

  // area fills + dashed lines
  seriesDefs.forEach((sd, ix) => {
    const gradId = ix === 0 ? 'area-p' : 'area-m';
    let area = `M ${xs(0)} ${ys(sd.getVal(series[0]))} `;
    for (let i = 1; i < series.length; i++) area += `L ${xs(i)} ${ys(sd.getVal(series[i]))} `;
    area += `L ${xs(series.length - 1)} ${H - pad.b} L ${xs(0)} ${H - pad.b} Z`;
    g += `<path d="${area}" fill="url(#${gradId})"/>`;

    let line = `M ${xs(0)} ${ys(sd.getVal(series[0]))} `;
    for (let i = 1; i < series.length; i++) line += `L ${xs(i)} ${ys(sd.getVal(series[i]))} `;
    g += `<path d="${line}" fill="none" stroke="${sd.color}" stroke-width="2.2" stroke-dasharray="6,4" stroke-linecap="round" stroke-linejoin="round"/>`;

    // today anchor dot
    const y0 = ys(sd.getVal(series[0]));
    g += `<circle cx="${xs(0)}" cy="${y0}" r="5.5" fill="${sd.color}"/>`;
    g += `<circle cx="${xs(0)}" cy="${y0}" r="9" fill="none" stroke="${sd.color}" stroke-opacity="0.2" stroke-width="1"/>`;

    // end label
    const last = series[series.length - 1];
    g += `<text x="${xs(series.length - 1) - 6}" y="${ys(sd.getVal(last)) - 8}" font-size="10.5" fill="${sd.color}" font-family="Inter,sans-serif" font-weight="600" text-anchor="end">${sd.label}</text>`;
  });

  g += `<text x="${xs(0) + 14}" y="${pad.t + 12}" font-size="10.5" fill="#131211" font-family="Inter,sans-serif" font-weight="600">TODAY · actual ends</text>`;

  // "If paid today" — adjusted balance line(s)
  if (adjustedSeries && adjustedSeries.length === series.length) {
    const adjColor = '#c7442b';
    seriesDefs.forEach((sd) => {
      let line = `M ${xs(0)} ${ys(sd.getVal(adjustedSeries[0]))} `;
      for (let i = 1; i < adjustedSeries.length; i++) {
        line += `L ${xs(i)} ${ys(sd.getVal(adjustedSeries[i]))} `;
      }
      g += `<path d="${line}" fill="none" stroke="${adjColor}" stroke-width="1.8" stroke-dasharray="2,3" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>`;
    });
    g += `<text x="${xs(adjustedSeries.length - 1) - 6}" y="${ys(seriesDefs[0].getVal(adjustedSeries[adjustedSeries.length - 1])) + 16}" font-size="10.5" fill="${adjColor}" font-family="Inter,sans-serif" font-weight="600" text-anchor="end">if paid today</text>`;
  }

  // event ticks
  const showCC = bucketFilter === 'personal';
  for (const s of series) {
    for (const e of s.events) {
      const isStmt = e.isCC;
      if (isStmt && !showCC) continue;
      const up = e.type === 'income';
      let yVal: number;
      if (showSplit) yVal = e.bucket === 'maple' ? s.balM : s.balP;
      else yVal = seriesDefs[0].getVal(s);
      const x = xs(s.i), y = ys(yVal);
      const color = isStmt ? '#5b3b8a' : (up ? '#2e6a3a' : '#131211');
      const len = isStmt ? 14 : 10;
      g += `<line x1="${x}" x2="${x}" y1="${y}" y2="${y + (up ? -len : len)}" stroke="${color}" stroke-width="${isStmt ? 2 : 1.3}"/>`;
      const sym = isStmt ? '◆' : (up ? '▲' : '▼');
      g += `<text x="${x}" y="${y + (up ? -len - 4 : len + 11)}" font-size="10" text-anchor="middle" fill="${color}" font-family="Inter,sans-serif" font-weight="600">${sym}</text>`;
    }
  }

  // scrubber line + dots
  let readout: ReadoutState | null = null;
  const si = Math.max(0, Math.min(scrubIndex, series.length - 1));
  if (series[si]) {
    const x = xs(si);
    g += `<line x1="${x}" x2="${x}" y1="${pad.t - 8}" y2="${H - pad.b}" stroke="#c7442b" stroke-dasharray="4,4" stroke-width="1.5"/>`;

    let topY = Infinity;
    for (const sd of seriesDefs) {
      const yv = ys(sd.getVal(series[si]));
      g += `<circle cx="${x}" cy="${yv}" r="6.5" fill="#f3efe6" stroke="${sd.color}" stroke-width="2.5"/>`;
      g += `<circle cx="${x}" cy="${yv}" r="3" fill="${sd.color}"/>`;
      if (yv < topY) topY = yv;
    }

    const s = series[si];
    let html: string;
    if (showSplit) {
      html = `<span class="d">${fmtMD(s.d)}</span>` +
        `<b style="color:#8ec5ff">${fmtAUD(s.balP)}</b>` +
        `<span class="d">·</span>` +
        `<b style="color:#d2b8f5">${fmtAUD(s.balM)}</b>`;
    } else {
      html = `<span class="d">${fmtMD(s.d)}</span><b>${fmtAUD(seriesDefs[0].getVal(s))}</b>`;
    }

    readout = { xPct: (x / W) * 100, yPx: topY, html };
  }

  return { svgHTML: g, readout };
}

interface Props {
  entries: CashFlowEntry[];
  adjustedEntries: CashFlowEntry[];
  hasOverdue: boolean;
  scrubIndex: number;
  onScrubChange: (i: number) => void;
  horizon: number;
  onHorizonChange: (h: number) => void;
  bucketFilter: string;
}

export default function CashFlowChart({
  entries, adjustedEntries, hasOverdue, scrubIndex, onScrubChange, horizon, onHorizonChange, bucketFilter,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [readout, setReadout] = useState<ReadoutState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showAdjusted, setShowAdjusted] = useState(false);

  const series = useMemo<ChartSeries[]>(() =>
    entries.map((e, i) => ({
      i,
      d: new Date(e.date + 'T00:00:00'),
      balP: e.balP,
      balM: e.balM,
      bal: e.balance,
      events: e.breakdown,
    })),
    [entries]
  );

  const adjustedChartSeries = useMemo<ChartSeries[]>(() =>
    adjustedEntries.map((e, i) => ({
      i,
      d: new Date(e.date + 'T00:00:00'),
      balP: e.balP,
      balM: e.balM,
      bal: e.balance,
      events: e.breakdown,
    })),
    [adjustedEntries]
  );

  useLayoutEffect(() => {
    if (!svgRef.current || series.length === 0) return;
    const adj = showAdjusted && hasOverdue ? adjustedChartSeries : null;
    const { svgHTML, readout: ro } = buildChartSVG(series, adj, scrubIndex, bucketFilter);
    svgRef.current.innerHTML = svgHTML;
    setReadout(ro);
  }, [series, adjustedChartSeries, showAdjusted, hasOverdue, scrubIndex, bucketFilter]);

  function svgToIndex(clientX: number): number {
    if (!svgRef.current || series.length === 0) return 0;
    const rect = svgRef.current.getBoundingClientRect();
    const pad = { l: 64, r: 18 };
    const x = ((clientX - rect.left) / rect.width) * 1000;
    const pct = Math.max(0, Math.min(1, (x - pad.l) / (1000 - pad.l - pad.r)));
    return Math.round(pct * (series.length - 1));
  }

  // Stats for curve-top
  const si = Math.max(0, Math.min(scrubIndex, series.length - 1));
  const scrubSeries = series[si];
  const scrubEntry = entries[si];

  const showSplit = bucketFilter === 'all';

  const lowSeries = series.length > 0
    ? series.reduce((a, b) => {
        const va = bucketFilter === 'maple' ? a.balM : bucketFilter === 'personal' ? a.balP : a.bal;
        const vb = bucketFilter === 'maple' ? b.balM : bucketFilter === 'personal' ? b.balP : b.bal;
        return vb < va ? b : a;
      }, series[0])
    : null;

  const ccEntry = entries.find(e => e.breakdown.some(b => b.isCC));
  const ccTotal = ccEntry
    ? ccEntry.breakdown.filter(b => b.isCC).reduce((t, b) => t + (b.overrideAmount ?? b.forecastAmount), 0)
    : 0;
  const ccCount = ccEntry ? ccEntry.breakdown.filter(b => b.isCC).length : 0;
  const ccDate = ccEntry ? new Date(ccEntry.date + 'T00:00:00') : null;

  return (
    <div className="card curve-card">
      <div className="curve-top">
        <div className="stat">
          <div className="lbl">
            projected cash on {scrubSeries ? fmtLong(scrubSeries.d) : '—'}
          </div>
          <div className="val mono">
            {scrubEntry && showSplit ? (
              <>
                <span style={{ color: 'var(--personal)' }}>{fmtAUD(scrubEntry.balP)}</span>
                <span style={{ color: 'var(--mute)', fontSize: 28 }}> / </span>
                <span style={{ color: 'var(--maple)' }}>{fmtAUD(scrubEntry.balM)}</span>
              </>
            ) : scrubEntry ? (
              <span style={{ color: bucketFilter === 'maple' ? 'var(--maple)' : 'var(--personal)' }}>
                {fmtAUD(bucketFilter === 'maple' ? scrubEntry.balM : scrubEntry.balP)}
              </span>
            ) : '—'}
          </div>
          <div className="sub">
            {scrubSeries ? `+${si} days` : ''}
            {showSplit && scrubEntry
              ? ` · Personal + Maple tracked separately · combined ${fmtAUD(scrubEntry.balance)}`
              : ''}
          </div>
        </div>

        <div className="stat sm warn">
          <div className="lbl">low point · next {horizon}d</div>
          <div className="val mono">
            {lowSeries
              ? fmtAUD(
                  bucketFilter === 'maple' ? lowSeries.balM
                  : bucketFilter === 'personal' ? lowSeries.balP
                  : lowSeries.bal
                )
              : '—'}
          </div>
          <div className="sub">
            {lowSeries ? `${fmtMD(lowSeries.d)} · ${lowSeries.i}d out` : ''}
          </div>
        </div>

        {bucketFilter === 'personal' && (
          <div className="stat sm cc">
            <div className="lbl">next CC statement</div>
            <div className="val mono">{ccTotal > 0 ? fmtAUD(ccTotal) : '—'}</div>
            <div className="sub">
              {ccDate ? `due ${fmtMD(ccDate)} · ${ccCount} items` : 'no CC items found'}
            </div>
          </div>
        )}
      </div>

      <div className="chart-head">
        <span className="lbl">Scrub · +{si}d from today</span>
        {hasOverdue && (
          <button
            type="button"
            className={`toggle-adj${showAdjusted ? ' on' : ''}`}
            aria-pressed={showAdjusted ? 'true' : 'false'}
            onClick={() => setShowAdjusted(v => !v)}
            title="Show the balance if all overdue bills were paid today"
          >
            <span className="sw" /> If paid today
          </button>
        )}
        <div className="seg" role="group">
          {([{ label: '1M', days: 30 }, { label: '3M', days: 90 }, { label: '6M', days: 180 }, { label: '1Y', days: 365 }]).map(({ label, days }) => (
            <button
              key={label}
              aria-pressed={horizon === days ? 'true' : 'false'}
              onClick={() => onHorizonChange(days)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="svg-wrap">
        <svg
          ref={svgRef}
          className="tl-svg"
          viewBox="0 0 1000 360"
          preserveAspectRatio="none"
          onPointerDown={(e) => {
            setDragging(true);
            (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
            onScrubChange(svgToIndex(e.clientX));
          }}
          onPointerMove={(e) => {
            if (!dragging) return;
            onScrubChange(svgToIndex(e.clientX));
          }}
          onPointerUp={() => setDragging(false)}
        />
        <div
          className={`scrub-readout${readout ? ' on' : ''}`}
          style={readout ? { left: `${readout.xPct}%`, top: `${readout.yPx}px` } : undefined}
          dangerouslySetInnerHTML={{ __html: readout?.html ?? '' }}
        />
      </div>

      <TimelineScrubber
        value={si}
        max={Math.max(0, series.length - 1)}
        onChange={onScrubChange}
      />
    </div>
  );
}
