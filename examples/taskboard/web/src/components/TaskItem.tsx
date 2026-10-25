import type { Task } from '../api/tasks';
import { Button } from './Button';

type TaskItemProps = {
  task: Task;
  onToggle: (task: Task) => void;
  onDelete: (task: Task) => void;
};

export function TaskItem({ task, onToggle, onDelete }: TaskItemProps) {
  return (
    <li className={task.done ? 'task done' : 'task'}>
      <label className="task-label">
        <input type="checkbox" checked={task.done} onChange={() => onToggle(task)} />
        <span>{task.title}</span>
      </label>
      <Button variant="danger" aria-label={`Delete ${task.title}`} onClick={() => onDelete(task)}>
        Delete
      </Button>
    </li>
  );
}
