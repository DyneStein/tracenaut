import Koa from 'koa';
import Router from '@koa/router';
import { pool } from '../db.js';

const app = new Koa();
const router = new Router({ prefix: '/api' });
const orders = new Router();

orders.get('/:id', async (ctx) => {
  const { rows } = await pool.query('select id, name from users where id = $1', [ctx.params.id]);
  if (!rows.length) {
    ctx.status = 404;
    ctx.body = { error: 'missing' };
    return;
  }
  ctx.body = rows[0];
});
router.use('/orders', orders.routes());
router.get('/ping', async (ctx) => {
  ctx.body = { pong: true };
});
app.use(router.routes());
app.listen(4613, '127.0.0.1', () => console.log('koa ready'));
