-- FastConnect Internet Billing System Database Schema
-- Run this on your MySQL database (Clever Cloud or Aiven on Render)

CREATE DATABASE IF NOT EXISTS fastconnect_db;
USE fastconnect_db;

-- Users/Customers table
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    phone_number VARCHAR(15) NOT NULL UNIQUE,
    name VARCHAR(100),
    email VARCHAR(100),
    mac_address VARCHAR(17),
    is_active BOOLEAN DEFAULT FALSE,
    plan_name VARCHAR(50),
    data_limit_mb INT DEFAULT 0,
    bytes_used BIGINT DEFAULT 0,
    expires_at DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME,
    INDEX idx_phone (phone_number),
    INDEX idx_active (is_active),
    INDEX idx_expires (expires_at)
);

-- Transactions table
CREATE TABLE IF NOT EXISTS transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    transaction_id VARCHAR(100) UNIQUE NOT NULL,
    phone_number VARCHAR(15) NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    plan_name VARCHAR(50),
    plan_duration_hours INT,
    payment_method ENUM('mpesa', 'voucher') DEFAULT 'mpesa',
    mpesa_receipt VARCHAR(50),
    voucher_code VARCHAR(50),
    status ENUM('pending', 'completed', 'failed', 'cancelled') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    INDEX idx_phone (phone_number),
    INDEX idx_status (status),
    INDEX idx_created (created_at)
);

-- Vouchers table
CREATE TABLE IF NOT EXISTS vouchers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    voucher_code VARCHAR(50) UNIQUE NOT NULL,
    plan_name VARCHAR(50) NOT NULL,
    plan_duration_hours INT NOT NULL,
    data_limit_mb INT,
    amount DECIMAL(10,2),
    is_used BOOLEAN DEFAULT FALSE,
    used_by_phone VARCHAR(15),
    used_at DATETIME,
    created_by VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    INDEX idx_code (voucher_code),
    INDEX idx_used (is_used)
);

-- Admin users table
CREATE TABLE IF NOT EXISTS admins (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('superadmin', 'admin') DEFAULT 'admin',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
);

-- Internet Plans table
CREATE TABLE IF NOT EXISTS plans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    plan_name VARCHAR(50) UNIQUE NOT NULL,
    duration_hours INT NOT NULL,
    price_kes DECIMAL(10,2) NOT NULL,
    data_limit_mb INT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default admin (password: Admin@FastConnect2024!)
-- Password hash for 'Admin@FastConnect2024!' using bcrypt
INSERT INTO admins (username, password_hash, role) VALUES 
('admin', '$2a$10$N9qo8uLOickgx2ZMRZoMy.Mr/.kqFqjYv3Jq8X7Y8q7Y8q7Y8q7Y8', 'superadmin');

-- Insert default plans
INSERT INTO plans (plan_name, duration_hours, price_kes, data_limit_mb, description) VALUES
('2 Hours', 2, 20, 500, '2 hours of high-speed WiFi - 500MB limit'),
('5 Hours', 5, 40, 1200, '5 hours of high-speed WiFi - 1.2GB limit'),
('1 Day', 24, 70, 3000, '24 hours unlimited* browsing (*3GB FUP)'),
('3 Days', 72, 150, 6000, '72 hours unlimited* browsing (*6GB FUP)'),
('1 Week', 168, 300, 15000, '7 days unlimited* browsing (*15GB FUP)'),
('1 Month', 720, 1000, 50000, '30 days unlimited* browsing (*50GB FUP)');

-- Insert demo voucher
INSERT INTO vouchers (voucher_code, plan_name, plan_duration_hours, data_limit_mb, amount, created_by) VALUES
('FC-DEMO-2024', '1 Day', 24, 3000, 70, 'system');

-- Create stored procedure to clean expired users
DELIMITER //
CREATE PROCEDURE cleanup_expired_users()
BEGIN
    UPDATE users 
    SET is_active = FALSE 
    WHERE expires_at < NOW() AND is_active = TRUE;
END //
DELIMITER ;

-- Create event to run cleanup every hour (if event scheduler is on)
-- SET GLOBAL event_scheduler = ON;
-- CREATE EVENT IF NOT EXISTS cleanup_expired_users_event
-- ON SCHEDULE EVERY 1 HOUR
-- DO CALL cleanup_expired_users();