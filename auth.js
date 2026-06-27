require('dotenv').config();
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

if (!JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET is not set in .env — using an insecure fallback. Set it before deploying!');
}
const SECRET = JWT_SECRET || 'insecure_dev_fallback_secret_change_me';

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, full_name: user.full_name },
    SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function verifyToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Login required (no token provided)' });
  }

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).json({ message: 'Session expired or invalid, please login again' });
    }
    req.user = decoded;
    next();
  });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'You are not allowed to do this' });
    }
    next();
  };
}

function requireSelfOrAdmin(paramName) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Login required' });
    }
    const targetId = Number(req.params[paramName]);
    if (req.user.role === 'admin' || req.user.id === targetId) {
      return next();
    }
    return res.status(403).json({ message: 'You can only access your own data' });
  };
}

module.exports = { signToken, verifyToken, requireRole, requireSelfOrAdmin, SECRET };