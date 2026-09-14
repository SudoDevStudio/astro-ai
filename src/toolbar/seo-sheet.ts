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
import {
  auditStructuredData,
  describeEntity,
  describeStructuredData,
  readStructuredData,
  resolveRichResult,
  type EntityView,
  type RichResult,
  type StructuredData,
} from './seo-schema.js';
import {
  auditAnswerReadiness,
  composeAnswer,
  describeExtractionForAgent,
  extractForAnswerEngines,
  measureServerText,
  type AeoAnswer,
  type AeoExtraction,
} from './seo-aeo.js';

export type SeoSheetCallbacks = {
  /** Hands a finding to the agent, the same path 'Fix with AI' uses elsewhere. */
  onFix(context: AgentExternalContext): void;
};

type PaneId = 'previews' | 'issues' | 'schema' | 'aeo' | 'tags';

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
  #structured: StructuredData = { blocks: [], nodes: [] };
  #rich: RichResult = {};
  #extraction: AeoExtraction | undefined;
  #answer: AeoAnswer | undefined;
  /** Guards the served-HTML fetch against a refresh that overtakes it. */
  #serverProbe = 0;

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
    for (const pane of PANES) {
      const tab = textButton('', () => this.showPane(pane));
      tab.className = 'seo-tab';
      tab.setAttribute('role', 'tab');
      tab.replaceChildren(paneLabel(pane, 0));
      this.#tabs.set(pane, tab);
      tabs.append(tab);
    }

    const scroll = element('div', 'seo-scroll');
    for (const pane of PANES) {
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
    // Read as one pair: a cross-check compares the schema against these tags,
    // so they have to describe the same moment in the page's life.
    this.#structured = readStructuredData(document);
    this.#rich = resolveRichResult(this.#structured);
    this.#extraction = extractForAnswerEngines(document, metadata, this.#structured);
    this.#answer = composeAnswer(this.#extraction, metadata);
    this.#measureServerText(metadata);
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
    // Meta-tag and structured-data findings are one list: they are the same
    // kind of problem to the reader, and Fix with AI should be able to take
    // them together.
    this.#findings = [
      ...auditPageMetadata(metadata, this.#probe),
      ...auditStructuredData(this.#structured, metadata),
      ...(this.#extraction === undefined
        ? []
        : auditAnswerReadiness(this.#extraction, metadata, this.#structured)),
    ].sort((first, second) => severityRank(first.level) - severityRank(second.level));
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
    this.#tabs.get('schema')?.replaceChildren(paneLabel('schema', this.#structured.nodes.length));
    this.#tabs.get('aeo')?.replaceChildren(paneLabel('aeo', this.#extraction?.facts.length ?? 0));
    this.#tabs.get('tags')?.replaceChildren(paneLabel('tags', metadata.tags.length));

    this.#renderPreviews(metadata);
    this.#renderIssues(metadata);
    this.#renderSchema();
    this.#renderAeo();
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
    stage.append(renderNetworkCard(card, this.#rich));
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
      this.#callbacks.onFix(seoFixContext(metadata, this.#findings, this.#structured, this.#extraction));
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
        this.#callbacks.onFix(seoFixContext(metadata, [finding], this.#structured, this.#extraction));
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

  #renderSchema(): void {
    const pane = this.#panes.get('schema');
    if (pane === undefined) return;
    if (this.#structured.blocks.length === 0) {
      const empty = element('div', 'seo-clean');
      const mark = element('span', 'seo-clean-mark');
      mark.dataset.tone = 'neutral';
      mark.textContent = '{ }';
      const heading = document.createElement('strong');
      heading.textContent = 'No structured data';
      const copy = document.createElement('p');
      copy.textContent = 'This page has no JSON-LD, so its result can only be a title, a URL, and a snippet. A BreadcrumbList, an Organization, or a Product is what adds anything more.';
      empty.append(mark, heading, copy);
      pane.replaceChildren(empty);
      return;
    }

    const blocks = this.#structured.blocks.map((block) => {
      const frame = element('section', 'schema-block');
      frame.dataset.state = block.error === undefined ? 'parsed' : 'invalid';

      const head = element('div', 'schema-block-head');
      const index = element('span', 'schema-index');
      index.textContent = `Block ${block.index}`;
      head.append(index);
      for (const node of block.nodes) {
        const chip = element('span', 'schema-type');
        chip.textContent = node.types.join(' + ') || '(no @type)';
        chip.title = node.path;
        head.append(chip);
      }
      if (block.context !== undefined) {
        const context = element('span', 'schema-context');
        context.textContent = block.context;
        head.append(context);
      }
      frame.append(head);

      if (block.error !== undefined) {
        const error = element('p', 'schema-error');
        error.textContent = block.error;
        frame.append(error);
      }

      // The entity, drawn the way the thing it describes actually appears.
      // Braces are the notation, not the meaning, so they go behind a toggle.
      for (const node of block.nodes) {
        frame.append(renderEntityCard(describeEntity(node)));
      }

      const details = document.createElement('details');
      details.className = 'schema-source';
      const summary = document.createElement('summary');
      summary.textContent = block.error === undefined ? 'Show JSON' : 'Show the text that failed to parse';
      const source = document.createElement('pre');
      source.textContent = block.error === undefined ? prettyJson(block.raw) : block.raw;
      details.append(summary, source);
      frame.append(details);
      return frame;
    });

    const summary = element('p', 'schema-summary');
    const nodeCount = this.#structured.nodes.length;
    summary.textContent = `${this.#structured.blocks.length} block${this.#structured.blocks.length === 1 ? '' : 's'} describing ${nodeCount} ${nodeCount === 1 ? 'thing' : 'things'}. What they add to the result is on the Google card; what is wrong with them is on Issues.`;
    pane.replaceChildren(summary, ...blocks);
  }

  /**
   * Reads the page as it was served, before any script ran.
   *
   * The sheet reads the rendered DOM, which is the page after hydration. Most
   * answer engines are not browsers. Where the two disagree, everything built
   * on the client is invisible to them, and this is the only way to see that
   * from inside the page.
   */
  #measureServerText(metadata: PageMetadata): void {
    const token = (this.#serverProbe += 1);
    if (typeof fetch !== 'function' || typeof DOMParser !== 'function') return;
    let request: Promise<Response>;
    try {
      request = fetch(window.location.href, { headers: { accept: 'text/html' }, credentials: 'same-origin' });
    } catch {
      return;
    }
    void request
      .then((response) => (response.ok ? response.text() : undefined))
      .then((html) => {
        if (html === undefined || token !== this.#serverProbe || this.#extraction === undefined) return;
        this.#extraction = {
          ...this.#extraction,
          serverWords: measureServerText(html, (markup) =>
            new DOMParser().parseFromString(markup, 'text/html')),
        };
        this.#answer = composeAnswer(this.#extraction, metadata);
        this.#render();
      })
      .catch(() => {
        // A page behind an auth redirect simply keeps the rendered reading.
      });
  }

  #renderAeo(): void {
    const pane = this.#panes.get('aeo');
    const extraction = this.#extraction;
    const answer = this.#answer;
    if (pane === undefined || extraction === undefined || answer === undefined) return;

    const intro = element('p', 'aeo-intro');
    intro.textContent = 'Search shows your page. An answer engine reads it, states what it says, and cites you if it can. This is what one has to work with.';

    const extract = element('section', 'aeo-block');
    extract.append(sectionTitle('What an answer engine extracts'));

    const subject = element('div', 'aeo-subject');
    if (extraction.entity === undefined) {
      subject.dataset.state = 'missing';
      subject.textContent = 'No declared subject — an engine must infer what this page is about.';
    } else {
      const type = element('span', 'aeo-subject-type');
      type.textContent = extraction.entity.label;
      const name = element('strong', 'aeo-subject-name');
      name.textContent = extraction.entity.name;
      subject.append(type, name);
    }
    extract.append(subject);

    if (extraction.facts.length === 0) {
      extract.append(emptyNote('No facts stated plainly enough to lift.'));
    } else {
      const facts = element('dl', 'aeo-facts');
      for (const fact of extraction.facts) {
        const label = document.createElement('dt');
        label.textContent = fact.label;
        const value = document.createElement('dd');
        value.textContent = fact.value;
        const source = element('span', 'aeo-source');
        source.dataset.source = fact.source;
        source.textContent = fact.source === 'schema' ? 'structured' : 'meta tag';
        source.title = fact.source === 'schema'
          ? 'Declared in JSON-LD, so it can be lifted verbatim.'
          : 'Read from a meta tag, which is prose to an engine rather than a typed value.';
        value.append(source);
        facts.append(label, value);
      }
      extract.append(facts);
    }

    const quotable = element('div', 'aeo-quotable');
    quotable.append(sectionTitle(`Quotable units · ${extraction.quotable.length}`, 'aeo-subtitle'));
    if (extraction.quotable.length === 0) {
      quotable.append(emptyNote('No question and answer pairs. Assistants answer questions; this page offers none in that shape.'));
    } else {
      for (const unit of extraction.quotable.slice(0, 5)) {
        const row = element('div', 'aeo-qa');
        const question = element('strong', 'aeo-question');
        question.textContent = unit.question;
        const badge = element('span', 'aeo-source');
        badge.dataset.source = unit.source === 'faq' ? 'schema' : 'meta';
        badge.textContent = unit.source === 'faq' ? 'FAQ schema' : 'heading';
        const answerText = element('p', 'aeo-answer-text');
        answerText.textContent = unit.answer;
        question.append(badge);
        row.append(question, answerText);
        quotable.append(row);
      }
    }
    extract.append(quotable);

    const stats = element('div', 'aeo-stats');
    stats.append(
      stat('Readable words', String(extraction.renderedWords)),
      stat(
        'In the served HTML',
        extraction.serverWords === undefined ? 'reading…' : String(extraction.serverWords),
        extraction.serverWords !== undefined && extraction.renderedWords > 0 &&
          extraction.serverWords < extraction.renderedWords * 0.4 ? 'bad' : 'good',
      ),
      stat('Headings', String(extraction.headings.length)),
      stat('Author', extraction.provenance.author ?? 'none', extraction.provenance.author === undefined ? 'bad' : 'good'),
      stat('Published', extraction.provenance.published ?? 'none', extraction.provenance.published === undefined ? 'bad' : 'good'),
      stat('Citable URL', extraction.provenance.canonical === undefined ? 'none' : 'canonical', extraction.provenance.canonical === undefined ? 'bad' : 'good'),
    );
    extract.append(stats);

    const likely = element('section', 'aeo-block');
    likely.append(sectionTitle('The answer this page affords'));
    const card = element('div', 'aeo-answer');
    card.dataset.grounding = answer.grounding;
    const sentence = element('p', 'aeo-sentence');
    sentence.textContent = answer.sentence;
    const cite = element('div', 'aeo-cite');
    const source = element('span', 'aeo-cite-source');
    source.textContent = answer.citation;
    const grounding = element('span', 'aeo-grounding');
    grounding.textContent = `${answer.grounding} grounding`;
    cite.append(source, grounding);
    card.append(sentence, cite);

    const caveat = element('p', 'aeo-caveat');
    caveat.textContent = 'Assembled from the values above by a template, not generated by a model. Every clause is something this page states — which is the point: a thin sentence here means a thin page, not a cautious assistant.';
    likely.append(card, caveat);

    const aeoFindings = this.#findings.filter(({ id }) => id.startsWith('aeo-'));
    const summary = element('p', 'aeo-findings-note');
    summary.textContent = aeoFindings.length === 0
      ? 'Nothing is holding this page back from being quoted.'
      : `${aeoFindings.length} thing${aeoFindings.length === 1 ? '' : 's'} limiting how quotable this page is, listed on Issues.`;

    pane.replaceChildren(intro, extract, likely, summary);
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
  structured?: StructuredData,
  extraction?: AeoExtraction,
): AgentExternalContext {
  const title = findings.length === 1 && findings[0] !== undefined
    ? `${findings[0].title} · ${metadata.path}`
    : `${findings.length} share preview issues · ${metadata.path}`;
  // The schema goes in only when a finding is about it, so a plain meta-tag
  // fix is not padded with JSON the agent does not need to read.
  const touchesSchema = findings.some(({ id }) => id.startsWith('schema-'));
  const touchesAeo = findings.some(({ id }) => id.startsWith('aeo-'));
  const extras = [
    structured !== undefined && (touchesSchema || touchesAeo) ? describeStructuredData(structured) : undefined,
    extraction !== undefined && touchesAeo ? describeExtractionForAgent(extraction) : undefined,
  ].filter((part): part is string => part !== undefined);
  return {
    kind: 'seo',
    title,
    message: [describeFindingsForAgent(metadata, findings), ...extras].join('\n\n'),
  };
}

/** Dispatches to the shape each network actually renders. */
function renderNetworkCard(card: NetworkCard, rich: RichResult): HTMLElement {
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
      return renderGoogle(card, rich);
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

/**
 * The one card the page's JSON-LD changes. Everything the schema adds — the
 * trail, the stars, the price, the questions — appears only here, which is why
 * a preview that ignores structured data shows a result nobody will get.
 */
function renderGoogle(card: NetworkCard, rich: RichResult): HTMLElement {
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
  const trail = rich.breadcrumbs === undefined
    ? breadcrumb(card)
    : [card.domain, ...rich.breadcrumbs].join(' › ');
  names.append(
    line('gg-site-name', rich.siteName ?? card.siteName ?? card.domain),
    line('gg-url', trail),
  );
  site.append(badge, names);
  frame.append(site, line('gg-title', card.title));

  const facts = element('div', 'gg-facts');
  if (rich.rating !== undefined) {
    const stars = element('span', 'gg-stars');
    stars.textContent = starsFor(rich.rating.value, rich.rating.best);
    const score = element('span', 'gg-score');
    score.textContent = rich.rating.count === undefined
      ? `${rich.rating.value}`
      : `${rich.rating.value} (${rich.rating.count})`;
    facts.append(stars, score);
  }
  if (rich.offer?.price !== undefined) {
    const price = element('span', 'gg-price');
    price.textContent = `${currencySymbol(rich.offer.currency)}${rich.offer.price}`;
    facts.append(price);
  }
  if (rich.offer?.availability !== undefined) {
    const stock = element('span', 'gg-stock');
    stock.textContent = humanizeAvailability(rich.offer.availability);
    facts.append(stock);
  }
  if (rich.datePublished !== undefined || rich.author !== undefined) {
    const byline = element('span', 'gg-byline');
    byline.textContent = [formatDate(rich.datePublished), rich.author].filter(Boolean).join(' — ');
    facts.append(byline);
  }
  if (facts.childElementCount > 0) frame.append(facts);

  frame.append(line('gg-text', card.description));

  if (rich.faq !== undefined) {
    const faq = element('div', 'gg-faq');
    for (const entry of rich.faq.slice(0, 3)) {
      const row = document.createElement('details');
      row.className = 'gg-faq-row';
      const summary = document.createElement('summary');
      summary.textContent = entry.question;
      const answer = element('p', 'gg-faq-answer');
      answer.textContent = entry.answer;
      row.append(summary, answer);
      faq.append(row);
    }
    frame.append(faq);
  }
  return frame;
}

function starsFor(value: number, best: number): string {
  const scaled = Math.max(0, Math.min(5, best === 0 ? 0 : (value / best) * 5));
  const full = Math.floor(scaled);
  const half = scaled - full >= 0.5 ? 1 : 0;
  return `${'★'.repeat(full)}${half === 1 ? '⯨' : ''}${'☆'.repeat(Math.max(0, 5 - full - half))}`;
}

function currencySymbol(currency?: string): string {
  const symbols: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹' };
  if (currency === undefined) return '';
  return symbols[currency.toUpperCase()] ?? `${currency} `;
}

function humanizeAvailability(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (character) => character.toUpperCase());
}

function formatDate(value?: string): string {
  if (value === undefined) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
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

const PANES = ['previews', 'issues', 'schema', 'aeo', 'tags'] as const;

const PANE_LABELS: Record<PaneId, string> = {
  previews: 'Previews',
  issues: 'Issues',
  schema: 'Schema',
  aeo: 'AEO',
  tags: 'Tags',
};

function paneLabel(pane: PaneId, count: number): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const label = document.createElement('span');
  label.textContent = PANE_LABELS[pane];
  fragment.append(label);
  if (count > 0) {
    const badge = element('span', 'seo-tab-count');
    badge.textContent = String(count);
    fragment.append(badge);
  }
  return fragment;
}

/**
 * Draws an entity the way the top platform shows that type.
 *
 * A Product is a thing with a price and a rating; an Article is a thing with a
 * byline and a date. Rendering each as the result it produces is the difference
 * between reading your schema and seeing it. A type with no shape of its own
 * falls back to labelled rows rather than being guessed at.
 */
function renderEntityCard(view: EntityView): HTMLElement {
  const frame = element('article', 'entity-card');
  frame.dataset.type = view.type;

  const label = element('div', 'entity-label');
  const badge = element('span', 'entity-badge');
  badge.textContent = view.label;
  label.append(badge);
  frame.append(label);

  switch (view.type) {
    case 'Product':
      frame.append(renderProductEntity(view));
      break;
    case 'Article':
      frame.append(renderArticleEntity(view));
      break;
    case 'Recipe':
      frame.append(renderRecipeEntity(view));
      break;
    case 'Event':
      frame.append(renderEventEntity(view));
      break;
    case 'VideoObject':
      frame.append(renderVideoEntity(view));
      break;
    case 'FAQPage':
    case 'QAPage':
      frame.append(renderFaqEntity(view));
      break;
    case 'BreadcrumbList':
      frame.append(renderBreadcrumbEntity(view));
      break;
    case 'Organization':
    case 'LocalBusiness':
      frame.append(renderOrganizationEntity(view));
      break;
    default:
      frame.append(renderGenericEntity(view));
  }
  return frame;
}

function entityThumb(view: EntityView, className = 'entity-thumb'): HTMLElement {
  if (view.image === undefined) {
    const placeholder = element('div', `${className} seo-image-missing`);
    placeholder.textContent = 'no image';
    return placeholder;
  }
  const wrapper = element('div', className);
  const image = document.createElement('img');
  image.src = view.image;
  image.alt = '';
  image.loading = 'lazy';
  image.addEventListener('error', () => {
    wrapper.classList.add('seo-image-missing');
    wrapper.textContent = 'image failed';
  });
  wrapper.append(image);
  return wrapper;
}

function entityName(view: EntityView): HTMLElement {
  const name = element('strong', 'entity-name');
  name.textContent = view.name ?? '(no name)';
  if (view.name === undefined) name.dataset.missing = 'true';
  return name;
}

function renderProductEntity(view: EntityView): HTMLElement {
  const row = element('div', 'entity-row');
  const body = element('div', 'entity-body');
  body.append(entityName(view));
  if (view.rating !== undefined) {
    const rating = element('div', 'entity-rating');
    const stars = element('span', 'gg-stars');
    stars.textContent = starsFor(view.rating.value, view.rating.best);
    const score = element('span', 'gg-score');
    score.textContent = view.rating.count === undefined
      ? `${view.rating.value}`
      : `${view.rating.value} (${view.rating.count})`;
    rating.append(stars, score);
    body.append(rating);
  }
  const priceRow = element('div', 'entity-price-row');
  if (view.offer?.price !== undefined) {
    const price = element('span', 'entity-price');
    price.textContent = `${currencySymbol(view.offer.currency)}${view.offer.price}`;
    priceRow.append(price);
  } else {
    priceRow.append(missingChip('no price'));
  }
  if (view.offer?.availability !== undefined) {
    const stock = element('span', 'entity-stock');
    stock.textContent = humanizeAvailability(view.offer.availability);
    priceRow.append(stock);
  }
  body.append(priceRow);
  const meta = [view.brand, view.sku].filter((part): part is string => part !== undefined);
  if (meta.length > 0) body.append(line('entity-meta', meta.join(' · ')));
  row.append(entityThumb(view), body);
  return row;
}

function renderArticleEntity(view: EntityView): HTMLElement {
  const row = element('div', 'entity-row');
  const body = element('div', 'entity-body');
  body.append(entityName(view));
  if (view.description !== undefined) body.append(line('entity-text', view.description));
  const byline = element('div', 'entity-byline');
  if (view.author === undefined) byline.append(missingChip('no author'));
  else byline.append(textSpan(view.author));
  if (view.datePublished !== undefined) byline.append(textSpan(formatDate(view.datePublished)));
  if (view.publisher !== undefined) byline.append(textSpan(view.publisher));
  body.append(byline);
  row.append(entityThumb(view), body);
  return row;
}

function renderRecipeEntity(view: EntityView): HTMLElement {
  const row = element('div', 'entity-row');
  const body = element('div', 'entity-body');
  body.append(entityName(view));
  const facts = element('div', 'entity-byline');
  if (view.rating !== undefined) {
    const stars = element('span', 'gg-stars');
    stars.textContent = starsFor(view.rating.value, view.rating.best);
    facts.append(stars);
  }
  if (view.duration !== undefined) facts.append(textSpan(view.duration));
  if (view.author !== undefined) facts.append(textSpan(view.author));
  body.append(facts);
  row.append(entityThumb(view), body);
  return row;
}

function renderEventEntity(view: EntityView): HTMLElement {
  const row = element('div', 'entity-row');
  const when = element('div', 'entity-date');
  const date = view.startDate === undefined ? undefined : new Date(view.startDate);
  if (date !== undefined && !Number.isNaN(date.getTime())) {
    const month = element('span', 'entity-date-month');
    month.textContent = date.toLocaleDateString(undefined, { month: 'short' }).toUpperCase();
    const day = element('span', 'entity-date-day');
    day.textContent = String(date.getDate());
    when.append(month, day);
  } else {
    when.dataset.missing = 'true';
    when.textContent = '—';
  }
  const body = element('div', 'entity-body');
  body.append(entityName(view));
  const facts = element('div', 'entity-byline');
  if (view.location === undefined) facts.append(missingChip('no venue'));
  else facts.append(textSpan(view.location));
  if (view.offer?.price !== undefined) {
    facts.append(textSpan(`${currencySymbol(view.offer.currency)}${view.offer.price}`));
  }
  body.append(facts);
  row.append(when, body);
  return row;
}

function renderVideoEntity(view: EntityView): HTMLElement {
  const row = element('div', 'entity-row');
  const thumb = entityThumb(view, 'entity-thumb entity-thumb-wide');
  if (view.duration !== undefined) {
    const duration = element('span', 'entity-duration');
    duration.textContent = view.duration;
    thumb.append(duration);
  }
  const body = element('div', 'entity-body');
  body.append(entityName(view));
  const facts = element('div', 'entity-byline');
  if (view.datePublished !== undefined) facts.append(textSpan(formatDate(view.datePublished)));
  if (view.description !== undefined) body.append(line('entity-text', view.description));
  body.append(facts);
  row.append(thumb, body);
  return row;
}

function renderFaqEntity(view: EntityView): HTMLElement {
  const list = element('div', 'entity-faq');
  for (const entry of view.faq ?? []) {
    const row = document.createElement('details');
    row.className = 'gg-faq-row';
    const summary = document.createElement('summary');
    summary.textContent = entry.question;
    const answer = element('p', 'gg-faq-answer');
    if (entry.answer === '') {
      answer.dataset.missing = 'true';
      answer.textContent = 'This question has no answer, which can cost the whole set.';
    } else {
      answer.textContent = entry.answer;
    }
    row.append(summary, answer);
    list.append(row);
  }
  if (list.childElementCount === 0) list.append(emptyNote('No questions in this block.'));
  return list;
}

function renderBreadcrumbEntity(view: EntityView): HTMLElement {
  const trail = element('div', 'entity-trail');
  const crumbs = view.breadcrumbs ?? [];
  for (const [index, crumb] of crumbs.entries()) {
    const step = element('span', 'entity-crumb');
    step.textContent = crumb.name;
    if (crumb.url === undefined && index < crumbs.length - 1) step.dataset.missing = 'true';
    trail.append(step);
    if (index < crumbs.length - 1) {
      const separator = element('span', 'entity-crumb-sep');
      separator.textContent = '›';
      trail.append(separator);
    }
  }
  if (crumbs.length === 0) trail.append(emptyNote('No crumbs in this list.'));
  return trail;
}

function renderOrganizationEntity(view: EntityView): HTMLElement {
  const row = element('div', 'entity-row');
  const logo = element('div', 'entity-logo');
  if (view.image === undefined) {
    logo.classList.add('seo-image-missing');
    logo.textContent = '—';
  } else {
    const image = document.createElement('img');
    image.src = view.image;
    image.alt = '';
    logo.append(image);
  }
  const body = element('div', 'entity-body');
  body.append(entityName(view));
  const facts = element('div', 'entity-byline');
  if (view.url !== undefined) facts.append(textSpan(view.url.replace(/^https?:\/\//, '')));
  if (view.address !== undefined) facts.append(textSpan(view.address));
  if (view.telephone !== undefined) facts.append(textSpan(view.telephone));
  body.append(facts);
  if (view.sameAs !== undefined) {
    const links = element('div', 'entity-sameas');
    for (const link of view.sameAs.slice(0, 4)) {
      const chip = element('span', 'entity-link');
      chip.textContent = link.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] ?? link;
      chip.title = link;
      links.append(chip);
    }
    body.append(links);
  }
  row.append(logo, body);
  return row;
}

function renderGenericEntity(view: EntityView): HTMLElement {
  const body = element('div', 'entity-body');
  body.append(entityName(view));
  if (view.description !== undefined) body.append(line('entity-text', view.description));
  const rows = [
    view.url === undefined ? undefined : { label: 'url', value: view.url },
    ...view.fields.slice(0, 8),
  ].filter((row): row is { label: string; value: string } => row !== undefined);
  if (rows.length > 0) {
    const table = element('dl', 'entity-fields');
    for (const row of rows) {
      const label = document.createElement('dt');
      label.textContent = row.label;
      const value = document.createElement('dd');
      value.textContent = row.value;
      table.append(label, value);
    }
    body.append(table);
  }
  return body;
}

function textSpan(text: string): HTMLElement {
  const node = document.createElement('span');
  node.textContent = text;
  return node;
}

function missingChip(text: string): HTMLElement {
  const chip = element('span', 'entity-missing');
  chip.textContent = text;
  return chip;
}

function sectionTitle(text: string, className = 'aeo-title'): HTMLElement {
  const title = element('h3', className);
  title.textContent = text;
  return title;
}

function emptyNote(text: string): HTMLElement {
  const note = element('p', 'aeo-empty');
  note.textContent = text;
  return note;
}

function stat(label: string, value: string, tone?: 'good' | 'bad'): HTMLElement {
  const frame = element('div', 'aeo-stat');
  if (tone !== undefined) frame.dataset.tone = tone;
  const name = element('span', 'aeo-stat-label');
  name.textContent = label;
  const reading = element('strong', 'aeo-stat-value');
  reading.textContent = value;
  frame.append(name, reading);
  return frame;
}

/** Re-indents a block so a one-line minified script is still readable. */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function severityRank(level: SeoFinding['level']): number {
  return level === 'error' ? 0 : level === 'warning' ? 1 : 2;
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
    .gg-facts { align-items: center; color: #4d5156; display: flex; flex-wrap: wrap; font-size: 13px; gap: 4px 10px; margin-bottom: 3px; }
    .gg-stars { color: #e7711b; letter-spacing: -.5px; }
    .gg-score { color: #70757a; }
    .gg-price { color: #202124; font-weight: 700; }
    .gg-stock { color: #0d652d; }
    .gg-byline { color: #70757a; }
    .gg-faq { border-top: 1px solid #ecedef; margin-top: 8px; }
    .gg-faq-row { border-bottom: 1px solid #ecedef; }
    .gg-faq-row summary { color: #202124; cursor: pointer; font-size: 14px; list-style: none; padding: 8px 0; }
    .gg-faq-row summary::-webkit-details-marker { display: none; }
    .gg-faq-row summary::after { color: #70757a; content: '⌄'; float: right; }
    .gg-faq-row[open] summary::after { content: '⌃'; }
    .gg-faq-answer { color: #4d5156; font-size: 13px; margin: 0 0 9px; }

    .schema-summary { color: #aeb7c5; font-size: 12px; margin: 0 0 14px; }
    .schema-block { background: #12161d; border: 1px solid #272e39; border-left-width: 3px; border-radius: 9px; display: grid; gap: 9px; margin-bottom: 10px; padding: 12px 14px; }
    .schema-block[data-state='parsed'] { border-left-color: #22c55e; }
    .schema-block[data-state='invalid'] { border-left-color: #ef4444; }
    .schema-block-head { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; }
    .schema-index { color: #7f8998; font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
    .schema-type { background: #1b2350; border: 1px solid #4f46a5; border-radius: 5px; color: #ddd6fe; font: 700 11px/1.4 ui-sans-serif, system-ui, sans-serif; padding: 2px 7px; }
    .schema-context { color: #7f8998; font: 10px/1.5 ui-monospace, SFMono-Regular, monospace; margin-left: auto; }
    .schema-error { color: #fda4af; font: 11px/1.5 ui-monospace, SFMono-Regular, monospace; margin: 0; overflow-wrap: anywhere; }
    .entity-card { background: #0b0e14; border: 1px solid #262e39; border-radius: 8px; display: grid; gap: 9px; padding: 11px 12px; }
    .entity-label { align-items: center; display: flex; gap: 7px; }
    .entity-badge { background: #0e4a5a; border: 1px solid #22d3ee; border-radius: 999px; color: #cffafe; font: 700 9px/1.4 ui-sans-serif, system-ui, sans-serif; letter-spacing: .06em; padding: 2px 8px; text-transform: uppercase; }
    .entity-row { display: grid; gap: 11px; grid-template-columns: auto minmax(0, 1fr); }
    .entity-body { display: grid; gap: 5px; min-width: 0; }
    .entity-name { color: #e8eaed; font-size: 14px; overflow-wrap: anywhere; }
    .entity-name[data-missing='true'] { color: #fda4af; font-style: italic; }
    .entity-text { -webkit-box-orient: vertical; -webkit-line-clamp: 2; color: #98a2b1; display: -webkit-box; font-size: 12px; overflow: hidden; }
    .entity-thumb { aspect-ratio: 1; border-radius: 6px; flex: 0 0 auto; overflow: hidden; position: relative; width: 84px; }
    .entity-thumb-wide { aspect-ratio: 1.6; width: 128px; }
    .entity-thumb img { height: 100%; object-fit: cover; width: 100%; }
    .entity-duration { background: rgb(0 0 0 / .78); border-radius: 3px; bottom: 4px; color: #fff; font: 600 9px/1.4 ui-sans-serif, system-ui, sans-serif; padding: 1px 4px; position: absolute; right: 4px; }
    .entity-rating, .entity-price-row, .entity-byline { align-items: center; display: flex; flex-wrap: wrap; gap: 4px 9px; }
    .entity-byline { color: #8c94a3; font-size: 11px; }
    .entity-price { color: #f8fafc; font-size: 15px; font-weight: 700; }
    .entity-stock { color: #86efac; font-size: 11px; }
    .entity-meta { color: #7f8998; font-size: 11px; }
    .entity-missing { background: #35191d; border: 1px solid #713039; border-radius: 4px; color: #fda4af; font: 700 9px/1.4 ui-sans-serif, system-ui, sans-serif; padding: 2px 6px; }
    .entity-date { align-items: center; background: #151b23; border: 1px solid #2d3440; border-radius: 7px; display: grid; height: 58px; justify-items: center; width: 58px; }
    .entity-date[data-missing='true'] { border-color: #713039; color: #fda4af; }
    .entity-date-month { color: #fda4af; font: 700 9px/1.4 ui-sans-serif, system-ui, sans-serif; letter-spacing: .08em; }
    .entity-date-day { color: #e8eaed; font: 700 20px/1 ui-sans-serif, system-ui, sans-serif; }
    .entity-logo { align-items: center; background: #151b23; border: 1px solid #2d3440; border-radius: 50%; display: flex; height: 52px; justify-content: center; overflow: hidden; width: 52px; }
    .entity-logo img { height: 60%; object-fit: contain; width: 60%; }
    .entity-trail { align-items: center; color: #d9dce3; display: flex; flex-wrap: wrap; font-size: 12px; gap: 5px; }
    .entity-crumb[data-missing='true'] { color: #fcd34d; text-decoration: underline dotted; }
    .entity-crumb-sep { color: #6b7280; }
    .entity-sameas { display: flex; flex-wrap: wrap; gap: 5px; }
    .entity-link { background: #1d2330; border: 1px solid #343d4a; border-radius: 4px; color: #a5f3fc; font: 10px/1.5 ui-monospace, SFMono-Regular, monospace; padding: 1px 6px; }
    .entity-fields { display: grid; gap: 3px 12px; grid-template-columns: minmax(80px, auto) minmax(0, 1fr); margin: 3px 0 0; }
    .entity-fields dt { color: #7f8998; font: 10px/1.6 ui-monospace, SFMono-Regular, monospace; }
    .entity-fields dd { color: #d9dce3; font-size: 11px; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .entity-faq .gg-faq-row { border-bottom-color: #262e39; }
    .entity-faq .gg-faq-row summary { color: #d9dce3; font-size: 12px; }
    .entity-faq .gg-faq-answer { color: #98a2b1; font-size: 11px; }
    .entity-faq .gg-faq-answer[data-missing='true'] { color: #fda4af; font-style: italic; }

    .aeo-intro { color: #aeb7c5; font-size: 12px; margin: 0 0 16px; max-width: 70ch; }
    .aeo-block { background: #12161d; border: 1px solid #272e39; border-radius: 10px; margin-bottom: 16px; padding: 14px 16px; }
    .aeo-title { color: #f8fafc; font-size: 12px; letter-spacing: .05em; margin: 0 0 11px; text-transform: uppercase; }
    .aeo-subtitle { color: #8c94a3; font-size: 10px; letter-spacing: .07em; margin: 16px 0 8px; text-transform: uppercase; }
    .aeo-subject { align-items: center; background: #0b0e14; border: 1px solid #262e39; border-radius: 8px; display: flex; flex-wrap: wrap; gap: 9px; margin-bottom: 12px; padding: 10px 12px; }
    .aeo-subject[data-state='missing'] { border-color: #78551c; color: #fcd34d; font-size: 12px; }
    .aeo-subject-type { background: #0e4a5a; border: 1px solid #22d3ee; border-radius: 999px; color: #cffafe; font: 700 9px/1.4 ui-sans-serif, system-ui, sans-serif; letter-spacing: .06em; padding: 2px 8px; text-transform: uppercase; }
    .aeo-subject-name { color: #e8eaed; font-size: 14px; }
    .aeo-facts { display: grid; gap: 4px 14px; grid-template-columns: minmax(90px, auto) minmax(0, 1fr); margin: 0; }
    .aeo-facts dt { color: #7f8998; font-size: 11px; }
    .aeo-facts dd { align-items: center; color: #e8eaed; display: flex; flex-wrap: wrap; font-size: 12px; gap: 7px; margin: 0; }
    .aeo-source { border-radius: 4px; font: 700 8px/1.5 ui-sans-serif, system-ui, sans-serif; letter-spacing: .06em; padding: 1px 5px; text-transform: uppercase; }
    .aeo-source[data-source='schema'] { background: #102c22; border: 1px solid #225b45; color: #86efac; }
    .aeo-source[data-source='meta'] { background: #1d2330; border: 1px solid #343d4a; color: #8c94a3; }
    .aeo-empty { color: #8c94a3; font-size: 11px; margin: 0; }
    .aeo-qa { border-left: 2px solid #343d4a; margin-bottom: 9px; padding-left: 10px; }
    .aeo-question { align-items: center; color: #d9dce3; display: flex; flex-wrap: wrap; font-size: 12px; gap: 7px; }
    .aeo-answer-text { color: #8c94a3; font-size: 11px; margin: 3px 0 0; }
    .aeo-stats { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); margin-top: 16px; }
    .aeo-stat { background: #0b0e14; border: 1px solid #262e39; border-radius: 7px; display: grid; gap: 3px; padding: 8px 10px; }
    .aeo-stat[data-tone='good'] { border-color: #225b45; }
    .aeo-stat[data-tone='bad'] { border-color: #713039; }
    .aeo-stat-label { color: #7f8998; font-size: 9px; letter-spacing: .06em; text-transform: uppercase; }
    .aeo-stat-value { color: #e8eaed; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .aeo-stat[data-tone='bad'] .aeo-stat-value { color: #fda4af; }
    .aeo-answer { background: #0b0e14; border: 1px solid #262e39; border-left-width: 3px; border-radius: 8px; padding: 12px 14px; }
    .aeo-answer[data-grounding='strong'] { border-left-color: #22c55e; }
    .aeo-answer[data-grounding='partial'] { border-left-color: #f59e0b; }
    .aeo-answer[data-grounding='thin'] { border-left-color: #ef4444; }
    .aeo-sentence { color: #e8eaed; font-size: 14px; line-height: 1.5; margin: 0; }
    .aeo-cite { align-items: center; display: flex; gap: 10px; margin-top: 9px; }
    .aeo-cite-source { color: #7dd3fc; font-size: 11px; }
    .aeo-grounding { color: #7f8998; font-size: 10px; letter-spacing: .05em; text-transform: uppercase; }
    .aeo-caveat { color: #7f8998; font-size: 11px; margin: 11px 0 0; max-width: 70ch; }
    .aeo-findings-note { color: #aeb7c5; font-size: 12px; margin: 0; }
    .schema-source summary { color: #8c94a3; cursor: pointer; font-size: 11px; }
    .schema-source pre { background: #090c11; border: 1px solid #303744; border-radius: 7px; color: #dbeafe; font: 10px/1.5 ui-monospace, SFMono-Regular, monospace; margin: 8px 0 0; max-height: 320px; overflow: auto; padding: 10px; }
    .seo-clean-mark[data-tone='neutral'] { background: #1d2330; border-color: #343d4a; color: #c4b5fd; font: 700 15px/1 ui-monospace, SFMono-Regular, monospace; }

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
