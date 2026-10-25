import { useCallback, useEffect, useState } from 'react';
import * as tasksApi from '../api/tasks';
import type { Task } from '../api/tasks';

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setTasks(await tasksApi.listTasks());
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function addTask(title: string) {
    const task = await tasksApi.createTask(title);
    setTasks((current) => [task, ...current]);
  }

  async function toggleTask(task: Task) {
    await tasksApi.setTaskDone(task.id, !task.done);
    setTasks((current) => current.map((t) => (t.id === task.id ? { ...t, done: !t.done } : t)));
  }

  async function removeTask(task: Task) {
    await tasksApi.deleteTask(task.id);
    setTasks((current) => current.filter((t) => t.id !== task.id));
  }

  return { tasks, loading, addTask, toggleTask, removeTask };
}
