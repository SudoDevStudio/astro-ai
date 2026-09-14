import type { AgentExternalContext, SeoPreviewConfig } from '../shared/protocol.js';
import { isSeoNetworkId } from '../shared/seo-preview.js';
import { EDITOR_LAYERS } from './layers.js';
import {
  auditPageMetadata,
  countBySeverity,
  describeFindingsForAgent,
  NETWORK_IDS,
  NETWORK_SPECS,
  readPageMetadata,
  resolveNetworkCards,
  type ImageProbe,
  type NetworkCard,
  type NetworkId,
  type PageMetadata,
  type SeoFinding,
} from './seo-metadata.js';

export type SeoSheetCallbacks = {
  /** Hands a finding to the agent, the same path 'Fix with AI' uses elsewhere. */
  onFix(context: AgentExternalContext): void;
};

type PaneId = 'previews' | 'issues' | 'tags';

/**
 * A full-screen reading of the page's head: what each network will render, what
 * is wrong, and every tag that was found.
 *
 * The sheet reads the live document rather than asking the server, because in
 * dev the rendered page is the authority — Vite has already applied whatever
 * the agent just changed, so reopening the sheet after an edit shows the result.
 */
export class SeoPreviewSheet {
  readonly element: HTMLDivElement;
  readonly #callbacks: SeoSheetCallbacks;
  readonly #sheet: HTMLElement;
  readonly #route: HTMLElement;
  readonly #score: HTMLElement;
  readonly #tabs: Map<PaneId, HTMLButtonElement> = new Map();
  readonly #panes: Map<PaneId, HTMLElement> = new Map();
  #metadata: PageMetadata | undefined;
  #findings: SeoFinding[] = [];
  #probe: ImageProbe = { status: 'absent' };
  #probeImage: HTMLImageElement | undefined;
  #pane: PaneId = 'previews';
  #open = false;
  #networks: readonly NetworkId[] = NETWORK_IDS;

