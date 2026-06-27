require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { signToken, verifyToken, requireRole, requireSelfOrAdmin, SECRET } = require('./auth');

const app = express();

/* =========================
CORS (configurable via .env -> CORS_ORIGIN)
========================= */
const corsOrigin = process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== '*'
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : '*';
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

/* =========================
IMAGE UPLOADS (waste post photos)
========================= */
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeName = `waste_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, safeName);
  }
});

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG, WEBP or GIF images are allowed'));
    }
  }
});

// Serve uploaded images as static files
app.use('/uploads', express.static(UPLOAD_DIR));

/* =========================
AUTH - LOGIN
========================= */
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  db.query(
    `SELECT * FROM users WHERE email=?`,
    [email],
    (err, results) => {
      if (err) {
        console.error('LOGIN ERROR:', err);
        return res.status(500).json({ message: 'Database error' });
      }

      if (results.length === 0) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      const u = results[0];

      bcrypt.compare(password, u.password, (cmpErr, isMatch) => {
        if (cmpErr) {
          console.error('PASSWORD COMPARE ERROR:', cmpErr);
          return res.status(500).json({ message: 'Server error' });
        }

        if (!isMatch) {
          return res.status(401).json({ message: 'Invalid credentials' });
        }

        const user = {
          id: u.id,
          full_name: u.full_name,
          email: u.email,
          role: u.role,
          phone: u.phone,
          address: u.address,
          custom_id: u.custom_id
        };

        const token = signToken(user);
        res.json({ user, token });
      });
    }
  );
});


/* =========================
HELPER - GENERATE CUSTOM ID (AD-01, B-01, S-01)
========================= */
function generateCustomId(role, callback) {
  const prefixMap = { admin: 'AD', buyer: 'B', seller: 'S' };
  const prefix = prefixMap[role] || 'B';

  db.query(
    `SELECT custom_id FROM users WHERE role = ? ORDER BY id DESC LIMIT 1`,
    [role],
    (err, results) => {
      if (err) return callback(err);

      let nextNum = 1;
      if (results.length > 0 && results[0].custom_id) {
        const lastNum = parseInt(results[0].custom_id.split('-')[1], 10);
        if (!isNaN(lastNum)) nextNum = lastNum + 1;
      }

      const padded = String(nextNum).padStart(2, '0');
      callback(null, `${prefix}-${padded}`);
    }
  );
}

/* =========================
AUTH - REGISTER
========================= */
app.post('/api/auth/register', (req, res) => {
  const { full_name, phone, address, email, password, role } = req.body;

  if (!full_name || !email || !password || !role) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  // SECURITY: self-registration can only create buyer/seller accounts.
  // Admin accounts must be created directly in the database (see schema.sql),
  // otherwise anyone could POST role:"admin" and take over the platform.
  if (!['buyer', 'seller'].includes(role)) {
    return res.status(400).json({ message: 'Role must be buyer or seller' });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters' });
  }

  db.query(`SELECT id FROM users WHERE email = ?`, [email], (existsErr, existsRows) => {
    if (existsErr) {
      console.error('REGISTER EMAIL CHECK ERROR:', existsErr);
      return res.status(500).json({ message: 'Database error' });
    }
    if (existsRows.length > 0) {
      return res.status(409).json({ message: 'An account with this email already exists' });
    }

    bcrypt.hash(password, 10, (hashErr, hashedPassword) => {
      if (hashErr) {
        console.error('PASSWORD HASH ERROR:', hashErr);
        return res.status(500).json({ message: 'Server error' });
      }

      generateCustomId(role, (genErr, customId) => {
        if (genErr) {
          console.error('CUSTOM ID GENERATION ERROR:', genErr);
          return res.status(500).json({ message: 'Database error' });
        }

        const sql = `
          INSERT INTO users (full_name, phone, address, email, password, role, custom_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `;

        db.query(
          sql,
          [full_name, phone, address, email, hashedPassword, role, customId],
          (err, result) => {
            if (err) {
              console.error('REGISTER ERROR:', err);
              return res.status(500).json({ message: 'Database error' });
            }

            const user = {
              id: result.insertId,
              full_name, email, role, phone, address, custom_id: customId
            };
            const token = signToken(user);

            res.status(201).json({
              message: 'User registered successfully',
              userId: result.insertId,
              customId: customId,
              user,
              token
            });
          }
        );
      });
    });
  });
});


/* =========================
ADMIN - USERS (grouped by role: admin / buyer / seller)
========================= */
app.get('/api/admin/users', verifyToken, requireRole('admin'), (req, res) => {
  db.query(`SELECT id, custom_id, full_name, email, phone, address, role, created_at FROM users ORDER BY id ASC`, (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ admins: [], buyers: [], sellers: [] });
    }

    const admins = result.filter(u => u.role === 'admin');
    const buyers = result.filter(u => u.role === 'buyer');
    const sellers = result.filter(u => u.role === 'seller');

    res.json({ admins, buyers, sellers });
  });
});


/* =========================
ADMIN - WASTE POSTS
========================= */
app.get('/api/admin/waste', verifyToken, requireRole('admin'), (req, res) => {
  db.query(`
    SELECT wp.*, u.custom_id AS seller_custom_id
    FROM waste_posts wp
    LEFT JOIN users u ON wp.seller_id = u.id
  `, (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).json([]);
    }
    res.json(result);
  });
});


/* =========================
ADMIN - APPROVE / REJECT WASTE POST
========================= */
app.put('/api/admin/waste/:id/status', verifyToken, requireRole('admin'), (req, res) => {
  const id = req.params.id;
  const { status } = req.body;

  const allowedStatuses = ['pending', 'approved', 'rejected'];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ message: 'Invalid status value' });
  }

  db.query(
    `UPDATE waste_posts SET status = ? WHERE id = ?`,
    [status, id],
    (err) => {
      if (err) {
        console.error('WASTE STATUS UPDATE ERROR:', err);
        return res.status(500).json({ message: 'Database error' });
      }

      res.json({ message: `Waste post ${status}` });
    }
  );
});

/* =========================
REQUESTS (ADMIN VIEW)
========================= */
app.get('/api/requests', verifyToken, requireRole('admin'), (req, res) => {
  db.query(`SELECT * FROM waste_requests`, (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).json([]);
    }
    res.json(result);
  });
});


/* =========================
SELLER DASHBOARD STARTS
========================= */
app.get('/api/seller/dashboard/:id', verifyToken, requireSelfOrAdmin('id'), (req, res) => {
  const id = req.params.id;

  const q1 = `SELECT COUNT(*) AS totalPosts FROM waste_posts WHERE seller_id=?`;

  const q2 = `
    SELECT 
      SUM(CASE WHEN wr.status = 'pending' THEN 1 ELSE 0 END) AS pendingRequests,
      SUM(CASE WHEN wr.status = 'completed' THEN 1 ELSE 0 END) AS completedDeals
    FROM waste_requests wr
    JOIN waste_posts wp ON wr.waste_id = wp.id
    WHERE wp.seller_id = ?
  `;

  db.query(q1, [id], (err, postResult) => {
    if (err) {
      console.error('SELLER DASHBOARD ERROR:', err);
      return res.status(500).json({ totalPosts: 0, totalRequests: 0, completedDeals: 0 });
    }

    db.query(q2, [id], (err2, reqResult) => {
      if (err2) {
        console.error(err2);
        return res.status(500).json({
          totalPosts: postResult[0].totalPosts,
          totalRequests: 0,
          completedDeals: 0
        });
      }

      res.json({
        totalPosts: postResult[0].totalPosts,
        totalRequests: reqResult[0].pendingRequests || 0,
        completedDeals: reqResult[0].completedDeals || 0
      });
    });
  });
});

/* =========================
SELLER - PROFILE INFO (full fresh data from DB)
========================= */
app.get('/api/seller/profile/:id', verifyToken, requireSelfOrAdmin('id'), (req, res) => {
  const id = req.params.id;

  db.query(
    `SELECT id, custom_id, full_name, email, phone, address, role, created_at FROM users WHERE id = ?`,
    [id],
    (err, results) => {
      if (err) {
        console.error('SELLER PROFILE ERROR:', err);
        return res.status(500).json({ message: 'Database error' });
      }

      if (results.length === 0) {
        return res.status(404).json({ message: 'Seller not found' });
      }

      res.json(results[0]);
    }
  );
});

/* =========================
SEARCH WASTE (BUYER) - public, only approved posts
========================= */
app.get('/api/waste/search', (req, res) => {
  const { type, location, q } = req.query;

  let sql = `
    SELECT wp.*, u.full_name AS seller_name
    FROM waste_posts wp
    JOIN users u ON wp.seller_id = u.id
    WHERE wp.status = 'approved' AND wp.quantity > 0
  `;
  const params = [];

  if (type) {
    sql += ` AND wp.type LIKE ?`;
    params.push(`%${type}%`);
  }

  if (location) {
    sql += ` AND wp.location LIKE ?`;
    params.push(`%${location}%`);
  }

  if (q) {
    sql += ` AND (wp.name LIKE ? OR wp.type LIKE ? OR wp.location LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  sql += ` ORDER BY wp.id DESC`;

  db.query(sql, params, (err, result) => {
    if (err) {
      console.error('SEARCH WASTE ERROR:', err);
      return res.status(500).json([]);
    }
    res.json(result);
  });
});

