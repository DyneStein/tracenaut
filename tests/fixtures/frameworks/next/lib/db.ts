// The generated client is not present in this fixture (as in a fresh checkout).
export const prisma: any = {};
export const db = { client: prisma };

export function unauthorized(message = 'Unauthorized') {
  return Response.json({ error: message }, { status: 401 });
}
