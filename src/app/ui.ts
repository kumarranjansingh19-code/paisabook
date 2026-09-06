import { escapeHtml } from '../core/text';
import { formatPaise } from '../core/money';
import { categoryLabel } from '../core/categories';

/** Tagged template that escapes interpolations unless they are marked raw(). */
export class Raw {
  constructor(public s: string) {}
}
export const raw = (s: string): Raw => new Raw(s);
export function html(strings: TemplateStringsArray, ...vals: unknown[]): string {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) {
      const v = vals[i];
      if (v instanceof Raw) out += v.s;
      else if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.s : escapeHtml(x))).join('');
      else if (v === false || v === null || v === undefined) out += '';
      else out += escapeHtml(v);
    }
  });
  return out;
}

export const money = (p: number, compact = false): string => formatPaise(p, { compact });

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, inner = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.innerHTML = inner;
  return e;
}

export function $<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T {
  const n = root.querySelector<T>(sel);
  if (!n) throw new Error(`missing element ${sel}`);
  return n;
}
export function $$<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll<T>(sel)];
}

/** Delegated click handler by data-action attribute. */
export function onAction(root: HTMLElement, handlers: Record<string, (el: HTMLElement, ev: Event) => void | Promise<void>>): void {
  root.addEventListener('click', (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target || !root.contains(target)) return;
    const fn = handlers[target.dataset.action!];
    if (!fn) return;
    ev.preventDefault();
    const p = fn(target, ev);
    if (p && typeof (p as Promise<void>).catch === 'function') {
      (p as Promise<void>).catch((err) => toast(String((err as Error).message ?? err), 'error'));
    }
  });
}

let toastTimer: number | undefined;
export function toast(msg: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
  let box = document.getElementById('toast');
  if (!box) {
    box = el('div', { id: 'toast' });
    document.body.appendChild(box);
  }
  box.textContent = msg;
  box.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => box!.classList.remove('show'), kind === 'error' ? 7000 : 3500);
}

/** Simple modal; resolves with the form values or null when dismissed. */
export function modal(inner: string, opts: { title?: string; submit?: string; cancel?: string; wide?: boolean } = {}): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const wrap = el('div', { class: 'modal-backdrop' });
    wrap.innerHTML = html`
      <form class="modal ${opts.wide ? 'wide' : ''}">
        ${opts.title ? raw(`<h3>${escapeHtml(opts.title)}</h3>`) : ''}
        <div class="modal-body">${raw(inner)}</div>
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-close>${opts.cancel ?? 'Cancel'}</button>
          ${opts.submit === '' ? '' : raw(`<button type="submit" class="btn primary">${escapeHtml(opts.submit ?? 'Save')}</button>`)}
        </div>
      </form>`;
    const form = wrap.querySelector('form')!;
    const close = (v: Record<string, string> | null) => {
      wrap.remove();
      resolve(v);
    };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) close(null);
    });
    form.querySelector('[data-close]')!.addEventListener('click', () => close(null));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const data: Record<string, string> = {};
      new FormData(form).forEach((v, k) => (data[k] = String(v)));
      close(data);
    });
    document.body.appendChild(wrap);
    (form.querySelector('input,select,textarea') as HTMLElement | null)?.focus();
  });
}

export async function confirmDialog(msg: string, submit = 'Yes'): Promise<boolean> {
  return (await modal(`<p>${escapeHtml(msg)}</p>`, { submit })) !== null;
}

export function spinner(label = 'Working…'): string {
  return `<div class="spinner-row"><span class="spinner"></span> ${escapeHtml(label)}</div>`;
}

export function pct(a: number, b: number): number {
  return b ? Math.round((a / b) * 100) : 0;
}

export function catLabel(c: string): string {
  return categoryLabel(c);
}

export function categoryOptions(selected: string, categories: readonly string[]): string {
  return [`<option value="" ${!selected ? 'selected' : ''}>— uncategorized —</option>`]
    .concat(categories.map((c) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${escapeHtml(catLabel(c))}</option>`))
    .join('');
}

export function dateInput(name: string, value: string, extra = ''): string {
  return `<input type="date" name="${name}" value="${escapeHtml(value)}" ${extra} />`;
}

export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
