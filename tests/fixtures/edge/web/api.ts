let base = '/api';

export function setBase(next: string) {
  base = next;
}

export async function dynamicUrl(id: string) {
  // `base` is mutable, so the prefix must stay symbolic.
  return fetch(`${base}/items/${id}`);
}

export async function literal() {
  return fetch('/api/items', { method: 'POST' });
}

export async function computedMethod(method: string) {
  return fetch('/api/items', { method });
}

function fetchLike(url: string) {
  return url.length;
}

export function notHttp() {
  // A user function that happens to be called like fetch is not an HTTP request.
  return fetchLike('/api/items');
}

export function cacheLookup(cache: Map<string, number>) {
  return cache.get('/api/items');
}
