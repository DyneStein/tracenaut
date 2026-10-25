import { request } from './client';

export type Task = { id: number; title: string; done: boolean; createdAt: string };

export async function listTasks(): Promise<Task[]> {
  const { tasks } = await request<{ tasks: Task[] }>('/tasks');
  return tasks;
}

export async function createTask(title: string): Promise<Task> {
  const { task } = await request<{ task: Task }>('/tasks', { method: 'POST', body: { title } });
  return task;
}

export async function setTaskDone(id: number, done: boolean): Promise<void> {
  await request(`/tasks/${id}`, { method: 'PATCH', body: { done } });
}

export async function deleteTask(id: number): Promise<void> {
  await request(`/tasks/${id}`, { method: 'DELETE' });
}
