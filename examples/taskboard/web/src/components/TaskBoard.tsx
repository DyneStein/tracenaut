import { useTasks } from '../hooks/useTasks';
import { NewTaskForm } from './NewTaskForm';
import { TaskItem } from './TaskItem';

export function TaskBoard() {
  const { tasks, loading, addTask, toggleTask, removeTask } = useTasks();
  const remaining = tasks.filter((task) => !task.done).length;

  return (
    <section className="card board">
      <div className="board-head">
        <h1>Your tasks</h1>
        <span className="pill">{remaining} open</span>
      </div>
      <NewTaskForm onCreate={addTask} />
      {loading ? (
        <p className="muted">Loading tasks…</p>
      ) : (
        <ul className="tasks">
          {tasks.map((task) => (
            <TaskItem key={task.id} task={task} onToggle={toggleTask} onDelete={removeTask} />
          ))}
        </ul>
      )}
    </section>
  );
}
