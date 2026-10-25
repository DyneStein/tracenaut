import { db } from '../../../../lib/db';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const item = await db.client.item.findUnique({ where: { id: params.id } });
  return Response.json(item);
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  await db.client.item.delete({ where: { id: params.id } });
  await db.client.auditLog.create({ data: { id: params.id } });
  return new Response(null, { status: 204 });
}

export const dynamic = 'force-dynamic';
