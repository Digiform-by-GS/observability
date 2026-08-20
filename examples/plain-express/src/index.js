// Deliberately uninstrumented: no observability imports, console.log logging,
// raw fetch. This is the "before" state the onboard skill transforms.
import express from 'express';

const app = express();
app.use(express.json());

const orders = new Map();

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/orders/:id', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) {
    console.log(`order ${req.params.id} not found`);
    return res.status(404).json({ error: 'not found' });
  }
  res.json(order);
});

app.post('/orders', (req, res) => {
  const id = String(Date.now());
  const order = { id, items: req.body.items ?? [], createdAt: new Date().toISOString() };
  orders.set(id, order);
  console.log(`order ${id} created with ${order.items.length} items`);
  res.status(201).json(order);
});

const port = process.env.PORT ?? 8095;
app.listen(port, () => console.log(`plain-express listening on :${port}`));
