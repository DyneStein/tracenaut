import { unauthorized } from '../../../../lib/db';

export async function GET(req: Request) {
  if (!req.headers.get('authorization')) return unauthorized();
  return Response.json({ count: 0 });
}
