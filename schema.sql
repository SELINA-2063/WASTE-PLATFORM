-- ============================================================
-- W2REP (Waste to Resource Exchange Platform) — Database Schema
-- ============================================================
-- This file did not exist in the original repo, which made the
-- project impossible to run for anyone who hadn't already built
-- the tables by hand. Run this once to set everything up:
--
--   mysql -u root -p < schema.sql
--
-- It creates the database AND all tables needed by server.js.
-- ============================================================

CREATE DATABASE IF NOT EXISTS w2rep_db
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE w2rep_db;

-- ------------------------------------------------------------
-- USERS  (admin / buyer / seller)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  custom_id     VARCHAR(20)  UNIQUE,                 -- e.g. B-001, S-001, AD-001
  full_name     VARCHAR(150) NOT NULL,
  email         VARCHAR(150) NOT NULL UNIQUE,
  password      VARCHAR(255) NOT NULL,               -- bcrypt hash, never plain text
  phone         VARCHAR(30),
  address       VARCHAR(255),
  role          ENUM('admin','buyer','seller') NOT NULL DEFAULT 'buyer',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- WASTE POSTS  (created by sellers)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS waste_posts (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  seller_id     INT NOT NULL,
  name          VARCHAR(150) NOT NULL,
  type          VARCHAR(100) NOT NULL,
  quantity      DECIMAL(10,2) NOT NULL,
  location      VARCHAR(150),
  description   TEXT,
  image_url     VARCHAR(255) DEFAULT NULL,           -- NEW: photo of the waste item
  status        ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_waste_status (status),
  INDEX idx_waste_type (type),
  INDEX idx_waste_location (location)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- WASTE REQUESTS  (created by buyers against a waste post)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS waste_requests (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  waste_id        INT NOT NULL,
  buyer_id        INT NOT NULL,
  quantity        DECIMAL(10,2) NOT NULL,
  proposed_price  DECIMAL(10,2),
  message         TEXT,
  status          ENUM('pending','accepted','rejected','completed') NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (waste_id) REFERENCES waste_posts(id) ON DELETE CASCADE,
  FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_request_status (status)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- DELIVERIES  (one per accepted request, scheduled by the seller)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deliveries (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  request_id            INT NOT NULL,
  delivery_method       ENUM('pickup','seller_delivery') NOT NULL,
  address               VARCHAR(255),
  scheduled_date        DATE,
  delivery_person_name  VARCHAR(150),
  delivery_person_phone VARCHAR(30),
  notes                 TEXT,
  status                ENUM('scheduled','out_for_delivery','delivered','cancelled') NOT NULL DEFAULT 'scheduled',
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (request_id) REFERENCES waste_requests(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- MESSAGES  (chat between buyer & seller, scoped to a request)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  request_id  INT NOT NULL,
  sender_id   INT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (request_id) REFERENCES waste_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_messages_request (request_id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Optional: a default admin account so /admin-dashboard.html
-- is reachable right after a fresh install.
-- Email: admin@w2rep.com   Password: Admin@123
-- (hash below is bcrypt for "Admin@123" — CHANGE THIS PASSWORD
-- immediately after your first login in production!)
-- ------------------------------------------------------------
INSERT INTO users (custom_id, full_name, email, password, phone, address, role)
SELECT 'AD-001', 'Platform Admin', 'admin@w2rep.com',
       '$2a$10$y/zXkfOt2Dxv1Q7yW9ANZOec0z0/ABpt5Kmag42ml2P4GtHqVWUW2',
       '01700000000', 'Dhaka', 'admin'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'admin@w2rep.com');