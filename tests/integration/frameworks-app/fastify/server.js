import Fastify from 'fastify';
import { pool } from '../db.js';

const app = Fastify();

async function requireUser(req, reply) {
  if (req.headers['x-user'] === 'nobody') return reply.code(401).send({ error: 'unauthorized' });
}

async function usersPlugin(fastify) {
  fastify.get('/:id', { preHandler: requireUser }, async (req) => {
    const { rows } = await pool.query('select id, name from users where id = $1', [req.params.id]);
    return rows[0] ?? {};
  });
  fastify.get('/', async () => {
    const { rows } = await pool.query('select id, name from users order by id');
    return rows;
  });
}
app.get('/health', async () => ({ ok: true }));
app.register(usersPlugin, { prefix: '/api/users' });
app.listen({ port: 4611, host: '127.0.0.1' }).then(() => console.log('fastify ready'));
