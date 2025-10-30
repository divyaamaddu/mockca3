const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TEMP_SUFFIX = '.tmp';

// Utility: ensure data directory
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to create data dir', err);
    throw err;
  }
}

// Load users; create sample if missing
async function loadUsers() {
  try {
    await ensureDataDir();
    const raw = await fs.readFile(USERS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn('users.json missing or unreadable - creating sample users.json');
    const sample = [
      { id: 'user-1', username: 'alice', role: 'user', apiKey: 'key-alice-123' },
      { id: 'user-2', username: 'bob', role: 'admin', apiKey: 'key-bob-admin-456' }
    ];
    await fs.writeFile(USERS_FILE, JSON.stringify(sample, null, 2), 'utf8');
    return sample;
  }
}

// Read reviews safely; if corrupted, back up and return []
async function readReviews() {
  try {
    await ensureDataDir();
    const raw = await fs.readFile(REVIEWS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // File missing -> initialize
      await writeReviews([]);
      return [];
    }
    // Corrupted or parse error
    console.error('Failed to read reviews.json:', err.message);
    const corruptBackup = REVIEWS_FILE + '.corrupt.' + Date.now();
    try {
      await fs.copyFile(REVIEWS_FILE, corruptBackup);
      console.warn(`Backed up corrupted reviews.json to ${corruptBackup}`);
    } catch (copyErr) {
      console.warn('Could not back up corrupted reviews.json:', copyErr.message);
    }
    // reset file
    await writeReviews([]);
    return [];
  }
}

// Atomic write: write to temp then rename
async function writeReviews(reviews) {
  const tmpPath = REVIEWS_FILE + TEMP_SUFFIX;
  await fs.writeFile(tmpPath, JSON.stringify(reviews, null, 2), 'utf8');
  await fs.rename(tmpPath, REVIEWS_FILE);
}

// Simple auth middleware: expects x-api-key header. Attaches req.user
let USERS_CACHE = null;
async function authMiddleware(req, res, next) {
  const apiKey = req.header('x-api-key');
  if (!apiKey) return res.status(401).json({ error: 'Missing API key in x-api-key header' });
  if (!USERS_CACHE) USERS_CACHE = await loadUsers();
  const user = USERS_CACHE.find(u => u.apiKey === apiKey);
  if (!user) return res.status(401).json({ error: 'Invalid API key' });
  req.user = user; // contains id, username, role
  next();
}

// Helper: validate rating
function validateRating(rating) {
  if (typeof rating !== 'number') return false;
  if (!Number.isInteger(rating)) return false;
  return rating >= 1 && rating <= 5;
}

// POST /api/reviews - create review
app.post('/api/reviews', authMiddleware, async (req, res) => {
  const { bookTitle, author, reviewText, rating, tags, status } = req.body;
  if (!bookTitle || !author || !reviewText) {
    return res.status(400).json({ error: 'bookTitle, author and reviewText are required' });
  }
  if (!validateRating(rating)) {
    return res.status(400).json({ error: 'rating must be an integer between 1 and 5' });
  }
  const user = req.user;
  try {
    const reviews = await readReviews();
    // Check duplicate: same bookTitle & author by same user
    const duplicate = reviews.find(r => (
      r.bookTitle.trim().toLowerCase() === bookTitle.trim().toLowerCase() &&
      r.author.trim().toLowerCase() === author.trim().toLowerCase() &&
      r.userId === user.id
    ));
    if (duplicate) {
      return res.status(409).json({ error: 'Duplicate review: you have already reviewed this book' });
    }
    const newReview = {
      id: uuidv4(),
      bookTitle: String(bookTitle).trim(),
      author: String(author).trim(),
      reviewText: String(reviewText),
      rating: rating,
      tags: Array.isArray(tags) ? tags.slice(0, 10) : [],
      status: status ? String(status) : 'pending',
      userId: user.id,
      username: user.username,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    reviews.push(newReview);
    await writeReviews(reviews);
    // Return newly created review
    return res.status(201).json({ review: newReview });
  } catch (err) {
    console.error('Error creating review', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reviews - list reviews with filters
app.get('/api/reviews', async (req, res) => {
  const { author, rating, status, sort } = req.query;
  try {
    const reviews = await readReviews();
    let out = reviews.slice();
    if (author) {
      const a = String(author).trim().toLowerCase();
      out = out.filter(r => r.author && r.author.toLowerCase().includes(a));
    }
    if (rating) {
      const rnum = parseInt(rating, 10);
      if (!Number.isNaN(rnum)) out = out.filter(r => r.rating === rnum);
      else return res.status(400).json({ error: 'rating query param must be an integer' });
    }
    if (status) {
      const s = String(status).trim().toLowerCase();
      out = out.filter(r => r.status && r.status.toLowerCase() === s);
    }
    // sort param: e.g. sort=rating:asc or sort=date:desc
    if (sort) {
      const parts = String(sort).split(':');
      const key = parts[0];
      const dir = parts[1] === 'desc' ? -1 : 1;
      if (key === 'rating') {
        out.sort((a,b) => (a.rating - b.rating) * dir);
      } else if (key === 'date' || key === 'createdAt') {
        out.sort((a,b) => (new Date(a.createdAt) - new Date(b.createdAt)) * dir);
      } else {
        return res.status(400).json({ error: 'Unsupported sort key. Use rating or date' });
      }
    }
    return res.json(out);
  } catch (err) {
    console.error('Error reading reviews', err);
    return res.status(500).json({ error: 'Failed to read reviews' });
  }
});

// PUT /api/reviews/:id - update review
app.put('/api/reviews/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  const { reviewText, rating, tags } = req.body;
  if (rating !== undefined && !validateRating(rating)) {
    return res.status(400).json({ error: 'rating must be an integer between 1 and 5' });
  }
  try {
    const reviews = await readReviews();
    const idx = reviews.findIndex(r => r.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Review not found' });
    const review = reviews[idx];
    // Only owner can update
    if (review.userId !== req.user.id) {
      return res.status(403).json({ error: 'You are not authorized to update this review' });
    }
    // Update allowed fields only
    if (reviewText !== undefined) review.reviewText = String(reviewText);
    if (rating !== undefined) review.rating = rating;
    if (tags !== undefined) review.tags = Array.isArray(tags) ? tags.slice(0,10) : review.tags;
    review.updatedAt = new Date().toISOString();
    reviews[idx] = review;
    await writeReviews(reviews);
    return res.json({ review });
  } catch (err) {
    console.error('Error updating review', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/reviews/:id - delete review (owner or admin)
app.delete('/api/reviews/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  try {
    const reviews = await readReviews();
    const idx = reviews.findIndex(r => r.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Review not found' });
    const review = reviews[idx];
    // Only owner or admin can delete
    if (review.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You are not authorized to delete this review' });
    }
    reviews.splice(idx, 1);
    await writeReviews(reviews);
    return res.json({ message: 'Review deleted' });
  } catch (err) {
    console.error('Error deleting review', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Health & simple front-end gallery example (for testing)
app.get('/', (req,res) => {
  res.type('html').send(`
    <h2>Book Review API</h2>
    <p>Use the API endpoints under <code>/api/reviews</code>.</p>
    <p>Sample users (x-api-key): <code>key-alice-123</code> (alice, user), <code>key-bob-admin-456</code> (bob, admin)</p>
    <p>Example fetch to create a review (from browser console):</p>
    <pre>
fetch('/api/reviews', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': 'key-alice-123' },
  body: JSON.stringify({ bookTitle: 'Dune', author: 'Frank Herbert', reviewText: 'Great', rating: 5 })
}).then(r=>r.json()).then(console.log)
    </pre>
  `);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  // warm users cache
  USERS_CACHE = await loadUsers();
  console.log(`Book Review API running on http://localhost:${PORT}`);
});
