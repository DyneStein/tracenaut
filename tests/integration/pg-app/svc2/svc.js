import http from 'node:http';
import postgres from 'postgres';
const sql = postgres({ host: '127.0.0.1', port: 5433, user: 'postgres', database: 'postgres', max: 2 });
async function stats() {
  const [row] = await sql`select count(*)::int as n from users`;
  return { users: row.n };
}
http.createServer(async (req, res) => res.end(JSON.stringify(await stats()))).listen(4602, () => console.log('svc2 ready'));
