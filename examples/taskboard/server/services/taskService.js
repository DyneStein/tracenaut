import { listTasksForUser, insertTask, setTaskDone, deleteTask } from '../db/tasksRepo.js';

export class ValidationError extends Error {}

export function tasksFor(user) {
  return listTasksForUser(user.id).map(toDto);
}

export function createTask(user, rawTitle) {
  const title = validateTitle(rawTitle);
  return toDto(insertTask(user.id, title));
}

export function completeTask(user, taskId, done) {
  return setTaskDone(user.id, Number(taskId), Boolean(done));
}

export function removeTask(user, taskId) {
  return deleteTask(user.id, Number(taskId));
}

function validateTitle(rawTitle) {
  const title = String(rawTitle ?? '').trim();
  if (title.length === 0) throw new ValidationError('Title is required');
  if (title.length > 120) throw new ValidationError('Title must be 120 characters or fewer');
  return title;
}

function toDto(row) {
  return { id: row.id, title: row.title, done: row.done === 1, createdAt: row.created_at };
}
