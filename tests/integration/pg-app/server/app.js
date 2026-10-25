import http from 'node:http';
import pg from 'pg';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';

const pool = new pg.Pool({ host: '127.0.0.1', port: 5433, user: 'postgres', database: 'postgres', max: 3 });
const sql = postgres({ host: '127.0.0.1', port: 5433, user: 'postgres', database: 'postgres', max: 3 });
const users = pgTable('users', { id: serial('id').primaryKey(), email: text('email').notNull(), name: text('name') });
const db = drizzle(sql);

async function userById(id) {
  const { rows } = await pool.query('select id, name from users where id = $1', [id]);
  return rows[0];
}
async function listUsers() {
  return sql`select id, email from users order by id`;
}
async function createUser(email) {
  await db.insert(users).values({ email, name: 'New' });
  return db.select().from(users).where(eq(users.email, email));
}
async function both() {
  const [a, b] = await Promise.all([sql`select count(*) from users`, sql`select count(*) from events`]);
  return { users: a[0].count, events: b[0].count };
}
async function broken() {
  return sql`select * from no_such_table`;
}
async function callOther() {
  const res = await fetch('http://127.0.0.1:4602/internal/stats');
  return res.json();
}

// Unrelated background work: never part of any traced request.
setInterval(() => {
  sql`insert into events (kind) values ('heartbeat')`.catch(() => {});
}, 40);

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  let body;
  try {
    if (url.pathname.startsWith('/pg/users/')) body = await userById(Number(url.pathname.split('/').pop()));
    else if (url.pathname === '/pjs/users') body = await listUsers();
    else if (url.pathname === '/drizzle/users') body = await createUser(`u${Date.now()}@example.com`);
    else if (url.pathname === '/both') body = await both();
    else if (url.pathname === '/broken') body = await broken();
    else if (url.pathname === '/other') body = await callOther();
    else body = { ok: true };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'failed' }));
  }
}
http.createServer(handle).listen(4601, () => console.log('api ready'));
