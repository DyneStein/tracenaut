import Fastify from 'fastify';
import { users } from './plugins/users';

const app = Fastify();

function auth(_req: unknown) {}

app.get('/health', async () => ({ ok: true }));
app.route({ method: ['GET', 'HEAD'], url: '/version', preHandler: auth, handler: async () => ({ v: 1 }) });
app.register(users, { prefix: '/v1/users' });
