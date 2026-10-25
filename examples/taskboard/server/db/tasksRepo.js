import { db } from './index.js';

export function listTasksForUser(userId) {
  return db
    .prepare('SELECT id, title, done, created_at FROM tasks WHERE user_id = ? ORDER BY created_at DESC, id DESC')
    .all(userId);
}

export function insertTask(userId, title) {
  const result = db.prepare('INSERT INTO tasks (user_id, title) VALUES (?, ?)').run(userId, title);
  return db.prepare('SELECT id, title, done, created_at FROM tasks WHERE id = ?').get(result.lastInsertRowid);
}

export function setTaskDone(userId, taskId, done) {
  const result = db
    .prepare('UPDATE tasks SET done = ? WHERE id = ? AND user_id = ?')
    .run(done ? 1 : 0, taskId, userId);
  return result.changes > 0;
}

export function deleteTask(userId, taskId) {
  const result = db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(taskId, userId);
  return result.changes > 0;
}
