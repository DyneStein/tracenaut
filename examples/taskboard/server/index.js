import express from 'express';
import { migrate } from './db/index.js';
import { authRouter } from './routes/auth.js';
import { tasksRouter } from './routes/tasks.js';

const PORT = Number(process.env.PORT ?? 3001);

migrate();

const app = express();
app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api/tasks', tasksRouter);

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`taskboard api listening on http://localhost:${PORT}`);
});
