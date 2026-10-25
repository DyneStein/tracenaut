import type { ChainEntry, InspectRequest } from '@tracenaut/protocol';

/**
 * Element → chain of source locations, innermost first.
 *
 * React adapter: walks the fiber tree from the element's fiber. `data-tn-loc` /
 * `data-tn-use` props were added at build time, so each entry is the exact JSX that
 * produced that fiber, and the runtime props tell us which handlers are attached.
 * DOM adapter (fallback / non-React): walks DOM ancestors carrying `data-tn-loc`.
 */

type Fiber = {
  type: unknown;
  memoizedProps?: Record<string, unknown> | null;
  return: Fiber | null;
};

const MAX_ENTRIES = 24;

function fiberOf(el: Element): Fiber | undefined {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
    if (key) return (node as unknown as Record<string, Fiber>)[key];
  }
  return undefined;
}

function componentName(type: unknown): string {
  if (typeof type === 'symbol') return type.description?.replace(/^react\./, '') ?? 'Component';
  if (typeof type === 'function') return (type as { displayName?: string; name?: string }).displayName || (type as { name: string }).name || 'Anonymous';
  if (type && typeof type === 'object') {
    const t = type as { displayName?: string; render?: unknown; type?: unknown; _context?: { displayName?: string } };
    if (t.displayName) return t.displayName;
    if (t.render) return componentName(t.render);
    if (t.type) return componentName(t.type);
  }
  return 'Component';
}

function handlersOf(props: Record<string, unknown>) {
  return Object.keys(props).filter((k) => /^on[A-Z]/.test(k) && typeof props[k] === 'function');
}

/** Handlers on the clicked element when no source location marks it (drawn by library code). */
function reactLeaf(el: Element): InspectRequest['leaf'] {
  const fiber = fiberOf(el);
  if (!fiber || typeof fiber.type !== 'string') return undefined;
  const props = fiber.memoizedProps ?? {};
  if (typeof props['data-tn-loc'] === 'string') return undefined;
  return { tag: fiber.type, runtimeHandlers: handlersOf(props) };
}

function reactChain(el: Element): ChainEntry[] | undefined {
  let fiber: Fiber | null | undefined = fiberOf(el);
  if (!fiber) return undefined;
  const chain: ChainEntry[] = [];
  while (fiber && chain.length < MAX_ENTRIES) {
    const props = fiber.memoizedProps ?? {};
    if (typeof fiber.type === 'string') {
      const loc = props['data-tn-loc'];
      if (typeof loc === 'string') chain.push({ type: 'host', name: fiber.type, loc, runtimeHandlers: handlersOf(props) });
    } else if (fiber.type) {
      const loc = props['data-tn-use'];
      if (typeof loc === 'string' && chain.at(-1)?.loc !== loc) chain.push({ type: 'component', name: componentName(fiber.type), loc });
    }
    fiber = fiber.return;
  }
  return chain;
}

function domChain(el: Element): ChainEntry[] {
  const chain: ChainEntry[] = [];
  for (let node: Element | null = el; node && chain.length < MAX_ENTRIES; node = node.parentElement) {
    const loc = node.getAttribute('data-tn-loc');
    if (loc) chain.push({ type: 'host', name: node.tagName.toLowerCase(), loc });
  }
  return chain;
}

const INTERESTING_ATTRS = ['type', 'name', 'role', 'aria-label', 'href', 'placeholder', 'id', 'class'];

export function describe(el: Element): InspectRequest {
  const react = reactChain(el);
  const attributes: Record<string, string> = {};
  for (const a of INTERESTING_ATTRS) {
    const v = el.getAttribute(a);
    if (v !== null) attributes[a] = v.slice(0, 120);
  }
  return {
    chain: react ?? domChain(el),
    adapter: react ? 'react' : 'dom',
    leaf: react ? reactLeaf(el) : undefined,
    element: {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80),
      attributes,
    },
  };
}

/** Innermost source location for an element (used to label a traced action). */
export function locate(el: Element): string | undefined {
  return describe(el).chain[0]?.loc;
}

/**
 * A simplified drawing of the inspected element, made from its live computed styles,
 * so the visual layer shows the real element rather than an invented one. Input values
 * are never read (only placeholders and labels).
 */
export interface ElementSnapshot {
  tag: string;
  kind: 'button' | 'input' | 'text' | 'box';
  label: string;
  background: string;
  color: string;
  radius: string;
  border: string;
  fontWeight: string;
  /** The page colour behind the element, so a see-through element stays readable when drawn. */
  backdrop: string;
}

/** First non-transparent background at or above `el` (crossing shadow-root boundaries). */
function backdropOf(el: Element): string {
  let cur: Element | null = el;
  for (let i = 0; cur && i < 25; i++) {
    const bg = getComputedStyle(cur).backgroundColor;
    if (!TRANSPARENT.test(bg)) return bg;
    cur = cur.parentElement ?? ((cur.getRootNode() as ShadowRoot).host ?? null);
  }
  return getComputedStyle(document.documentElement).backgroundColor || 'transparent';
}

const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;

export function snapshot(el: Element): ElementSnapshot {
  const cs = getComputedStyle(el);
  const tag = el.tagName.toLowerCase();
  const isInput = ['input', 'textarea', 'select'].includes(tag);
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
  const label = isInput
    ? el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || (el.getAttribute('type') === 'password' ? '••••••' : tag)
    : text || el.getAttribute('aria-label') || `<${tag}>`;
  const hasBg = !TRANSPARENT.test(cs.backgroundColor);
  const kind: ElementSnapshot['kind'] = isInput ? 'input' : tag === 'button' || el.getAttribute('role') === 'button' || (tag === 'a' && hasBg) ? 'button' : hasBg ? 'box' : 'text';
  const borderWidth = parseFloat(cs.borderTopWidth) || 0;
  return {
    tag,
    kind,
    label: label.length > 28 ? `${label.slice(0, 27)}…` : label,
    background: hasBg ? cs.backgroundColor : 'transparent',
    color: cs.color,
    radius: `${Math.min(parseFloat(cs.borderTopLeftRadius) || 0, 14)}px`,
    border: borderWidth ? `${Math.min(borderWidth, 2)}px solid ${cs.borderTopColor}` : 'none',
    fontWeight: cs.fontWeight,
    backdrop: hasBg ? cs.backgroundColor : backdropOf(el),
  };
}
