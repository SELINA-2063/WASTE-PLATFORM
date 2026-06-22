const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();

app.use(cors());
app.use(express.json());

/* =========================
AUTH - LOGIN
========================= */
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;

  db.query(
    `SELECT * FROM users WHERE email=? AND password=?`,
    [email, password],
    (err, results) => {
      if (err) {
        console.error('LOGIN ERROR:', err);
        return res.status(500).json({ message: 'Database error' });
      }

      if (results.length === 0) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      const u = results[0];

      res.json({
        user: {
          id: u.id,
          full_name: u.full_name,
          email: u.email,
          role: u.role,
          phone: u.phone,
          address: u.address
        }
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
      [full_name, phone, address, email, password, role, customId],
      (err, result) => {
        if (err) {
          console.error('REGISTER ERROR:', err);
          return res.status(500).json({ message: 'Database error' });
        }

        res.status(201).json({
          message: 'User registered successfully',
          userId: result.insertId,
          customId: customId
        });
      }
    );
  });
});


/* =========================
ADMIN - USERS (grouped by role: admin / buyer / seller)
========================= */
app.get('/api/admin/users', (req, res) => {
  db.query(`SELECT * FROM users ORDER BY id ASC`, (err, result) => {
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
app.get('/api/admin/waste', (req, res) => {
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
app.put('/api/admin/waste/:id/status', (req, res) => {
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
app.get('/api/requests', (req, res) => {
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
app.get('/api/seller/dashboard/:id', (req, res) => {
  const id = req.params.id;

  const q1 = `SELECT COUNT(*) AS totalPosts FROM waste_posts WHERE seller_id=?`;

  const q2 = `
    SELECT 
      SUM(CASE WHEN wr.status = 'pending' THEN 1 ELSE 0 END) AS pendingRequests,
      SUM(CASE WHEN wr.status = 'accepted' THEN 1 ELSE 0 END) AS completedDeals
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
app.get('/api/seller/profile/:id', (req, res) => {
  const id = req.params.id;

  db.query(
    `SELECT id, full_name, email, phone, address, role, created_at FROM users WHERE id = ?`,
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
SEARCH WASTE (BUYER)
========================= */
app.get('/api/waste/search', (req, res) => {
  const { type, location, q } = req.query;

  let sql = `
    SELECT wp.*, u.full_name AS seller_name
    FROM waste_posts wp
    JOIN users u ON wp.seller_id = u.id
    WHERE wp.status = 'approved'
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
/* =========================
BUYER - SEND REQUEST
========================= */
app.post('/api/requests', (req, res) => {
  const { waste_id, buyer_id, quantity, message, proposed_price } = req.body;

  if (!waste_id || !buyer_id || !quantity) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const sql = `
    INSERT INTO waste_requests (waste_id, buyer_id, quantity, message, proposed_price, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `;

  db.query(sql, [waste_id, buyer_id, quantity, message || '', proposed_price || 0], (err, result) => {
    if (err) {
      console.error('CREATE REQUEST ERROR:', err);
      return res.status(500).json({ message: 'Database error' });
    }

    res.status(201).json({
      message: 'Request sent successfully',
      requestId: result.insertId
    });
  });
});


/* =========================
BUYER DASHBOARD STATS
========================= */
app.get('/api/buyer/dashboard/:id', (req, res) => {
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
app.get('/api/requests/buyer/:buyer_id', (req, res) => {
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
      u.full_name AS seller_name
    FROM waste_requests wr
    JOIN waste_posts wp ON wr.waste_id = wp.id
    JOIN users u ON wp.seller_id = u.id
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
app.get('/api/buyer/profile/:id', (req, res) => {
  const id = req.params.id;

  db.query(
    `SELECT id, full_name, email, phone, address, role, created_at FROM users WHERE id = ?`,
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
SELLER - MY POSTS (🔥 MISSING ছিল এটা)
========================= */
app.get('/api/waste/my/:seller_id', (req, res) => {
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
WASTE POST (SELLER POST CREATE)
========================= */
app.post('/api/waste/post', (req, res) => {
  console.log("🔥 WASTE POST HIT:", req.body);

  const { name, type, quantity, location, description, seller_id } = req.body;

  if (!name || !type || !quantity || !seller_id) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  // Only users with role = 'seller' are allowed to post waste
  db.query(`SELECT role FROM users WHERE id = ?`, [seller_id], (roleErr, roleResult) => {
    if (roleErr) {
      console.error('ROLE CHECK ERROR:', roleErr);
      return res.status(500).json({ message: 'Database error' });
    }

    if (roleResult.length === 0 || roleResult[0].role !== 'seller') {
      return res.status(403).json({ message: 'Only sellers can post waste' });
    }

    const qty = Number(quantity);

    const sql = `
      INSERT INTO waste_posts (name, type, quantity, location, description, seller_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    db.query(
      sql,
      [name, type, qty, location, description, seller_id],
      (err, result) => {
        if (err) {
          console.error('WASTE POST ERROR:', err);
          return res.status(500).json({ message: 'Database error' });
        }

        res.status(201).json({
          message: 'Waste posted successfully',
          postId: result.insertId
        });
      }
    );
  });
});






//buyer request page
app.get('/api/requests/:seller_id', (req, res) => {
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
      wp.name AS waste_name,
      wp.type AS waste_type,
      u.full_name AS buyer_name
    FROM waste_requests wr
    JOIN waste_posts wp ON wr.waste_id = wp.id
    JOIN users u ON wr.buyer_id = u.id
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

app.put('/api/requests/:id', (req, res) => {
  const id = req.params.id;
  const { status } = req.body;

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
});


/* =========================
CHAT - GET MESSAGE HISTORY FOR A REQUEST
========================= */
app.get('/api/messages/:request_id', (req, res) => {
  const request_id = req.params.request_id;

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
});


/* =========================
SERVER START
========================= */
const PORT = 5000;

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);

  socket.on('join_room', (roomId) => {
    socket.join(roomId);
  });

  socket.on('send_message', (data) => {
    const { request_id, sender_id, message } = data;

    if (!request_id || !sender_id || !message) return;

    db.query(
      `INSERT INTO messages (request_id, sender_id, message) VALUES (?, ?, ?)`,
      [request_id, sender_id, message],
      (err, result) => {
        if (err) {
          console.error('MESSAGE SAVE ERROR:', err);
          return;
        }

        const roomId = `request_${request_id}`;

        io.to(roomId).emit('receive_message', {
          id: result.insertId,
          request_id,
          sender_id,
          message,
          created_at: new Date()
        });
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
