import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

function apiUrl(path: string) {
  return `${(globalThis as any).BASE ?? ''}${path}`;
}

function buildPath(path: string, params: Record<string, string> = {}) {
  const qs = new URLSearchParams(params).toString();
  return qs ? `${path}?${qs}` : path;
}

async function request(method: string, url: string, body?: string) {
  return fetch(url, { method, body, headers: { 'Content-Type': 'application/json' } });
}

export function httpGet(path: string, params: Record<string, string> = {}) {
  return request('GET', buildPath(apiUrl(path), params));
}

export function httpPost(path: string, data: object) {
  return request('POST', apiUrl(path), JSON.stringify(data));
}

export function loadItem(id: string) {
  return httpGet(`/api/items/${id}`, { expand: 'all' });
}

export function addItem(title: string) {
  return httpPost('/api/items', { title });
}

export function removeItem(id: string) {
  return api.delete(`/items/${id}`);
}

export function stats() {
  return axios.get('/api/stats');
}

export function legacy() {
  return axios({ method: 'post', url: '/api/legacy' });
}
