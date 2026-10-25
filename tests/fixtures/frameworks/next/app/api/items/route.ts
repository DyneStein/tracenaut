import { prisma } from '../../../lib/db';

export const POST = async (req: Request) => {
  const body = await req.json();
  return Response.json(await prisma.item.create({ data: body }));
};
