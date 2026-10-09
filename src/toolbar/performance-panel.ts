import type { AgentExternalContext } from '../shared/protocol.js';
import type { SelectionContext } from '../shared/selection-context.js';
import type { ServerFetchTiming } from '../shared/render-timing.js';
import {
  describePerformance,
  elementHints,
  formatBytes,
  formatMs,
  shortUrl,
  type ElementPerformance,
  type PageSummary,
  type SectionTiming,
} from './performance.js';

export type PerformanceSnapshot = {
  element: ElementPerformance;
  page: PageSummary;
  section?: SectionTiming;
  /** Why server timings are missing, when they are. */
  serverNote?: string;
};

type Rating = 'good' | 'needs-improvement' | 'poor';

/** Core Web Vitals thresholds: [good up to, poor above]. */
const THRESHOLDS = {
  ttfb: [800, 1800],
  fcp: [1800, 3000],
  lcp: [2500, 4000],
  cls: [0.1, 0.25],
  inp: [200, 500],
} as const;

/**
 * The Perf panel's content: the element's own paint and layout, then what the
 * server waited on to render it, then the page's vitals for scale.
 */
export function performanceDetail(
  context: SelectionContext,
  snapshot: PerformanceSnapshot,
  onFix?: (context: AgentExternalContext) => void,
): HTMLElement[] {
  const parts: HTMLElement[] = [];
  const { element: report, page, section } = snapshot;

  const elementRows: HTMLElement[] = [];
  if (report.lcp !== undefined) {
    elementRows.push(metrics([
      ['LCP', formatMs(report.lcp.timeMs), rate(report.lcp.timeMs, THRESHOLDS.lcp)],
    ]));
    const b = report.lcp.breakdown;
    if (b !== undefined) {
      elementRows.push(bars([
        ['TTFB', b.ttfb],
        ['Load delay', b.loadDelay],
        ['Load', b.loadDuration],
        ['Render delay', b.renderDelay],
      ].map(([label, value]) => ({ label: String(label), value: Number(value) }))));
    }
    elementRows.push(note(report.lcp.relation === 'is'
      ? 'This element is the page’s Largest Contentful Paint.'
      : 'The page’s Largest Contentful Paint is inside this element.'));
  }
  if (report.shifts.count > 0) {
    elementRows.push(metrics([
      ['Shifts', String(report.shifts.count), undefined],
      ['CLS', String(report.shifts.score), rate(report.shifts.score, THRESHOLDS.cls)],
    ]));
  }
  if (report.slowestInteractionMs !== undefined) {
    elementRows.push(metrics([
      ['Interaction', formatMs(report.slowestInteractionMs), rate(report.slowestInteractionMs, THRESHOLDS.inp)],
    ]));
  }
  if (report.images.length > 0) {
    elementRows.push(bars(report.images.map((image) => ({
      label: `${image.isLcp ? '★ ' : ''}${shortUrl(image.src)}${image.lazy ? ' · lazy' : ''}`,
      value: image.durationMs ?? 0,
      extra: image.transferBytes === undefined ? undefined : formatBytes(image.transferBytes),
      title: `${image.src}\n${image.naturalWidth}px source shown at ${image.renderedWidth}px`,
    }))));
  }
  if (elementRows.length === 0) {
    elementRows.push(note('Not the LCP element, no layout shifts, no images, no slow interactions.'));
  }
  parts.push(group('This element', elementRows));

  const serverRows: HTMLElement[] = [];
  if (section === undefined) {
    serverRows.push(note(snapshot.serverNote ?? 'No server timings for this page yet. Reload it to record a render.'));
  } else {
    if (section.components.length > 0) {
      serverRows.push(bars(section.components.map((component) => ({
        label: shortUrl(component.file),
        value: component.durationMs ?? 0,
        extra: component.durationMs === undefined ? 'early exit' : undefined,
        title: `Frontmatter of ${component.file}`,
      })), section.totalMs));
    }
    if (section.fetches.length > 0) {
      serverRows.push(note(`${section.fetches.length} fetch${section.fetches.length === 1 ? '' : 'es'} from this section:`));
      serverRows.push(fetchRows(section.fetches, section.totalMs));
    } else {
      serverRows.push(note('No server-side fetches in this section.'));
      if (section.slowestOnPage.length > 0) {
        serverRows.push(note('Slowest fetches elsewhere on the page:'));
        serverRows.push(fetchRows(section.slowestOnPage, section.totalMs));
      }
    }
    if (section.totalMs !== undefined) serverRows.push(note(`Whole page rendered in ${formatMs(section.totalMs)} on the dev server.`));
  }
  parts.push(group('Server render', serverRows));

  parts.push(group('Page', [metrics([
    ['TTFB', page.ttfbMs === undefined ? '—' : formatMs(page.ttfbMs), page.ttfbMs === undefined ? undefined : rate(page.ttfbMs, THRESHOLDS.ttfb)],
    ['FCP', page.fcpMs === undefined ? '—' : formatMs(page.fcpMs), page.fcpMs === undefined ? undefined : rate(page.fcpMs, THRESHOLDS.fcp)],
    ['LCP', page.lcpMs === undefined ? '—' : formatMs(page.lcpMs), page.lcpMs === undefined ? undefined : rate(page.lcpMs, THRESHOLDS.lcp)],
    ['CLS', String(page.cls), rate(page.cls, THRESHOLDS.cls)],
    ['INP', page.inpMs === undefined ? '—' : formatMs(page.inpMs), page.inpMs === undefined ? undefined : rate(page.inpMs, THRESHOLDS.inp)],
    ['Client fetches', String(page.clientFetches), undefined],
  ])]));

  const hints = [...elementHints(report), ...(section?.hints ?? [])];
  if (hints.length > 0) {
    const list = document.createElement('ul');
    list.className = 'perf-hints';
    for (const hint of hints) {
      const item = document.createElement('li');
      item.textContent = hint;
      list.append(item);
    }
    parts.push(group('Worth a look', [list]));
  }

  parts.push(note('Dev server numbers: unbundled and uncached, so compare sections rather than trusting absolute times.'));

  if (onFix !== undefined) {
    const fix = document.createElement('button');
    fix.type = 'button';
    fix.textContent = 'Ask AI to speed this up';
    fix.addEventListener('click', () => onFix({
      kind: 'performance',
      title: `Performance of ${context.selectedNode.componentName ?? context.selectedNode.tagName ?? 'selected element'}`,
      message: describePerformance(context, report, section),
      file: context.selectedNode.source.file,
      line: context.selectedNode.source.start.line,
    }));
    const actions = document.createElement('div');
    actions.className = 'source-buttons';
    actions.append(fix);
    parts.push(actions);
  }
  return parts;
}

