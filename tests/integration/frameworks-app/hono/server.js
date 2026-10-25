import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { pool } from '../db.js';

const app = new Hono();
const books = new Hono();

async function timing(c, next) {
  await next();
  c.header('x-took', '1');
}
books.get('/:id', async (c) => {
  const { rows } = await pool.query('select id, email from users where id = $1', [c.req.param('id')]);
  return rows.length ? c.json(rows[0]) : c.json({ error: 'not found' }, 404);
});
books.get('/', async (c) => c.json((await pool.query('select count(*) from users')).rows[0]));
app.use('/api/*', timing);
app.route('/api/books', books);
serve({ fetch: app.fetch, port: 4612, hostname: '127.0.0.1' }, () => console.log('hono ready'));
