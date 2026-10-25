import Router from '@koa/router';

const router = new Router({ prefix: '/shop' });
const orders = new Router();

orders.get('/:orderId', async (ctx: any) => {
  ctx.body = { id: ctx.params.orderId };
});
router.use('/orders', orders.routes());
router.get('/cart', async (ctx: any) => {
  ctx.body = [];
});

class Router2 {
  get(_p: string, _h: unknown) {}
}
const notARouter = new Router2();
notARouter.get('/ignored', () => {});
