import { Hono } from 'hono';

const app = new Hono();
const books = new Hono();

const logger = async (_c: unknown, next: () => Promise<void>) => next();

books.get('/:id', (c: any) => c.json({ id: c.req.param('id') }));
books.delete('/:id', (c: any) => c.body(null, 204));
app.use('/books/*', logger);
app.route('/books', books);