/* =========================
BUYER - SEND REQUEST
========================= */
app.post('/api/requests', verifyToken, requireRole('buyer'), (req, res) => {
  const { waste_id, quantity, message, proposed_price } = req.body;
  const buyer_id = req.user.id; // never trust a client-supplied buyer_id

  if (!waste_id || !quantity) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const requestedQty = Number(quantity);
  if (!requestedQty || requestedQty <= 0) {
    return res.status(400).json({ message: 'Quantity must be a positive number' });
  }

  // Make sure the buyer isn't asking for more than what's actually left
  db.query(
    `SELECT quantity, status FROM waste_posts WHERE id = ?`,
    [waste_id],
    (checkErr, rows) => {
      if (checkErr) {
        console.error('REQUEST - WASTE CHECK ERROR:', checkErr);
        return res.status(500).json({ message: 'Database error' });
      }
      if (rows.length === 0) {
        return res.status(404).json({ message: 'Waste listing not found' });
      }
      if (rows[0].status !== 'approved') {
        return res.status(400).json({ message: 'This listing is not available' });
      }
      if (requestedQty > Number(rows[0].quantity)) {
        return res.status(400).json({
          message: `Only ${rows[0].quantity} kg left in this listing — please request a smaller amount`
        });
      }

      const sql = `
        INSERT INTO waste_requests (waste_id, buyer_id, quantity, message, proposed_price, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
      `;

      db.query(sql, [waste_id, buyer_id, requestedQty, message || '', proposed_price || 0], (err, result) => {
        if (err) {
          console.error('CREATE REQUEST ERROR:', err);
          return res.status(500).json({ message: 'Database error' });
        }

        res.status(201).json({
          message: 'Request sent successfully',
          requestId: result.insertId
        });
      });
    }
  );
});


