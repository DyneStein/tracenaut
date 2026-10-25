import pg from 'pg';
export const pool = new pg.Pool({ host: '127.0.0.1', port: 5433, user: 'postgres', database: 'postgres', max: 2 });
