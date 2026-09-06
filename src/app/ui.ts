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

interface MdDialog extends HTMLElement {
  open: boolean;
  show(): void;
  close(returnValue?: string): void;
  returnValue: string;
}

/** Material dialog; resolves with the form values or null when dismissed. */
export function modal(inner: string, opts: { title?: string; submit?: string; cancel?: string; wide?: boolean } = {}): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement('md-dialog') as MdDialog;
    if (opts.wide) dialog.classList.add('wide');
    dialog.innerHTML = html`
      ${opts.title ? raw(`<div slot="headline">${escapeHtml(opts.title)}</div>`) : ''}
      <form slot="content" id="dlg-form" class="modal-body">${raw(inner)}</form>
      <div slot="actions">
        <md-text-button type="button" data-cancel>${opts.cancel ?? 'Cancel'}</md-text-button>
        ${opts.submit === '' ? '' : raw(`<md-filled-button type="button" data-ok>${escapeHtml(opts.submit ?? 'Save')}</md-filled-button>`)}
      </div>`;
    let result: Record<string, string> | null = null;
    const form = dialog.querySelector('form')!;
    const collect = () => {
      const data: Record<string, string> = {};
      new FormData(form).forEach((v, k) => (data[k] = String(v)));
      return data;
    };
    form.addEventListener('submit', (e) => {
      // Enter in a field: treat as OK
      e.preventDefault();
      if (!form.reportValidity()) return;
      result = collect();
      dialog.close('ok');
    });
    dialog.querySelector('[data-cancel]')!.addEventListener('click', () => dialog.close('cancel'));
    dialog.querySelector('[data-ok]')?.addEventListener('click', () => {
      if (!form.reportValidity()) return;
      result = collect();
      dialog.close('ok');
    });
    dialog.addEventListener('closed', () => {
      dialog.remove();
      resolve(dialog.returnValue === 'ok' ? result : null);
    });
    document.body.appendChild(dialog);
    dialog.show();
    setTimeout(() => (dialog.querySelector('md-outlined-text-field,md-outlined-select,input,textarea') as HTMLElement | null)?.focus(), 150);
  });
}

export async function confirmDialog(msg: string, submit = 'Yes'): Promise<boolean> {
  return (await modal(`<p>${escapeHtml(msg)}</p>`, { submit })) !== null;
}

export function spinner(label = 'Working…'): string {
  return `<div class="spinner-row"><md-circular-progress indeterminate style="--md-circular-progress-size:22px"></md-circular-progress> ${escapeHtml(label)}</div>`;
}

/**
 * Wrap a view's redraw so background data changes (a sync appending rows)
 * never wipe what the user is typing: while focus is inside a field in
 * `root`, the redraw is deferred until the field loses focus.
 */
export function deferWhileTyping(root: HTMLElement, draw: () => void): () => void {
  let pending = false;
  const typing = () => {
    const a = document.activeElement as HTMLElement | null;
    return !!a && root.contains(a) && /^(input|textarea|select|md-outlined-text-field|md-outlined-select|md-filled-text-field)$/i.test(a.tagName);
  };
  root.addEventListener('focusout', () => {
    if (!pending) return;
    setTimeout(() => {
      if (pending && !typing()) {
        pending = false;
        draw();
      }
    }, 150);
  });
  return () => {
    if (typing()) pending = true;
    else draw();
  };
}

export function pct(a: number, b: number): number {
  return b ? Math.round((a / b) * 100) : 0;
}

export function catLabel(c: string): string {
  return categoryLabel(c);
}

/** Options for a native <select> (used for the compact inline category chip). */
export function categoryOptions(selected: string, categories: readonly string[]): string {
  return [`<option value="" ${!selected ? 'selected' : ''}>— uncategorized —</option>`]
    .concat(categories.map((c) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${escapeHtml(catLabel(c))}</option>`))
    .join('');
}

/** Options for an <md-outlined-select>. */
export function mdOptions(items: Array<{ value: string; label: string }>, selected = ''): string {
  return items.map((o) => `<md-select-option value="${escapeHtml(o.value)}" ${o.value === selected ? 'selected' : ''}><div slot="headline">${escapeHtml(o.label)}</div></md-select-option>`).join('');
}

/** Material selects treat an empty value as "nothing chosen", so "uncategorized" is carried as NONE_VALUE. */
export const NONE_VALUE = '__none';
export function mdCategoryOptions(selected: string, categories: readonly string[], allowNone = true): string {
  const items = categories.map((c) => ({ value: c, label: catLabel(c) }));
  return mdOptions(allowNone ? [{ value: NONE_VALUE, label: '— uncategorized —' }, ...items] : items, selected || (allowNone ? NONE_VALUE : ''));
}
export const fromNone = (v: string | undefined): string => (!v || v === NONE_VALUE ? '' : v);

/** A checkbox row: Material checkbox + label text, form-associated under `name`. */
export function check(name: string, label: string, checked = false, extra = ''): string {
  return `<label class="check"><md-checkbox name="${name}" touch-target="wrapper" ${checked ? 'checked' : ''} ${extra}></md-checkbox><span>${label}</span></label>`;
}

export function spinnerInline(): string {
  return '<md-circular-progress indeterminate style="--md-circular-progress-size:20px"></md-circular-progress>';
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