/* =========================
BUYER DASHBOARD STATS
========================= */
app.get('/api/buyer/dashboard/:id', verifyToken, requireSelfOrAdmin('id'), (req, res) => {
  const id = req.params.id;

  const sql = `
    SELECT 
      COUNT(*) AS totalRequests,
      SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS activeOrders,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedOrders
    FROM waste_requests
    WHERE buyer_id = ?
  `;

  db.query(sql, [id], (err, result) => {
    if (err) {
      console.error('BUYER DASHBOARD ERROR:', err);
      return res.status(500).json({ totalRequests: 0, activeOrders: 0, completedOrders: 0 });
    }

    res.json({
      totalRequests: result[0].totalRequests || 0,
      activeOrders: result[0].activeOrders || 0,
      completedOrders: result[0].completedOrders || 0
    });
  });
});


/* =========================
BUYER - MY REQUESTS
========================= */
app.get('/api/requests/buyer/:buyer_id', verifyToken, requireSelfOrAdmin('buyer_id'), (req, res) => {
  const buyer_id = req.params.buyer_id;

  const sql = `
    SELECT 
      wr.id,
      wr.quantity,
      wr.status,
      wr.created_at,
      wp.name AS waste_name,
      wp.location AS location,
      wp.seller_id AS seller_id,
      u.full_name AS seller_name,
      u.phone AS seller_phone,
      d.id AS delivery_id,
      d.delivery_method,
      d.address AS delivery_address,
      d.scheduled_date,
      d.delivery_person_name,
      d.delivery_person_phone,
      d.notes AS delivery_notes,
      d.status AS delivery_status
    FROM waste_requests wr
    JOIN waste_posts wp ON wr.waste_id = wp.id
    JOIN users u ON wp.seller_id = u.id
    LEFT JOIN deliveries d ON d.request_id = wr.id
    WHERE wr.buyer_id = ?
    ORDER BY wr.id DESC
  `;

  db.query(sql, [buyer_id], (err, result) => {
    if (err) {
      console.error('BUYER REQUESTS ERROR:', err);
      return res.status(500).json([]);
    }
    res.json(result);
  });
});