function fetchRows(fetches: ServerFetchTiming[], totalMs: number | undefined): HTMLElement {
  return bars(fetches.map((entry) => ({
    label: `${entry.method === 'GET' ? '' : `${entry.method} `}${shortUrl(entry.url)}`,
    value: entry.durationMs ?? 0,
    offset: entry.startMs,
    extra: entry.error !== undefined
      ? 'failed'
      : [entry.status, entry.bytes === undefined ? undefined : formatBytes(entry.bytes)].filter(Boolean).join(' · ') || undefined,
    error: entry.error !== undefined || (entry.status ?? 0) >= 400,
    title: `${entry.method} ${entry.url}\nfrom ${entry.component ?? 'outside a component'}\nstarted at +${formatMs(entry.startMs)}${entry.error === undefined ? '' : `\n${entry.error}`}`,
  })), totalMs);
}

type BarRow = {
  label: string;
  value: number;
  /** Start on a shared axis; rows without one are drawn from zero. */
  offset?: number;
  extra?: string | undefined;
  error?: boolean;
  title?: string;
};

/** Rows on one scale, slowest marked, so the eye lands on what to fix. */
function bars(rows: BarRow[], axisMs?: number): HTMLElement {
  const container = document.createElement('div');
  container.className = 'perf-rows';
  const scale = Math.max(1, axisMs ?? 0, ...rows.map(({ value, offset = 0 }) => value + offset));
  const slowest = rows.length > 1 ? Math.max(...rows.map(({ value }) => value)) : Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'perf-row';
    if (row.value === slowest && row.value > 0) line.dataset.slowest = 'true';
    if (row.error === true) line.dataset.error = 'true';
    if (row.title !== undefined) line.title = row.title;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = row.extra === undefined ? row.label : `${row.label} · ${row.extra}`;
    const bar = document.createElement('span');
    bar.className = 'perf-bar';
    const fill = document.createElement('i');
    fill.style.left = `${((row.offset ?? 0) / scale) * 100}%`;
    fill.style.width = `${Math.max(2, (row.value / scale) * 100)}%`;
    bar.append(fill);
    const value = document.createElement('span');
    value.className = 'value';
    value.textContent = formatMs(row.value);
    line.append(label, bar, value);
    container.append(line);
  }
  return container;
}

function metrics(items: Array<[string, string, Rating | undefined]>): HTMLElement {
  const container = document.createElement('div');
  container.className = 'perf-metrics';
  for (const [name, value, rating] of items) {
    const metric = document.createElement('div');
    metric.className = 'perf-metric';
    if (rating !== undefined) metric.dataset.rating = rating;
    const label = document.createElement('span');
    label.textContent = name;
    const strong = document.createElement('strong');
    strong.textContent = value;
    metric.append(label, strong);
    container.append(metric);
  }
  return container;
}

function group(title: string, children: HTMLElement[]): HTMLElement {
  const section = document.createElement('section');
  section.className = 'perf-section';
  const heading = document.createElement('h4');
  heading.textContent = title;
  section.append(heading, ...children);
  return section;
}

function note(text: string): HTMLElement {
  const paragraph = document.createElement('p');
  paragraph.className = 'muted';
  paragraph.textContent = text;
  return paragraph;
}

export function rate(value: number, [good, poor]: readonly [number, number]): Rating {
  return value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor';
}
