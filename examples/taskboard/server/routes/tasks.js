import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { tasksFor, createTask, completeTask, removeTask, ValidationError } from '../services/taskService.js';

export const tasksRouter = Router();

tasksRouter.use(requireAuth);

tasksRouter.get('/', listTasks);
tasksRouter.post('/', addTask);
tasksRouter.patch('/:id', updateTask);
tasksRouter.delete('/:id', deleteTaskHandler);

function listTasks(req, res) {
  res.json({ tasks: tasksFor(req.user) });
}

function addTask(req, res) {
  try {
    const task = createTask(req.user, req.body.title);
    res.status(201).json({ task });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
}

function updateTask(req, res) {
  const ok = completeTask(req.user, req.params.id, req.body.done);
  if (!ok) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json({ ok: true });
}

function deleteTaskHandler(req, res) {
  const ok = removeTask(req.user, req.params.id);
  res.status(ok ? 204 : 404).end();
}