/* =========================
BUYER - PROFILE INFO
========================= */
app.get('/api/buyer/profile/:id', verifyToken, requireSelfOrAdmin('id'), (req, res) => {
  const id = req.params.id;

  db.query(
    `SELECT id, custom_id, full_name, email, phone, address, role, created_at FROM users WHERE id = ?`,
    [id],
    (err, results) => {
      if (err) {
        console.error('BUYER PROFILE ERROR:', err);
        return res.status(500).json({ message: 'Database error' });
      }

      if (results.length === 0) {
        return res.status(404).json({ message: 'Buyer not found' });
      }

      res.json(results[0]);
    }
  );
});

/* =========================
SELLER - MY POSTS
========================= */
app.get('/api/waste/my/:seller_id', verifyToken, requireSelfOrAdmin('seller_id'), (req, res) => {
  const seller_id = req.params.seller_id;

  db.query(
    `SELECT * FROM waste_posts WHERE seller_id = ? ORDER BY id DESC`,
    [seller_id],
    (err, result) => {
      if (err) {
        console.error('MY POSTS ERROR:', err);
        return res.status(500).json([]);
      }

      res.json(result);
    }
  );
});

/* =========================
WASTE POST (SELLER POST CREATE) - now accepts an optional image
========================= */
app.post('/api/waste/post', verifyToken, requireRole('seller'), (req, res) => {
  upload.single('image')(req, res, (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ message: uploadErr.message || 'Image upload failed' });
    }

    const { name, type, quantity, location, description } = req.body;
    const seller_id = req.user.id; // never trust a client-supplied seller_id

    if (!name || !type || !quantity) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const qty = Number(quantity);
    if (!qty || qty <= 0) {
      return res.status(400).json({ message: 'Quantity must be a positive number' });
    }

    const image_url = req.file ? `/uploads/${req.file.filename}` : null;

    const sql = `
      INSERT INTO waste_posts (name, type, quantity, location, description, seller_id, image_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(
      sql,
      [name, type, qty, location, description, seller_id, image_url],
      (err, result) => {
        if (err) {
          console.error('WASTE POST ERROR:', err);
          return res.status(500).json({ message: 'Database error' });
        }

        res.status(201).json({
          message: 'Waste posted successfully',
          postId: result.insertId,
          image_url
        });
      }
    );
  });
});


//buyer request page (requests received against this seller's posts)
app.get('/api/requests/:seller_id', verifyToken, requireSelfOrAdmin('seller_id'), (req, res) => {
  const seller_id = req.params.seller_id;

  const sql = `
    SELECT 
      wr.id,
      wr.buyer_id,
      wr.message,
      wr.quantity,
      wr.proposed_price,
      wr.status,
      wr.created_at,
      wp.seller_id AS seller_id,
      wp.name AS waste_name,
      wp.type AS waste_type,
      wp.location AS pickup_location,
      u.full_name AS buyer_name,
      u.address AS buyer_address,
      u.phone AS buyer_phone,
      d.id AS delivery_id,
      d.delivery_method,
      d.address AS delivery_address,
      d.scheduled_date,
      d.delivery_person_name,
      d.delivery_person_phone,
      d.notes AS delivery_notes,
      d.status AS delivery_status
    FROM waste_requests wr
    JOIN waste_posts wp ON wr.waste_id = wp.id
    JOIN users u ON wr.buyer_id = u.id
    LEFT JOIN deliveries d ON d.request_id = wr.id
    WHERE wp.seller_id = ?
    ORDER BY wr.id DESC
  `;

  db.query(sql, [seller_id], (err, result) => {
    if (err) {
      console.log(err);
      return res.status(500).json([]);
    }

    res.json(result);
  });
});

/* =========================
REQUEST - ACCEPT / REJECT (only the seller who owns the waste post, or admin)
========================= */
app.put('/api/requests/:id', verifyToken, requireRole('seller', 'admin'), (req, res) => {
  const id = req.params.id;
  const { status } = req.body;

  const allowedStatuses = ['accepted', 'rejected'];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ message: 'Invalid status value' });
  }

  db.query(
    `SELECT wp.seller_id FROM waste_requests wr
     JOIN waste_posts wp ON wr.waste_id = wp.id
     WHERE wr.id = ?`,
    [id],
    (ownErr, rows) => {
      if (ownErr) {
        console.error('REQUEST OWNERSHIP CHECK ERROR:', ownErr);
        return res.status(500).json({ message: 'Database error' });
      }
      if (rows.length === 0) {
        return res.status(404).json({ message: 'Request not found' });
      }
      if (req.user.role !== 'admin' && rows[0].seller_id !== req.user.id) {
        return res.status(403).json({ message: 'You do not own this waste listing' });
      }

      db.query(
        "UPDATE waste_requests SET status=? WHERE id=?",
        [status, id],
        (err) => {
          if (err) {
            return res.status(500).json({ message: "error" });
          }

          res.json({ message: "updated" });
        }
      );
    }
  );
});


/* =========================
DELIVERY - HELPER: notify buyer & seller in real-time
========================= */
function notifyDeliveryUpdate(requestId, status) {
  db.query(
    `SELECT wr.buyer_id, wp.seller_id, wp.name AS waste_name
     FROM waste_requests wr
     JOIN waste_posts wp ON wr.waste_id = wp.id
     WHERE wr.id = ?`,
    [requestId],
    (err, rows) => {
      if (err || rows.length === 0) return;

      const { buyer_id, seller_id, waste_name } = rows[0];
      const payload = { request_id: requestId, status, waste_name };

      io.to(`user_${buyer_id}`).emit('delivery_update', payload);
      io.to(`user_${seller_id}`).emit('delivery_update', payload);
    }
  );
}

/* =========================
DELIVERY - SCHEDULE (seller sets method, address, date etc.)
Only allowed once the request has been accepted, and only by the
seller who owns the linked waste post (or an admin).
========================= */
app.post('/api/deliveries', verifyToken, requireRole('seller', 'admin'), (req, res) => {
  const {
    request_id,
    delivery_method,
    address,
    scheduled_date,
    delivery_person_name,
    delivery_person_phone,
    notes
  } = req.body;

  if (!request_id || !delivery_method || !address) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  if (!['pickup', 'seller_delivery'].includes(delivery_method)) {
    return res.status(400).json({ message: 'Invalid delivery method' });
  }

  db.query(
    `SELECT wr.status, wp.seller_id FROM waste_requests wr
     JOIN waste_posts wp ON wr.waste_id = wp.id
     WHERE wr.id = ?`,
    [request_id],
    (err, results) => {
    if (err) {
      console.error('DELIVERY - REQUEST CHECK ERROR:', err);
      return res.status(500).json({ message: 'Database error' });
    }

    if (results.length === 0) {
      return res.status(404).json({ message: 'Request not found' });
    }

    if (req.user.role !== 'admin' && results[0].seller_id !== req.user.id) {
      return res.status(403).json({ message: 'You do not own this waste listing' });
    }

    if (results[0].status !== 'accepted') {
      return res.status(400).json({ message: 'Delivery can only be scheduled for accepted requests' });
    }

    const sql = `
      INSERT INTO deliveries
        (request_id, delivery_method, address, scheduled_date, delivery_person_name, delivery_person_phone, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(
      sql,
      [
        request_id,
        delivery_method,
        address,
        scheduled_date || null,
        delivery_person_name || null,
        delivery_person_phone || null,
        notes || null
      ],
      (err2, result) => {
        if (err2) {
          console.error('DELIVERY CREATE ERROR:', err2);
          return res.status(500).json({ message: 'Database error' });
        }

        notifyDeliveryUpdate(request_id, 'scheduled');

        res.status(201).json({
          message: 'Delivery scheduled successfully',
          deliveryId: result.insertId
        });
      }
    );
  });
});

