import type { AgentExternalContext } from '../shared/protocol.js';

type DiagnosticActionCallbacks = {
  onFix(context: AgentExternalContext): void;
};

type AuditEntry = {
  auditedElement?: Element;
  rule?: { title?: string; message?: string; description?: string };
  card?: HTMLElement & { shadowRoot: ShadowRoot | null };
};

type AuditWindow = HTMLElement & { audits?: AuditEntry[] };

const ACTION_ATTRIBUTE = 'data-astro-ai-fix-action';

/**
 * Feature-detected bridge to development diagnostics owned by Vite and Astro.
 * Both surfaces use open shadow roots in the supported Astro version. If that
 * internal structure changes, scans simply find nothing and leave the host UI
 * untouched.
 */
export class DiagnosticActionBridge {
  readonly #callbacks: DiagnosticActionCallbacks;
  readonly #observer: MutationObserver;
  readonly #actions = new Set<HTMLButtonElement>();

  constructor(callbacks: DiagnosticActionCallbacks) {
    this.#callbacks = callbacks;
    this.#observer = new MutationObserver(() => this.scan());
    this.#observer.observe(document.documentElement, { childList: true, subtree: true });
    this.scan();
  }

  scan(): void {
    this.#scanViteErrors();
    this.#scanAstroAudits();
  }

  destroy(): void {
    this.#observer.disconnect();
    for (const action of this.#actions) action.remove();
    this.#actions.clear();
  }

  #scanViteErrors(): void {
    for (const overlay of document.querySelectorAll<HTMLElement>('vite-error-overlay')) {
      const root = overlay.shadowRoot;
      const windowElement = root?.querySelector<HTMLElement>('.window');
      if (root == null || windowElement == null || root.querySelector(`[${ACTION_ATTRIBUTE}]`) !== null) {
        continue;
      }
      const title = root.querySelector('.message-body')?.textContent?.trim() || 'Development error';
      const rawFile = root.querySelector('.file')?.textContent?.trim();
      const source = parseSourceReference(rawFile);
      const frame = root.querySelector('.frame')?.textContent?.trim();
      const message = [title, frame].filter(Boolean).join('\n\n');
      const action = this.#createAction('error', () => {
        this.#callbacks.onFix({
          kind: 'error',
          title,
          message,
          ...(source.file === undefined ? {} : { file: normalizeProjectFile(source.file) }),
          ...(source.line === undefined ? {} : { line: source.line }),
        });
      });
      windowElement.insertBefore(action, windowElement.querySelector('.tip'));
    }
  }

  #scanAstroAudits(): void {
    const toolbar = document.querySelector<HTMLElement>('astro-dev-toolbar');
    const toolbarRoot = toolbar?.shadowRoot;
    const auditCanvas = toolbarRoot?.querySelector<HTMLElement>(
      'astro-dev-toolbar-app-canvas[data-app-id="astro:audit"]',
    );
    const auditWindow = auditCanvas?.shadowRoot?.querySelector<AuditWindow>(
      'astro-dev-toolbar-audit-window',
    );
    for (const audit of auditWindow?.audits ?? []) {
      const root = audit.card?.shadowRoot;
      const detail = root?.querySelector<HTMLElement>('.extended-info');
      if (root == null || detail == null || root.querySelector(`[${ACTION_ATTRIBUTE}]`) !== null) {
        continue;
      }
      const title = audit.rule?.title ?? detail.querySelector('.audit-title')?.textContent?.trim() ?? 'Audit issue';
      const message = [
        audit.rule?.message ?? detail.querySelector('.audit-message')?.textContent?.trim(),
        audit.rule?.description ?? detail.querySelector('.audit-description')?.textContent?.trim(),
      ].filter(Boolean).join('\n\n');
      const source = parseSourceReference(
        audit.auditedElement?.getAttribute('data-astro-ai-source') ?? undefined,
      );
      const action = this.#createAction('audit', () => {
        this.#callbacks.onFix({
          kind: 'audit',
          title,
          message: message || title,
          ...(source.file === undefined ? {} : { file: source.file }),
          ...(source.line === undefined ? {} : { line: source.line }),
        });
      });
      detail.append(action);
    }
  }

  #createAction(kind: 'error' | 'audit', onClick: () => void): HTMLButtonElement {
    const action = document.createElement('button');
    action.setAttribute(ACTION_ATTRIBUTE, kind);
    action.type = 'button';
    action.textContent = '✦ Fix with AI';
    Object.assign(action.style, {
      background: kind === 'error' ? '#7f1d1d' : '#4c1d95',
      border: `1px solid ${kind === 'error' ? '#ef4444' : '#8b5cf6'}`,
      borderRadius: '7px',
      color: '#fff',
      cursor: 'pointer',
      display: 'inline-flex',
      font: '600 13px/1.2 ui-sans-serif, system-ui, sans-serif',
      margin: '12px 0',
      padding: '9px 12px',
    });
    action.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    this.#actions.add(action);
    return action;
  }
}

export function parseSourceReference(value?: string): { file?: string; line?: number } {
  if (value === undefined || value.trim() === '') return {};
  const match = value.trim().match(/^(.*?):(\d+)(?::\d+)?$/);
  if (match === null) return { file: value.trim() };
  const file = match[1]?.trim();
  const line = match[2] === undefined ? undefined : Number(match[2]);
  return {
    ...(file === undefined || file === '' ? {} : { file }),
    ...(line === undefined || !Number.isFinite(line) ? {} : { line }),
  };
}

function normalizeProjectFile(file: string): string {
  const root = (window as Window & { __astro_dev_toolbar__?: { root?: string } })
    .__astro_dev_toolbar__?.root;
  if (root === undefined) return file;
  const normalizedRoot = root.endsWith('/') ? root : `${root}/`;
  return file.startsWith(normalizedRoot) ? file.slice(normalizedRoot.length) : file;
}
