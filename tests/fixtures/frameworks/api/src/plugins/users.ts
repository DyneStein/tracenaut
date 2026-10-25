export async function users(fastify: any) {
  fastify.get('/:id', async (req: any) => ({ id: req.params.id }));
  fastify.post('/', async () => ({ created: true }));
}
