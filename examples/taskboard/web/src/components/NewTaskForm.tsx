import { useState, type FormEvent } from 'react';
import { Button } from './Button';

type NewTaskFormProps = {
  onCreate: (title: string) => Promise<void>;
};

export function NewTaskForm({ onCreate }: NewTaskFormProps) {
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    await onCreate(title);
    setTitle('');
    setSaving(false);
  }

  return (
    <form className="new-task" onSubmit={submit}>
      <input placeholder="What needs doing?" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Button type="submit" busy={saving}>
        Add task
      </Button>
    </form>
  );
}
