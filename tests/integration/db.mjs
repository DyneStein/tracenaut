// Real PostgreSQL (PGlite) served over TCP on 5433. Not instrumented.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
const db = await PGlite.create();
await db.exec(`create table users (id serial primary key, email text unique not null, name text);
  insert into users (email, name) values ('ada@example.com', 'Ada'), ('alan@example.com', 'Alan');
  create table events (id serial primary key, kind text, at timestamptz default now());`);
const server = new PGLiteSocketServer({ db, port: Number(process.env.PG_PORT ?? 5433), host: '127.0.0.1', maxConnections: 20 });
await server.start();
console.log('db ready');
