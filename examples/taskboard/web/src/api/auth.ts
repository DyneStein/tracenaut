import { request } from './client';

export type User = { id: number; email: string; name: string };

export async function login(email: string, password: string): Promise<User> {
  const { user } = await request<{ user: User }>('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  return user;
}

export async function logout(): Promise<void> {
  await request('/auth/logout', { method: 'POST' });
}

export async function fetchCurrentUser(): Promise<User | null> {
  try {
    const { user } = await request<{ user: User }>('/auth/me');
    return user;
  } catch {
    return null;
  }
}