  constructor(callbacks: SeoSheetCallbacks) {
    this.#callbacks = callbacks;
    this.element = element('div', 'seo-backdrop');
    this.element.hidden = true;
    this.element.addEventListener('pointerdown', (event) => {
      if (event.target === this.element) this.close();
    });

    this.#sheet = element('section', 'seo-sheet');
    this.#sheet.setAttribute('role', 'dialog');
    this.#sheet.setAttribute('aria-modal', 'true');
    this.#sheet.setAttribute('aria-label', 'SEO and social preview');

    const header = element('header', 'seo-header');
    const identity = element('div', 'seo-identity');
    const mark = element('span', 'seo-mark');
    mark.textContent = '◉';
    const titles = document.createElement('div');
    const eyebrow = element('span', 'seo-eyebrow');
    eyebrow.textContent = 'Share preview';
    this.#route = element('strong', 'seo-route');
    this.#route.textContent = '/';
    titles.append(eyebrow, this.#route);
    identity.append(mark, titles);

    const actions = element('div', 'seo-header-actions');
    this.#score = element('span', 'seo-score');
    this.#score.dataset.level = 'clean';
    this.#score.textContent = 'Reading the page…';
    const refresh = textButton('Re-read page', () => this.refresh());
    refresh.title = 'Read the head tags again after an edit';
    const close = iconButton('×', 'Close the share preview', () => this.close());
    close.classList.add('seo-close');
    actions.append(this.#score, refresh, close);
    header.append(identity, actions);

    const tabs = element('nav', 'seo-tabs');
    tabs.setAttribute('aria-label', 'Share preview sections');
    for (const pane of ['previews', 'issues', 'tags'] as const) {
      const tab = textButton('', () => this.showPane(pane));
      tab.className = 'seo-tab';
      tab.setAttribute('role', 'tab');
      tab.replaceChildren(paneLabel(pane, 0));
      this.#tabs.set(pane, tab);
      tabs.append(tab);
    }

    const scroll = element('div', 'seo-scroll');
    for (const pane of ['previews', 'issues', 'tags'] as const) {
      const body = element('div', `seo-pane seo-pane-${pane}`);
      body.hidden = pane !== this.#pane;
      this.#panes.set(pane, body);
      scroll.append(body);
    }

    this.#sheet.append(header, tabs, scroll);
    this.element.append(this.#sheet);
    this.showPane('previews');
  }

  get isOpen(): boolean {
    return this.#open;
  }

  get networks(): readonly NetworkId[] {
    return this.#networks;
  }

  /**
   * Applies the settings declared in `astro.config.mjs`. The server validates
   * them, so an unknown network here can only come from a version skew between
   * the integration and the toolbar; it is dropped rather than rendered blank.
   */
  configure(config: SeoPreviewConfig | false | undefined): void {
    const settings = config === false || config === undefined ? {} : config;
    const requested = settings.networks?.filter(isSeoNetworkId) ?? [];
    this.#networks = requested.length === 0 ? NETWORK_IDS : requested;
    if (this.#open) this.refresh();
  }

  open(): void {
    this.#open = true;
    this.element.hidden = false;
    this.refresh();
    document.addEventListener('keydown', this.#onKeyDown, true);
    requestAnimationFrame(() => this.#sheet.querySelector<HTMLElement>('.seo-tab')?.focus());
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.element.hidden = true;
    document.removeEventListener('keydown', this.#onKeyDown, true);
    this.#cancelProbe();
  }

  toggle(): void {
    if (this.#open) this.close();
    else this.open();
  }

  /** Re-reads the live document. Cheap enough to run on every open. */
  refresh(): void {
    const metadata = readPageMetadata(document, window.location.href);
    this.#metadata = metadata;
    this.#route.textContent = metadata.path;
    this.#route.title = metadata.url;
    this.#startProbe(metadata);
    this.#render();
  }

  /** A client-side navigation makes every reading stale. */
  handleNavigation(): void {
    if (this.#open) this.refresh();
  }

  destroy(): void {
    document.removeEventListener('keydown', this.#onKeyDown, true);
    this.#cancelProbe();
    this.element.remove();
  }

  showPane(pane: PaneId): void {
    this.#pane = pane;
    for (const [id, body] of this.#panes) body.hidden = id !== pane;
    for (const [id, tab] of this.#tabs) {
      tab.setAttribute('aria-selected', String(id === pane));
      tab.dataset.active = String(id === pane);
    }
  }

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.#open) return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  /**
   * Measures the real image. Declared `og:image:width` is a claim by the author;
   * the loaded bitmap is the only way to catch a tag that points at a 64px logo.
   */
  #startProbe(metadata: PageMetadata): void {
    this.#cancelProbe();
    const source = metadata.og.image ?? metadata.twitter.image;
    if (source === undefined) {
      this.#probe = { status: 'absent' };
      return;
    }
    const resolved = new URL(source, metadata.url).href;
    this.#probe = { status: 'loading' };
    const image = new Image();
    this.#probeImage = image;
    image.addEventListener('load', () => {
      if (this.#probeImage !== image) return;
      this.#probe = { status: 'loaded', width: image.naturalWidth, height: image.naturalHeight };
      this.#render();
    });
    image.addEventListener('error', () => {
      if (this.#probeImage !== image) return;
      this.#probe = { status: 'failed' };
      this.#render();
    });
    image.src = resolved;
  }

  #cancelProbe(): void {
    this.#probeImage = undefined;
  }

  #render(): void {
    const metadata = this.#metadata;
    if (metadata === undefined) return;
    this.#findings = auditPageMetadata(metadata, this.#probe);
    const counts = countBySeverity(this.#findings);
    this.#score.dataset.level = counts.error > 0 ? 'error' : counts.warning > 0 ? 'warning' : 'clean';
    this.#score.textContent = this.#findings.length === 0
      ? 'No issues found'
      : [
          counts.error === 0 ? undefined : `${counts.error} error${counts.error === 1 ? '' : 's'}`,
          counts.warning === 0 ? undefined : `${counts.warning} warning${counts.warning === 1 ? '' : 's'}`,
          counts.info === 0 ? undefined : `${counts.info} note${counts.info === 1 ? '' : 's'}`,
        ]
          .filter((part) => part !== undefined)
          .join(' · ');

    this.#tabs.get('issues')?.replaceChildren(paneLabel('issues', this.#findings.length));
    this.#tabs.get('tags')?.replaceChildren(paneLabel('tags', metadata.tags.length));

    this.#renderPreviews(metadata);
    this.#renderIssues(metadata);
    this.#renderTags(metadata);
  }

  #renderPreviews(metadata: PageMetadata): void {
    const pane = this.#panes.get('previews');
    if (pane === undefined) return;
    const grid = element('div', 'seo-grid');
    for (const card of resolveNetworkCards(metadata, this.#networks)) {
      grid.append(this.#renderCard(card));
    }
    pane.replaceChildren(grid);
  }

  #renderCard(card: NetworkCard): HTMLElement {
    const frame = element('article', 'seo-card');
    frame.dataset.network = card.network;
    frame.dataset.variant = card.variant;

    const label = element('div', 'seo-card-label');
    const name = element('span', 'seo-card-name');
    name.textContent = card.label;
    const surface = element('span', 'seo-card-surface');
    surface.textContent = card.surface;
    label.append(name, surface);
    if (card.missing.length > 0) {
      const gap = element('span', 'seo-card-gap');
      gap.textContent = `no ${card.missing.join(', ')}`;
      gap.title = `This network has no ${card.missing.join(' or ')} to show, so the card falls back.`;
      label.append(gap);
    }

    const stage = element('div', 'seo-card-stage');
    stage.append(renderNetworkCard(card));
    frame.append(label, stage);
    return frame;
  }

  #renderIssues(metadata: PageMetadata): void {
    const pane = this.#panes.get('issues');
    if (pane === undefined) return;
    if (this.#findings.length === 0) {
      const clean = element('div', 'seo-clean');
      const mark = element('span', 'seo-clean-mark');
      mark.textContent = '✓';
      const copy = document.createElement('p');
      copy.textContent = 'Every tag this checks is present and within the limits each network truncates at.';
      const heading = document.createElement('strong');
      heading.textContent = 'Nothing to fix';
      clean.append(mark, heading, copy);
      pane.replaceChildren(clean);
      return;
    }

    const bar = element('div', 'seo-issues-bar');
    const summary = element('p', 'seo-issues-summary');
    summary.textContent = `${this.#findings.length} issue${this.#findings.length === 1 ? '' : 's'} on ${metadata.path}. Fixing sends the full list and the current tag values to the agent.`;
    const fixAll = textButton('✦ Fix all with AI', () => {
      this.#callbacks.onFix(seoFixContext(metadata, this.#findings));
      this.close();
    });
    fixAll.className = 'seo-fix-all';
    bar.append(summary, fixAll);

    const list = element('ul', 'seo-findings');
    for (const finding of this.#findings) {
      const item = element('li', 'seo-finding');
      item.dataset.level = finding.level;
      const head = element('div', 'seo-finding-head');
      const level = element('span', 'seo-finding-level');
      level.textContent = finding.level;
      const title = element('strong', 'seo-finding-title');
      title.textContent = finding.title;
      const fix = textButton('✦ Fix with AI', () => {
        this.#callbacks.onFix(seoFixContext(metadata, [finding]));
        this.close();
      });
      fix.className = 'seo-fix';
      head.append(level, title, fix);

      const detail = element('p', 'seo-finding-detail');
      detail.textContent = finding.detail;

      const meta = element('div', 'seo-finding-meta');
      if (finding.tag !== undefined) {
        const tag = element('code', 'seo-finding-tag');
        tag.textContent = finding.tag;
        meta.append(tag);
      }
      for (const network of finding.networks) {
        const chip = element('span', 'seo-network-chip');
        chip.textContent = NETWORK_SPECS[network].label;
        meta.append(chip);
      }

      item.append(head, detail, meta);
      list.append(item);
    }
    pane.replaceChildren(bar, list);
  }

  #renderTags(metadata: PageMetadata): void {
    const pane = this.#panes.get('tags');
    if (pane === undefined) return;
    if (metadata.tags.length === 0) {
      const empty = element('p', 'seo-empty');
      empty.textContent = 'This page has no title, meta, or link tags in its head.';
      pane.replaceChildren(empty);
      return;
    }
    const table = element('div', 'seo-tag-table');
    for (const tag of metadata.tags) {
      const row = element('div', 'seo-tag-row');
      const key = element('code', 'seo-tag-key');
      key.textContent = tag.key;
      key.dataset.source = tag.source;
      const value = element('span', 'seo-tag-value');
      value.textContent = tag.value;
      value.title = tag.value;
      row.append(key, value);
      table.append(row);
    }
    pane.replaceChildren(table);
  }
}

export function seoFixContext(
  metadata: PageMetadata,
  findings: readonly SeoFinding[],
): AgentExternalContext {
  const title = findings.length === 1 && findings[0] !== undefined
    ? `${findings[0].title} · ${metadata.path}`
    : `${findings.length} share preview issues · ${metadata.path}`;
  return {
    kind: 'seo',
    title,
    message: describeFindingsForAgent(metadata, findings),
  };
}

/** Dispatches to the shape each network actually renders. */
function renderNetworkCard(card: NetworkCard): HTMLElement {
  switch (card.network) {
    case 'x':
      return renderX(card);
    case 'facebook':
      return renderFacebook(card);
    case 'linkedin':
      return renderLinkedIn(card);
    case 'instagram':
      return renderInstagram(card);
    case 'discord':
      return renderDiscord(card);
    case 'slack':
      return renderSlack(card);
    case 'whatsapp':
      return renderWhatsApp(card);
    case 'google':
      return renderGoogle(card);
  }
}

function renderX(card: NetworkCard): HTMLElement {
  const frame = element('div', 'x-card');
  if (card.variant === 'large') {
    frame.append(cardImage(card, 'x-image'));
    const body = element('div', 'x-body');
    body.append(
      line('x-domain', card.domain),
      line('x-title', card.title),
      line('x-text', card.description),
    );
    frame.append(body);
  } else {
    const row = element('div', 'x-compact');
    row.append(cardImage(card, 'x-thumb'));
    const body = element('div', 'x-body');
    body.append(
      line('x-domain', card.domain),
      line('x-title', card.title),
      line('x-text', card.description),
    );
    row.append(body);
    frame.append(row);
  }
  return frame;
}

function renderFacebook(card: NetworkCard): HTMLElement {
  const frame = element('div', 'fb-card');
  frame.append(cardImage(card, 'fb-image'));
  const body = element('div', 'fb-body');
  body.append(
    line('fb-domain', card.domain.toUpperCase()),
    line('fb-title', card.title),
    line('fb-text', card.description),
  );
  frame.append(body);
  return frame;
}

function renderLinkedIn(card: NetworkCard): HTMLElement {
  const frame = element('div', 'li-card');
  frame.append(cardImage(card, 'li-image'));
  const body = element('div', 'li-body');
  // LinkedIn drops the description in the feed and shows the domain instead.
  body.append(line('li-title', card.title), line('li-domain', card.domain));
  frame.append(body);
  return frame;
}

function renderInstagram(card: NetworkCard): HTMLElement {
  const bubble = element('div', 'ig-bubble');
  const frame = element('div', 'ig-card');
  frame.append(cardImage(card, 'ig-image'));
  const body = element('div', 'ig-body');
  body.append(line('ig-title', card.title), line('ig-text', card.description), line('ig-domain', card.domain));
  frame.append(body);
  const link = element('div', 'ig-link');
  link.textContent = card.url;
  bubble.append(frame, link);
  return bubble;
}

function renderDiscord(card: NetworkCard): HTMLElement {
  const frame = element('div', 'dc-embed');
  frame.style.setProperty('--dc-accent', card.themeColor ?? '#5865f2');
  const body = element('div', 'dc-body');
  if (card.siteName !== undefined) body.append(line('dc-site', card.siteName));
  body.append(line('dc-title', card.title), line('dc-text', card.description));
  if (card.variant === 'large') {
    body.append(cardImage(card, 'dc-image'));
    frame.append(body);
  } else {
    const row = element('div', 'dc-row');
    row.append(body, cardImage(card, 'dc-thumb'));
    frame.append(row);
  }
  return frame;
}

function renderSlack(card: NetworkCard): HTMLElement {
  const frame = element('div', 'sl-unfurl');
  const body = element('div', 'sl-body');
  const site = element('div', 'sl-site');
  if (card.favicon !== undefined) {
    const icon = document.createElement('img');
    icon.className = 'sl-favicon';
    icon.src = card.favicon;
    icon.alt = '';
    site.append(icon);
  }
  const siteName = element('span', 'sl-site-name');
  siteName.textContent = card.siteName ?? card.domain;
  site.append(siteName);
  body.append(site, line('sl-title', card.title), line('sl-text', card.description));
  const row = element('div', 'sl-row');
  row.append(body, cardImage(card, 'sl-thumb'));
  frame.append(row);
  return frame;
}

function renderWhatsApp(card: NetworkCard): HTMLElement {
  const bubble = element('div', 'wa-bubble');
  const preview = element('div', 'wa-preview');
  const row = element('div', 'wa-row');
  const body = element('div', 'wa-body');
  body.append(
    line('wa-title', card.title),
    line('wa-text', card.description),
    line('wa-domain', card.domain),
  );
  row.append(body, cardImage(card, 'wa-thumb'));
  preview.append(row);
  const link = element('div', 'wa-link');
  link.textContent = card.url;
  const time = element('span', 'wa-time');
  time.textContent = '09:41 ✓✓';
  bubble.append(preview, link, time);
  return bubble;
}

function renderGoogle(card: NetworkCard): HTMLElement {
  const frame = element('div', 'gg-result');
  const site = element('div', 'gg-site');
  const badge = element('span', 'gg-favicon');
  if (card.favicon !== undefined) {
    const icon = document.createElement('img');
    icon.src = card.favicon;
    icon.alt = '';
    badge.append(icon);
  } else {
    badge.textContent = card.domain.slice(0, 1).toUpperCase();
  }
  const names = element('div', 'gg-names');
  names.append(line('gg-site-name', card.siteName ?? card.domain), line('gg-url', breadcrumb(card)));
  site.append(badge, names);
  frame.append(site, line('gg-title', card.title), line('gg-text', card.description));
  return frame;
}

function breadcrumb(card: NetworkCard): string {
  const segments = card.url
    .replace(/^https?:\/\//, '')
    .split('/')
    .filter((segment) => segment !== '');
  return segments.join(' › ');
}

/**
 * The image slot. A missing or unreachable image is drawn as an explicit
 * placeholder rather than an empty box, because "nothing renders here" is the
 * finding the developer opened this sheet to see.
 */
function cardImage(card: NetworkCard, className: string): HTMLElement {
  if (card.image === undefined) {
    const placeholder = element('div', `${className} seo-image-missing`);
    placeholder.textContent = 'No og:image';
    return placeholder;
  }
  const wrapper = element('div', className);
  const image = document.createElement('img');
  image.src = card.image;
  image.alt = card.imageAlt ?? '';
  image.loading = 'lazy';
  image.addEventListener('error', () => {
    wrapper.classList.add('seo-image-missing');
    wrapper.textContent = 'og:image failed to load';
  });
  wrapper.append(image);
  return wrapper;
}

/** A text slot that collapses when the network has nothing to put in it. */
function line(className: string, text: string): HTMLElement {
  const node = element('div', className);
  node.textContent = text;
  node.hidden = text === '';
  return node;
}

function paneLabel(pane: PaneId, count: number): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const label = document.createElement('span');
  label.textContent = pane === 'previews' ? 'Previews' : pane === 'issues' ? 'Issues' : 'Tags';
  fragment.append(label);
  if (count > 0) {
    const badge = element('span', 'seo-tab-count');
    badge.textContent = String(count);
    fragment.append(badge);
  }
  return fragment;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function textButton(label: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

function iconButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const node = textButton(label, onClick);
  node.className = 'icon-button';
  node.title = title;
  node.setAttribute('aria-label', title);
  return node;
}

/**
 * The sheet's own stylesheet. Each card reproduces its network's real surface
 * colours — a light Google result beside a black X card — because a preview
 * that adopts the editor's palette is not a preview.
 */
export function createSeoSheetStyle(): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = `
    .seo-backdrop { align-items: center; background: rgb(3 5 10 / .72); backdrop-filter: blur(3px); bottom: 0; display: flex; justify-content: center; left: 0; position: fixed; right: 0; top: 0; z-index: ${EDITOR_LAYERS.sheet}; }
    .seo-backdrop[hidden] { display: none; }
    .seo-sheet { background: #0e1117; border: 1px solid #343c49; border-radius: 16px; box-shadow: 0 30px 90px rgb(0 0 0 / .6); box-sizing: border-box; color: #f8fafc; display: grid; font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; grid-template-rows: auto auto minmax(0, 1fr); height: min(900px, calc(100vh - 48px)); max-width: 1240px; overflow: hidden; width: calc(100vw - 48px); }
    .seo-header { align-items: center; border-bottom: 1px solid #292f3a; display: flex; gap: 16px; justify-content: space-between; padding: 14px 18px; }
    .seo-identity { align-items: center; display: flex; gap: 11px; min-width: 0; }
    .seo-mark { align-items: center; background: linear-gradient(135deg, #0891b2, #22d3ee); border-radius: 9px; color: #042f2e; display: flex; font-size: 15px; height: 32px; justify-content: center; width: 32px; }
    .seo-eyebrow { color: #929bab; display: block; font-size: 9px; font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
    .seo-route { display: block; font: 600 14px/1.3 ui-monospace, SFMono-Regular, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .seo-header-actions { align-items: center; display: flex; flex: 0 0 auto; gap: 8px; }
    .seo-score { border-radius: 999px; font-size: 10px; font-weight: 700; padding: 5px 10px; }
    .seo-score[data-level='clean'] { background: #102c22; border: 1px solid #225b45; color: #86efac; }
    .seo-score[data-level='warning'] { background: #33270f; border: 1px solid #78551c; color: #fcd34d; }
    .seo-score[data-level='error'] { background: #35191d; border: 1px solid #713039; color: #fda4af; }
    .seo-tabs { border-bottom: 1px solid #292f3a; display: flex; gap: 4px; padding: 0 14px; }
    .seo-tab { align-items: center; background: transparent; border: 0; border-bottom: 2px solid transparent; border-radius: 0; color: #8c94a3; display: flex; font-size: 12px; font-weight: 600; gap: 7px; padding: 11px 12px; }
    .seo-tab:hover:not(:disabled) { background: transparent; border-bottom-color: #3c4451; color: #d9dce3; }
    .seo-tab[data-active='true'] { border-bottom-color: #22d3ee; color: #ecfeff; }
    .seo-tab-count { background: #232a35; border-radius: 999px; color: #aeb7c5; font-size: 10px; padding: 1px 6px; }
    .seo-tab[data-active='true'] .seo-tab-count { background: #0e4a5a; color: #a5f3fc; }
    .seo-scroll { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 20px; scrollbar-color: #353d4a transparent; }
    .seo-pane[hidden] { display: none; }
    .seo-grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); }
    .seo-card { background: #12161d; border: 1px solid #272e39; border-radius: 12px; display: grid; gap: 12px; grid-template-rows: auto 1fr; padding: 13px; }
    .seo-card-label { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; }
    .seo-card-name { font-size: 12px; font-weight: 700; }
    .seo-card-surface { color: #7f8998; font-size: 10px; }
    .seo-card-gap { background: #35191d; border: 1px solid #713039; border-radius: 4px; color: #fda4af; font-size: 9px; font-weight: 700; margin-left: auto; padding: 2px 6px; }
    .seo-card-stage { align-items: start; display: grid; }
    .seo-card img { display: block; height: 100%; object-fit: cover; width: 100%; }
    .seo-image-missing { align-items: center; background: repeating-linear-gradient(45deg, #191f28, #191f28 8px, #151b23 8px, #151b23 16px); border: 1px dashed #46505f !important; box-sizing: border-box; color: #8c94a3; display: flex; font: 600 10px/1.3 ui-sans-serif, system-ui, sans-serif; justify-content: center; text-align: center; }

    .x-card { background: #000; border: 1px solid #2f3336; border-radius: 16px; color: #e7e9ea; font: 15px/1.3 -apple-system, system-ui, sans-serif; overflow: hidden; }
    .x-image { aspect-ratio: 1.91; }
    .x-compact { display: grid; grid-template-columns: 128px 1fr; }
    .x-thumb { aspect-ratio: 1; border-right: 1px solid #2f3336; }
    .x-body { display: grid; gap: 2px; padding: 11px 13px; }
    .x-domain { color: #71767b; font-size: 13px; }
    .x-title { -webkit-box-orient: vertical; -webkit-line-clamp: 2; display: -webkit-box; font-size: 15px; overflow: hidden; }
    .x-text { -webkit-box-orient: vertical; -webkit-line-clamp: 2; color: #71767b; display: -webkit-box; font-size: 13px; overflow: hidden; }

    .fb-card { background: #f2f3f5; border: 1px solid #dadde1; border-radius: 8px; color: #050505; font: 14px/1.35 -apple-system, system-ui, sans-serif; overflow: hidden; }
    .fb-image { aspect-ratio: 1.91; background: #e4e6eb; }
    .fb-body { display: grid; gap: 3px; padding: 10px 12px; }
    .fb-domain { color: #65676b; font-size: 11px; letter-spacing: .02em; }
    .fb-title { -webkit-box-orient: vertical; -webkit-line-clamp: 2; display: -webkit-box; font-size: 16px; font-weight: 700; line-height: 1.25; overflow: hidden; }
    .fb-text { color: #65676b; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .li-card { background: #fff; border: 1px solid #d0d5da; border-radius: 4px; color: #000; font: 14px/1.35 -apple-system, system-ui, sans-serif; overflow: hidden; }
    .li-image { aspect-ratio: 1.91; background: #eef3f8; }
    .li-body { display: grid; gap: 4px; padding: 11px 13px; }
    .li-title { -webkit-box-orient: vertical; -webkit-line-clamp: 2; display: -webkit-box; font-size: 15px; font-weight: 600; line-height: 1.3; overflow: hidden; }
    .li-domain { color: #00000099; font-size: 12px; }

    .ig-bubble { display: grid; gap: 4px; justify-items: start; }
    .ig-card { background: #262626; border: 1px solid #363636; border-radius: 18px; color: #fafafa; font: 13px/1.35 -apple-system, system-ui, sans-serif; max-width: 300px; overflow: hidden; }
    .ig-image { aspect-ratio: 1.91; background: #1c1c1c; }
    .ig-body { display: grid; gap: 3px; padding: 10px 12px; }
    .ig-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ig-text { -webkit-box-orient: vertical; -webkit-line-clamp: 2; color: #a8a8a8; display: -webkit-box; font-size: 12px; overflow: hidden; }
    .ig-domain { color: #737373; font-size: 11px; text-transform: lowercase; }
    .ig-link { background: #3797f0; border-radius: 18px; color: #fff; font-size: 12px; max-width: 300px; overflow: hidden; padding: 8px 13px; text-overflow: ellipsis; white-space: nowrap; }

    .dc-embed { background: #2b2d31; border-left: 4px solid var(--dc-accent, #5865f2); border-radius: 4px; color: #dbdee1; font: 14px/1.4 -apple-system, system-ui, sans-serif; overflow: hidden; }
    .dc-row { display: grid; gap: 12px; grid-template-columns: 1fr 80px; }
    .dc-body { display: grid; gap: 6px; padding: 12px 14px; }
    .dc-site { color: #dbdee1; font-size: 12px; }
    .dc-title { color: #00a8fc; font-size: 15px; font-weight: 600; }
    .dc-text { -webkit-box-orient: vertical; -webkit-line-clamp: 4; color: #b5bac1; display: -webkit-box; font-size: 13px; overflow: hidden; }
    .dc-image { aspect-ratio: 1.91; border-radius: 4px; margin-top: 4px; overflow: hidden; }
    .dc-thumb { align-self: start; aspect-ratio: 1; border-radius: 4px; margin: 12px 14px 12px 0; overflow: hidden; }

    .sl-unfurl { background: #1a1d21; border-radius: 4px; box-shadow: inset 3px 0 #4a5057; color: #d1d2d3; font: 15px/1.45 -apple-system, system-ui, sans-serif; }
    .sl-row { display: grid; gap: 10px; grid-template-columns: 1fr 72px; padding: 8px 10px 10px 14px; }
    .sl-body { display: grid; gap: 3px; min-width: 0; }
    .sl-site { align-items: center; display: flex; gap: 6px; }
    .sl-favicon { border-radius: 3px; height: 16px; width: 16px; }
    .sl-site-name { font-size: 13px; font-weight: 700; }
    .sl-title { color: #1d9bd1; font-size: 15px; font-weight: 700; }
    .sl-text { -webkit-box-orient: vertical; -webkit-line-clamp: 3; color: #ababad; display: -webkit-box; font-size: 13px; overflow: hidden; }
    .sl-thumb { align-self: start; aspect-ratio: 1; border-radius: 6px; overflow: hidden; }

    .wa-bubble { background: #005c4b; border-radius: 8px 0 8px 8px; color: #e9edef; display: grid; font: 14px/1.4 -apple-system, system-ui, sans-serif; gap: 2px; justify-items: stretch; max-width: 330px; padding: 4px 4px 6px; }
    .wa-preview { background: #025144; border-radius: 6px; overflow: hidden; }
    .wa-row { display: grid; gap: 8px; grid-template-columns: 1fr 76px; padding: 8px 10px; }
    .wa-body { display: grid; gap: 2px; min-width: 0; }
    .wa-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wa-text { -webkit-box-orient: vertical; -webkit-line-clamp: 2; color: #ffffffa6; display: -webkit-box; font-size: 12px; overflow: hidden; }
    .wa-domain { color: #ffffff73; font-size: 11px; }
    .wa-thumb { align-self: center; aspect-ratio: 1; border-radius: 4px; overflow: hidden; }
    .wa-link { color: #53bdeb; font-size: 13px; overflow: hidden; padding: 3px 6px 0; text-overflow: ellipsis; white-space: nowrap; }
    .wa-time { color: #ffffff8a; font-size: 10px; padding: 0 6px; text-align: right; }

    .gg-result { background: #fff; border: 1px solid #dfe1e5; border-radius: 8px; color: #202124; font: 14px/1.4 arial, sans-serif; padding: 14px 16px; }
    .gg-site { align-items: center; display: flex; gap: 10px; margin-bottom: 5px; }
    .gg-favicon { align-items: center; background: #f1f3f4; border: 1px solid #dfe1e5; border-radius: 50%; color: #5f6368; display: flex; flex: 0 0 26px; font-size: 12px; font-weight: 700; height: 26px; justify-content: center; overflow: hidden; width: 26px; }
    .gg-favicon img { border-radius: 50%; height: 18px !important; width: 18px !important; }
    .gg-names { min-width: 0; }
    .gg-site-name { color: #202124; font-size: 14px; }
    .gg-url { color: #4d5156; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gg-title { color: #1a0dab; font-size: 20px; line-height: 1.3; margin: 2px 0 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gg-text { -webkit-box-orient: vertical; -webkit-line-clamp: 2; color: #4d5156; display: -webkit-box; font-size: 14px; overflow: hidden; }

    .seo-issues-bar { align-items: center; background: #12161d; border: 1px solid #272e39; border-radius: 10px; display: flex; gap: 16px; justify-content: space-between; margin-bottom: 16px; padding: 12px 14px; }
    .seo-issues-summary { color: #aeb7c5; font-size: 12px; margin: 0; }
    .seo-fix-all, .seo-fix { background: #4c1d95; border-color: #8b5cf6; color: #ede9fe; flex: 0 0 auto; font-weight: 700; white-space: nowrap; }
    .seo-fix { font-size: 11px; margin-left: auto; padding: 4px 9px; }
    .seo-findings { display: grid; gap: 10px; list-style: none; margin: 0; padding: 0; }
    .seo-finding { background: #12161d; border: 1px solid #272e39; border-left-width: 3px; border-radius: 9px; display: grid; gap: 7px; padding: 12px 14px; }
    .seo-finding[data-level='error'] { border-left-color: #ef4444; }
    .seo-finding[data-level='warning'] { border-left-color: #f59e0b; }
    .seo-finding[data-level='info'] { border-left-color: #38bdf8; }
    .seo-finding-head { align-items: center; display: flex; gap: 10px; }
    .seo-finding-level { border-radius: 4px; font-size: 9px; font-weight: 700; letter-spacing: .06em; padding: 2px 6px; text-transform: uppercase; }
    .seo-finding[data-level='error'] .seo-finding-level { background: #35191d; color: #fda4af; }
    .seo-finding[data-level='warning'] .seo-finding-level { background: #33270f; color: #fcd34d; }
    .seo-finding[data-level='info'] .seo-finding-level { background: #0c2b3a; color: #7dd3fc; }
    .seo-finding-title { font-size: 13px; }
    .seo-finding-detail { color: #aeb7c5; font-size: 12px; margin: 0; }
    .seo-finding-meta { align-items: center; display: flex; flex-wrap: wrap; gap: 6px; }
    .seo-finding-tag { background: #090c11; border: 1px solid #303744; border-radius: 5px; color: #c4b5fd; font: 10px/1.5 ui-monospace, SFMono-Regular, monospace; padding: 2px 6px; }
    .seo-network-chip { background: #1d2330; border: 1px solid #343d4a; border-radius: 999px; color: #8c94a3; font-size: 9px; padding: 2px 8px; }
    .seo-clean { align-items: center; color: #98a2b1; display: grid; justify-items: center; margin: clamp(30px, 10vh, 90px) auto; max-width: 320px; text-align: center; }
    .seo-clean-mark { align-items: center; background: #102c22; border: 1px solid #225b45; border-radius: 14px; color: #86efac; display: flex; font-size: 20px; height: 46px; justify-content: center; margin-bottom: 12px; width: 46px; }
    .seo-clean p { font-size: 12px; margin: 6px 0 0; }
    .seo-empty { color: #8c94a3; font-size: 12px; }
    .seo-tag-table { border: 1px solid #272e39; border-radius: 9px; overflow: hidden; }
    .seo-tag-row { border-bottom: 1px solid #1d232c; display: grid; gap: 14px; grid-template-columns: minmax(140px, 240px) 1fr; padding: 8px 13px; }
    .seo-tag-row:last-child { border-bottom: 0; }
    .seo-tag-row:nth-child(odd) { background: #101419; }
    .seo-tag-key { color: #a5f3fc; font: 11px/1.5 ui-monospace, SFMono-Regular, monospace; overflow: hidden; text-overflow: ellipsis; }
    .seo-tag-key[data-source='meta-property'] { color: #c4b5fd; }
    .seo-tag-key[data-source='link'], .seo-tag-key[data-source='html'] { color: #fcd34d; }
    .seo-tag-value { color: #d9dce3; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @media (max-width: 720px) {
      .seo-sheet { border-radius: 0; height: 100vh; width: 100vw; }
      .seo-grid { grid-template-columns: 1fr; }
      .seo-issues-bar { flex-wrap: wrap; }
      .seo-tag-row { grid-template-columns: 1fr; gap: 3px; }
    }
  `;
  return style;
}