/* =========================
DELIVERY - UPDATE STATUS
(scheduled -> out_for_delivery -> delivered, or cancelled)
When marked 'delivered', the linked request is also marked 'completed'.
Sellers (or admin) can set any status. Buyers may ONLY confirm
'delivered' on a pickup-method delivery (self-confirming pickup).
========================= */
app.put('/api/deliveries/:id/status', verifyToken, (req, res) => {
  const id = req.params.id;
  const { status } = req.body;

  const allowedStatuses = ['scheduled', 'out_for_delivery', 'delivered', 'cancelled'];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ message: 'Invalid status value' });
  }

  db.query(
    `SELECT d.request_id, d.delivery_method, wr.buyer_id, wr.waste_id, wr.quantity AS requested_quantity, wp.seller_id
     FROM deliveries d
     JOIN waste_requests wr ON d.request_id = wr.id
     JOIN waste_posts wp ON wr.waste_id = wp.id
     WHERE d.id = ?`,
    [id],
    (err, rows) => {
    if (err) {
      console.error('DELIVERY STATUS LOOKUP ERROR:', err);
      return res.status(500).json({ message: 'Database error' });
    }

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Delivery not found' });
    }

    const { request_id: requestId, delivery_method, buyer_id, seller_id, waste_id, requested_quantity } = rows[0];
    const isOwner = req.user.role === 'admin' || req.user.id === seller_id;
    const isBuyerConfirmingPickup =
      req.user.id === buyer_id && delivery_method === 'pickup' && status === 'delivered';
      if (!isOwner && !isBuyerConfirmingPickup) {
      return res.status(403).json({ message: 'You are not allowed to update this delivery' });
    }

    db.query(`UPDATE deliveries SET status = ? WHERE id = ?`, [status, id], (err2) => {
      if (err2) {
        console.error('DELIVERY STATUS UPDATE ERROR:', err2);
        return res.status(500).json({ message: 'Database error' });
      }

      const finishUp = () => {
        notifyDeliveryUpdate(requestId, status);
        res.json({ message: `Delivery marked as ${status}` });
      };

      // Once delivered, the whole request/deal is considered completed,
      // AND the sold amount comes off the original listing's remaining quantity.
      if (status === 'delivered') {
        db.query(
          `UPDATE waste_requests SET status = 'completed' WHERE id = ?`,
          [requestId],
          (err3) => {
            if (err3) console.error('REQUEST COMPLETE UPDATE ERROR:', err3);

            db.query(
              `UPDATE waste_posts SET quantity = GREATEST(quantity - ?, 0) WHERE id = ?`,
              [requested_quantity, waste_id],
              (err4) => {
                if (err4) console.error('WASTE QUANTITY DEDUCT ERROR:', err4);
                finishUp();
              }
            );
          }
        );
      } else {
        finishUp();
      }
    });
  });
});


