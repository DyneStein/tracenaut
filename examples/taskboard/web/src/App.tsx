import { useAuth } from './hooks/useAuth';
import { Header } from './components/Header';
import { LoginForm } from './components/LoginForm';
import { TaskBoard } from './components/TaskBoard';

export function App() {
  const { user, ready } = useAuth();

  if (!ready) {
    return <div className="splash">Loading…</div>;
  }

  return (
    <div className="shell">
      <Header />
      <main className="content">{user ? <TaskBoard /> : <LoginForm />}</main>
    </div>
  );
}
