import express from 'express';

export function createFixture({ fixed = false } = {}) {
  const app = express();
  const records = {
    'inv-north': { id: 'inv-north', owner: 'north', amount: 1200, confidential: 'NORTH_PRIVATE_INVOICE_48E29A' },
    'inv-west': { id: 'inv-west', owner: 'west', amount: 800, confidential: 'WEST_PRIVATE_INVOICE_78C62E' },
    'inv-south': { id: 'inv-south', owner: 'south', amount: 2400, confidential: 'SOUTH_PRIVATE_INVOICE_91B38F' }
  };
  function requireActor(req, res, next) {
    req.actor = ['north', 'south', 'west'].includes(req.headers['x-demo-actor']) ? req.headers['x-demo-actor'] : null;
    if (!req.actor) return res.status(401).json({ error: 'Authentication required' });
    next();
  }
  app.get('/api/invoices/:id', requireActor, (req, res) => {
    const record = records[req.params.id];
    if (!record) return res.status(404).json({ error: 'Not found' });
    if (fixed && record.owner !== req.actor) return res.status(403).json({ error: 'Forbidden' });
    res.json(record);
  });
  app.get('/api/profile', requireActor, (req, res) => {
    res.json({ organization: req.actor, plan: 'Demo business' });
  });
  app.get('/api/health', (req, res) => res.json({ status: 'ok', synthetic: true }));
  return app;
}
