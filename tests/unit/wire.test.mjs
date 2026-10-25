import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { observeDatabaseSockets, redactSql } from '../../packages/node-agent/dist/wire.js';

// The agent reads database protocols from socket writes. These tests send hand-built protocol
// bytes over real local sockets; no database is involved.
const seen = [];
observeDatabaseSockets({
  now: () => 0,
  onStatement: (_socket, st) => {
    const rec = { ...st };
    seen.push(rec);
    return (rows, error) => Object.assign(rec, { rows, error });
  },
});

const msg = (type, body) => {
  const b = Buffer.from(body);
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(b.length + 4, 1);
  return Buffer.concat([head, b]);
};
const cstr = (s) => Buffer.concat([Buffer.from(s), Buffer.from([0])]);

async function exchange(clientBytes, serverReply) {
  seen.length = 0;
  const server = net.createServer((sock) => {
    // Reply once everything has arrived, as a server would after processing the batch.
    sock.once('data', () => serverReply && setTimeout(() => sock.write(serverReply), 30));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = net.connect(server.address().port, '127.0.0.1');
  await new Promise((r) => client.once('connect', r));
  client.on('data', () => {});
  for (const chunk of clientBytes) client.write(chunk);
  await new Promise((r) => setTimeout(r, 80));
  client.destroy();
  server.close();
  return seen.slice();
}

function pgStartup() {
  const body = Buffer.concat([Buffer.from([0, 3, 0, 0]), cstr('user'), cstr('app'), Buffer.from([0])]);
  const head = Buffer.alloc(4);
  head.writeInt32BE(body.length + 4);
  return Buffer.concat([head, body]);
}

test('PostgreSQL: simple and extended queries, row counts, never bind values or passwords', async () => {
  const bindWithSecret = Buffer.concat([cstr(''), cstr('s1'), Buffer.from([0, 0, 0, 1, 0, 0, 0, 6]), Buffer.from('hunter'), Buffer.from([0, 0])]);
  const stmts = await exchange(
    [
      pgStartup(),
      msg('p', cstr('topsecret-password')),
      msg('Q', cstr("select * from users where email = 'ada@example.com'")),
      // a split write: Parse arrives in two chunks
      msg('P', Buffer.concat([cstr('s1'), cstr('update users set name = $1 where id = 2'), Buffer.from([0, 0])])).subarray(0, 9),
      Buffer.concat([msg('P', Buffer.concat([cstr('s1'), cstr('update users set name = $1 where id = 2'), Buffer.from([0, 0])])).subarray(9), msg('B', bindWithSecret), msg('E', Buffer.concat([cstr(''), Buffer.from([0, 0, 0, 0])])), msg('S', '')]),
    ],
    Buffer.concat([msg('C', cstr('SELECT 3')), msg('Z', 'I'), msg('C', cstr('UPDATE 1')), msg('Z', 'I')]),
  );
  assert.deepEqual(
    stmts.map((s) => [s.protocol, s.text, s.op, s.rows]),
    [
      ['postgres', "select * from users where email = '…'", 'SELECT', 3],
      ['postgres', 'update users set name = $1 where id = 2', 'UPDATE', 1],
    ],
  );
  assert.equal(JSON.stringify(stmts).includes('hunter'), false);
  assert.equal(JSON.stringify(stmts).includes('topsecret'), false);
});

test('PostgreSQL errors keep the code and drop quoted values', async () => {
  const err = Buffer.concat([Buffer.from('S'), cstr('ERROR'), Buffer.from('C'), cstr('23505'), Buffer.from('M'), cstr('duplicate key value violates unique constraint "users_email_key"'), Buffer.from('D'), cstr('Key (email)=(ada@example.com) already exists.'), Buffer.from([0])]);
  const [s] = await exchange([pgStartup(), msg('Q', cstr('insert into users (email) values ($1)'))], Buffer.concat([msg('E', err), msg('Z', 'I')]));
  assert.equal(s.error, 'duplicate key value violates unique constraint "…" (SQLSTATE 23505)');
});

test('MySQL: COM_QUERY text, literals redacted', async () => {
  const handshake = Buffer.alloc(40);
  handshake.writeUIntLE(36, 0, 3);
  handshake[3] = 1;
  handshake.writeUInt32LE(0x0200 | 0x8000, 4); // CLIENT_PROTOCOL_41 | CLIENT_SECURE_CONNECTION
  const payload = Buffer.concat([Buffer.from([0x03]), Buffer.from("SELECT id FROM orders WHERE note = 'gift'")]);
  const head = Buffer.alloc(4);
  head.writeUIntLE(payload.length, 0, 3);
  const [s] = await exchange([handshake, Buffer.concat([head, payload])]);
  assert.deepEqual([s.protocol, s.text, s.op], ['mysql', "SELECT id FROM orders WHERE note = '…'", 'SELECT']);
});

test('MongoDB: command and collection only, never the filter', async () => {
  // OP_MSG with { find: "users", filter: { email: "ada@example.com" } }
  const str = (k, v) => Buffer.concat([Buffer.from([0x02]), cstr(k), (() => { const b = Buffer.alloc(4); b.writeInt32LE(Buffer.byteLength(v) + 1); return b; })(), cstr(v)]);
  const inner = Buffer.concat([str('email', 'ada@example.com'), Buffer.from([0])]);
  const innerDoc = Buffer.concat([(() => { const b = Buffer.alloc(4); b.writeInt32LE(inner.length + 4); return b; })(), inner]);
  const fields = Buffer.concat([str('find', 'users'), Buffer.from([0x03]), cstr('filter'), innerDoc, Buffer.from([0])]);
  const doc = Buffer.concat([(() => { const b = Buffer.alloc(4); b.writeInt32LE(fields.length + 4); return b; })(), fields]);
  const body = Buffer.concat([Buffer.alloc(4), Buffer.from([0]), doc]);
  const header = Buffer.alloc(16);
  header.writeInt32LE(16 + body.length, 0);
  header.writeInt32LE(1, 4);
  header.writeInt32LE(2013, 12);
  const [s] = await exchange([Buffer.concat([header, body])]);
  assert.deepEqual([s.protocol, s.text, s.op], ['mongodb', 'find users', 'find']);
  assert.equal(JSON.stringify(s).includes('ada@'), false);
});

test('Redis: command names only, never keys or values', async () => {
  const stmts = await exchange([Buffer.from('*3\r\n$3\r\nSET\r\n$11\r\nsession:abc\r\n$6\r\nsecret\r\n*2\r\n$3\r\nGET\r\n$11\r\nsession:abc\r\n')]);
  assert.deepEqual(stmts.map((s) => s.text), ['SET', 'GET']);
  assert.equal(JSON.stringify(stmts).includes('session'), false);
});

test('unrelated traffic (HTTP) is ignored', async () => {
  assert.deepEqual(await exchange([Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n')]), []);
});

test('SQL literal redaction', () => {
  assert.equal(redactSql("select 'a''b', $$body$$ from t where x = 'y'"), "select '…', '…' from t where x = '…'");
});

test('PostgreSQL: a refused SSLRequest is followed by the startup on the same connection', async () => {
  const ssl = Buffer.alloc(8);
  ssl.writeInt32BE(8, 0);
  ssl.writeInt32BE(80877103, 4);
  const stmts = await exchange([ssl, pgStartup(), msg('Q', cstr('select 1'))]);
  assert.deepEqual(stmts.map((s) => s.text), ['select 1']);
});

test('Redis: a value that looks like a command is never reported', async () => {
  const value = '*1\r\n$6\r\nSECRET\r\n';
  const cmd = `*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$${value.length}\r\n${value}\r\n`;
  const stmts = await exchange([Buffer.from(cmd)]);
  assert.deepEqual(stmts.map((s) => s.text), ['SET']);
});

test('unknown binary protocols are not mistaken for MySQL', async () => {
  const packet = Buffer.alloc(48, 7);
  packet.writeUIntLE(40, 0, 3);
  packet[3] = 1;
  const after = Buffer.concat([Buffer.from([20, 0, 0, 0, 0x03]), Buffer.from('not sql at all......')]);
  assert.deepEqual(await exchange([packet, after]), []);
});