/* =========================
CHAT - GET MESSAGE HISTORY FOR A REQUEST
Only the buyer or seller involved in this request (or admin) may read it.
========================= */
app.get('/api/messages/:request_id', verifyToken, (req, res) => {
  const request_id = req.params.request_id;

  db.query(
    `SELECT wr.buyer_id, wp.seller_id FROM waste_requests wr
     JOIN waste_posts wp ON wr.waste_id = wp.id
     WHERE wr.id = ?`,
    [request_id],
    (ownErr, ownRows) => {
      if (ownErr) {
        console.error('MESSAGES OWNERSHIP CHECK ERROR:', ownErr);
        return res.status(500).json([]);
      }
      if (ownRows.length === 0) {
        return res.status(404).json({ message: 'Request not found' });
      }
      const { buyer_id, seller_id } = ownRows[0];
      const allowed = req.user.role === 'admin' || req.user.id === buyer_id || req.user.id === seller_id;
      if (!allowed) {
        return res.status(403).json({ message: 'You are not part of this conversation' });
      }

      db.query(
        `SELECT * FROM messages WHERE request_id = ? ORDER BY created_at ASC`,
        [request_id],
        (err, result) => {
          if (err) {
            console.error('FETCH MESSAGES ERROR:', err);
            return res.status(500).json([]);
          }
          res.json(result);
        }
      );
    }
  );
});


