import { useAuth } from '../hooks/useAuth';
import { Button } from './Button';

export function Header() {
  const { user, signOut } = useAuth();

  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark">▦</span> Taskboard
      </div>
      {user ? (
        <div className="header-user">
          <span>{user.name}</span>
          <Button variant="ghost" onClick={() => signOut()}>
            Sign out
          </Button>
        </div>
      ) : null}
    </header>
  );
}
