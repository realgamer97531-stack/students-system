require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initSchema } = require('./db');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const sessionRoutes = require('./routes/sessions');
const rowRoutes = require('./routes/rows');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api', rowRoutes); // /api/sessions/:id/next, /api/rows/:id/disposition

const frontendDist = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(frontendDist, 'index.html'));
});

// Generic error handler (e.g. multer file errors)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

const PORT = process.env.PORT || 4000;

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Call center API listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Could not connect to the database / create tables:', err.message);
    console.error('Check your DB_HOST, DB_USER, DB_PASSWORD, DB_NAME in .env, and that');
    console.error('Remote MySQL access is enabled for this server\'s IP on Hostinger.');
    process.exit(1);
  });