/* =========================
FALLBACKS
========================= */
app.use('/api', (req, res) => {
  res.status(404).json({ message: 'API route not found' });
});

app.use((err, req, res, next) => {
  console.error('UNHANDLED ERROR:', err);
  res.status(500).json({ message: 'Something went wrong on the server' });
});

/* =========================
SERVER START
========================= */
const PORT = process.env.PORT || 5000;

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigin }
});

// SOCKET AUTH: every socket connection must present a valid JWT.
// This stops anyone from impersonating another user in chat by
// simply passing a different sender_id from the browser console.
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return next(new Error('Invalid or expired session'));
    socket.userId = decoded.id;
    socket.userRole = decoded.role;
    next();
  });
});

io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id, 'as user', socket.userId);

  // Each logged-in user joins their own personal room (user_<id>)
  // This lets us send a notification directly to them, on ANY page,
  // even if they are not currently inside a specific chat room.
  socket.join(`user_${socket.userId}`);

  socket.on('join_room', (roomId) => {
    // roomId looks like "request_42" — make sure this user is actually
    // the buyer or seller on request 42 before letting them listen in.
    const match = /^request_(\d+)$/.exec(roomId);
    if (!match) return;
    const requestId = match[1];

    db.query(
      `SELECT wr.buyer_id, wp.seller_id FROM waste_requests wr
       JOIN waste_posts wp ON wr.waste_id = wp.id
       WHERE wr.id = ?`,
      [requestId],
      (err, rows) => {
        if (err || rows.length === 0) return;
        const { buyer_id, seller_id } = rows[0];
        if (socket.userId === buyer_id || socket.userId === seller_id) {
          socket.join(roomId);
        }
        // else: silently refuse — don't leak whether the request even exists
      }
    );
  });

  socket.on('send_message', (data) => {
    const { request_id, message } = data;
    const sender_id = socket.userId; // trust the verified socket, not client input

    if (!request_id || !message) return;

    // Make sure this user is actually part of this conversation
    db.query(
      `SELECT wr.buyer_id, wp.seller_id, wp.name AS waste_name
       FROM waste_requests wr
       JOIN waste_posts wp ON wr.waste_id = wp.id
       WHERE wr.id = ?`,
      [request_id],
      (checkErr, rows) => {
        if (checkErr || rows.length === 0) return;
        const { buyer_id, seller_id, waste_name } = rows[0];
        if (sender_id !== buyer_id && sender_id !== seller_id) return; // not your conversation

        db.query(
          `INSERT INTO messages (request_id, sender_id, message) VALUES (?, ?, ?)`,
          [request_id, sender_id, message],
          (err, result) => {
            if (err) {
              console.error('MESSAGE SAVE ERROR:', err);
              return;
            }

            const roomId = `request_${request_id}`;
            const messageData = {
              id: result.insertId,
              request_id,
              sender_id,
              message,
              created_at: new Date()
            };

            // 1) Send to anyone currently INSIDE this chat window (real-time chat)
            io.to(roomId).emit('receive_message', messageData);

            // 2) Notify the other party with a global toast, wherever they are
            const recipientId = sender_id === buyer_id ? seller_id : buyer_id;

            db.query(
              `SELECT full_name FROM users WHERE id = ?`,
              [sender_id],
              (err3, senderRows) => {
                const senderName =
                  !err3 && senderRows.length > 0 ? senderRows[0].full_name : 'Someone';

                io.to(`user_${recipientId}`).emit('new_message_notification', {
                  request_id,
                  sender_id,
                  sender_name: senderName,
                  message,
                  waste_name
                });
              }
            );
          }
        );
      }
    );
  });

  socket.on('disconnect', () => {
    console.log('❌ User disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});