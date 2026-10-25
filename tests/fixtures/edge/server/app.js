import express, { Router } from 'express';

const app = express();
const items = Router();
const cache = new Map();

cache.get('/not-a-route');

items.get('/', (req, res) => res.json([]));
items.post('/', create);
items.get('/:id', (req, res) => res.json({ id: req.params.id }));

app.use(express.json());
app.use('/api/items', items);

const orphan = Router();
orphan.get('/lonely', (req, res) => res.end());

function create(req, res) {
  res.status(201).json({});
}

export { app };
