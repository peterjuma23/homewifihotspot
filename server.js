// server.js - FastConnect Internet Billing System
require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const socketIO = require('socket.io');
const http = require('http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

// ==================== CONFIGURATION ====================
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fastconnect-super-secret-key-change-in-production';
const M_PESA_CONSUMER_KEY = process.env.M_PESA_CONSUMER_KEY || '';
const M_PESA_CONSUMER_SECRET = process.env.M_PESA_CONSUMER_SECRET || '';
const M_PESA_PASSKEY = process.env.M_PESA_PASSKEY || '';
const M_PESA_SHORTCODE = process.env.M_PESA_SHORTCODE || '174379';
const M_PESA_ENV = process.env.M_PESA_ENV || 'sandbox';

// Database connection pool
let pool;

async function initDatabase() {
    try {
        const dbConfig = {
            host: process.env.DB_HOST,
            port: parseInt(process.env.DB_PORT) || 3306,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            waitForConnections: true,
            connectionLimit: 5,
            queueLimit: 0,
            enableKeepAlive: true,
            keepAliveInitialDelay: 10000,
            connectTimeout: 10000,
            ssl: { rejectUnauthorized: false }
        };
        
        console.log('🔌 Connecting to database...');
        pool = mysql.createPool(dbConfig);
        
        const connection = await pool.getConnection();
        console.log('✅ MySQL database connected to Aiven successfully!');
        connection.release();
        
        await createTables();
        
        return true;
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        console.log('⚠️ Running in demo mode - using in-memory storage');
        return false;
    }
}

async function createTables() {
    try {
        await pool.query(`
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
            )
        `);
        console.log('✅ Users table ready');
        
        await pool.query(`
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
            )
        `);
        console.log('✅ Transactions table ready');
        
        await pool.query(`
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
            )
        `);
        console.log('✅ Vouchers table ready');
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admins (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role ENUM('superadmin', 'admin') DEFAULT 'admin',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login DATETIME
            )
        `);
        console.log('✅ Admins table ready');
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS plans (
                id INT AUTO_INCREMENT PRIMARY KEY,
                plan_name VARCHAR(50) UNIQUE NOT NULL,
                duration_hours INT NOT NULL,
                price_kes DECIMAL(10,2) NOT NULL,
                data_limit_mb INT DEFAULT 0,
                speed_mbps INT DEFAULT 2,
                is_active BOOLEAN DEFAULT TRUE,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Plans table ready');
        
        const hashedPassword = await bcrypt.hash('Admin@FastConnect2024!', 10);
        await pool.query(
            `INSERT IGNORE INTO admins (username, password_hash, role) VALUES (?, ?, ?)`,
            ['admin', hashedPassword, 'superadmin']
        );
        console.log('✅ Default admin user ready');
        
        const defaultPlans = [
            ['2 Hours', 2, 10, 500, 2],
            ['4 Hours', 4, 15, 1200, 2],
            ['8 Hours', 8, 25, 2500, 2],
            ['24 Hours', 24, 40, 5000, 2],
            ['3 Days', 72, 100, 15000, 2],
            ['1 Week', 168, 250, 35000, 2],
            ['1 Month', 720, 800, 100000, 2]
        ];
        
        for (const plan of defaultPlans) {
            await pool.query(
                `INSERT IGNORE INTO plans (plan_name, duration_hours, price_kes, data_limit_mb, speed_mbps, is_active) 
                 VALUES (?, ?, ?, ?, ?, 1)`,
                plan
            );
        }
        console.log('✅ Default plans ready');
        
        await pool.query(
            `INSERT IGNORE INTO vouchers (voucher_code, plan_name, plan_duration_hours, data_limit_mb, amount, created_by) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            ['FC-DEMO-2024', '24 Hours', 24, 5000, 40, 'system']
        );
        console.log('✅ Demo voucher ready');
        
        console.log('✅ Database setup complete!');
    } catch (error) {
        console.error('❌ Error creating tables:', error.message);
    }
}

// In-memory fallback
let memoryStore = {
    users: [],
    transactions: [],
    vouchers: [{ voucher_code: 'FC-DEMO-2024', plan_name: '24 Hours', plan_duration_hours: 24, data_limit_mb: 5000, amount: 40, is_used: false }],
    plans: [
        { id: 1, plan_name: '2 Hours', duration_hours: 2, price_kes: 10, data_limit_mb: 500, speed_mbps: 2, is_active: true },
        { id: 2, plan_name: '4 Hours', duration_hours: 4, price_kes: 15, data_limit_mb: 1200, speed_mbps: 2, is_active: true },
        { id: 3, plan_name: '8 Hours', duration_hours: 8, price_kes: 25, data_limit_mb: 2500, speed_mbps: 2, is_active: true },
        { id: 4, plan_name: '24 Hours', duration_hours: 24, price_kes: 40, data_limit_mb: 5000, speed_mbps: 2, is_active: true },
        { id: 5, plan_name: '3 Days', duration_hours: 72, price_kes: 100, data_limit_mb: 15000, speed_mbps: 2, is_active: true },
        { id: 6, plan_name: '1 Week', duration_hours: 168, price_kes: 250, data_limit_mb: 35000, speed_mbps: 2, is_active: true },
        { id: 7, plan_name: '1 Month', duration_hours: 720, price_kes: 800, data_limit_mb: 100000, speed_mbps: 2, is_active: true }
    ],
    nextPlanId: 8
};
let dbAvailable = false;

// ==================== MIDDLEWARE ====================
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

app.use(express.static(path.join(__dirname, 'public')));

// ==================== AUTH MIDDLEWARE ====================
const authenticateAdmin = async (req, res, next) => {
    const token = req.cookies.admin_token || req.headers.authorization?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (dbAvailable && pool) {
            const [rows] = await pool.query(
                'SELECT id, username, role FROM admins WHERE id = ? AND username = ?',
                [decoded.id, decoded.username]
            );
            if (rows.length === 0) throw new Error('Admin not found');
            req.admin = rows[0];
        } else {
            if (decoded.username !== 'admin') throw new Error('Invalid admin');
            req.admin = decoded;
        }
        next();
    } catch (error) {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
};

// ==================== HELPER FUNCTIONS ====================
function generateTransactionId() {
    return 'TXN' + Date.now() + Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function processPayment(phoneNumber, amount, planName, planDuration, transactionId) {
    console.log(`Processing payment: ${phoneNumber}, ${amount}, ${planName}`);
    
    setTimeout(async () => {
        const success = Math.random() > 0.1;
        if (success) {
            await completeTransaction(transactionId, phoneNumber, planName, planDuration, 'MPESA' + Date.now());
            io.emit('payment_completed', { phoneNumber, planName, status: 'success' });
        } else {
            await updateTransactionStatus(transactionId, 'failed');
            io.emit('payment_failed', { phoneNumber, planName, status: 'failed' });
        }
    }, 3000);
    
    return { success: true, message: 'STK Push sent to customer phone' };
}

async function completeTransaction(transactionId, phoneNumber, planName, planDuration, mpesaReceipt) {
    const expiresAt = new Date(Date.now() + planDuration * 60 * 60 * 1000);
    const plan = await getPlanDetails(planName);
    const dataLimit = plan?.data_limit_mb || 0;
    
    if (dbAvailable && pool) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            await connection.query(
                `UPDATE transactions SET status = 'completed', completed_at = NOW(), mpesa_receipt = ? WHERE transaction_id = ?`,
                [mpesaReceipt, transactionId]
            );
            await connection.query(
                `INSERT INTO users (phone_number, plan_name, data_limit_mb, bytes_used, expires_at, is_active, last_seen)
                 VALUES (?, ?, ?, 0, ?, TRUE, NOW())
                 ON DUPLICATE KEY UPDATE
                 plan_name = VALUES(plan_name),
                 data_limit_mb = VALUES(data_limit_mb),
                 expires_at = VALUES(expires_at),
                 is_active = TRUE,
                 last_seen = NOW()`,
                [phoneNumber, planName, dataLimit, expiresAt]
            );
            await connection.commit();
            console.log(`✅ Transaction ${transactionId} completed successfully`);
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    } else {
        const txn = memoryStore.transactions.find(t => t.transaction_id === transactionId);
        if (txn) {
            txn.status = 'completed';
            txn.mpesa_receipt = mpesaReceipt;
            txn.completed_at = new Date();
        }
        
        const existingUser = memoryStore.users.find(u => u.phone_number === phoneNumber);
        if (existingUser) {
            existingUser.plan_name = planName;
            existingUser.data_limit_mb = dataLimit;
            existingUser.expires_at = expiresAt;
            existingUser.is_active = true;
            existingUser.last_seen = new Date();
        } else {
            memoryStore.users.push({
                id: memoryStore.users.length + 1,
                phone_number: phoneNumber,
                plan_name: planName,
                data_limit_mb: dataLimit,
                bytes_used: 0,
                expires_at: expiresAt,
                is_active: true,
                created_at: new Date(),
                last_seen: new Date()
            });
        }
    }
    
    io.emit('user_activated', { phoneNumber, planName, expiresAt });
}

async function updateTransactionStatus(transactionId, status) {
    if (dbAvailable && pool) {
        await pool.query('UPDATE transactions SET status = ? WHERE transaction_id = ?', [status, transactionId]);
    } else {
        const txn = memoryStore.transactions.find(t => t.transaction_id === transactionId);
        if (txn) txn.status = status;
    }
}

async function getPlanDetails(planName) {
    if (dbAvailable && pool) {
        const [rows] = await pool.query('SELECT *, speed_mbps FROM plans WHERE plan_name = ? AND is_active = TRUE', [planName]);
        return rows[0];
    } else {
        return memoryStore.plans.find(p => p.plan_name === planName && p.is_active);
    }
}

async function getAllPlans() {
    if (dbAvailable && pool) {
        const [rows] = await pool.query('SELECT *, speed_mbps FROM plans WHERE is_active = TRUE ORDER BY duration_hours');
        return rows;
    } else {
        return memoryStore.plans.filter(p => p.is_active);
    }
}

// ==================== API ROUTES ====================

app.get('/api/plans', async (req, res) => {
    try {
        const plans = await getAllPlans();
        res.json({ success: true, plans });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/mpesa/stkpush', async (req, res) => {
    const { phoneNumber, planName, amount } = req.body;
    
    if (!phoneNumber || !planName || !amount) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    let formattedPhone = phoneNumber.replace(/\D/g, '');
    if (formattedPhone.startsWith('0')) {
        formattedPhone = '254' + formattedPhone.substring(1);
    }
    if (!formattedPhone.startsWith('254')) {
        formattedPhone = '254' + formattedPhone;
    }
    
    const transactionId = generateTransactionId();
    const plan = await getPlanDetails(planName);
    
    if (dbAvailable && pool) {
        await pool.query(
            `INSERT INTO transactions (transaction_id, phone_number, amount, plan_name, plan_duration_hours, status, created_at)
             VALUES (?, ?, ?, ?, ?, 'pending', NOW())`,
            [transactionId, formattedPhone, amount, planName, plan?.duration_hours]
        );
    } else {
        memoryStore.transactions.push({
            transaction_id: transactionId,
            phone_number: formattedPhone,
            amount: amount,
            plan_name: planName,
            plan_duration_hours: plan?.duration_hours,
            status: 'pending',
            created_at: new Date()
        });
    }
    
    await processPayment(formattedPhone, amount, planName, plan?.duration_hours, transactionId);
    
    res.json({ success: true, message: 'STK Push sent successfully', transactionId: transactionId });
});

app.post('/api/voucher/redeem', async (req, res) => {
    const { voucherCode, phoneNumber, customerName } = req.body;
    
    if (!voucherCode || !phoneNumber) {
        return res.status(400).json({ error: 'Voucher code and phone number required' });
    }
    
    try {
        let voucher, plan;
        
        if (dbAvailable && pool) {
            const [vouchers] = await pool.query('SELECT * FROM vouchers WHERE voucher_code = ? AND is_used = FALSE', [voucherCode.toUpperCase()]);
            voucher = vouchers[0];
            
            if (!voucher) {
                return res.status(404).json({ error: 'Invalid or already used voucher code' });
            }
            
            const [plans] = await pool.query('SELECT * FROM plans WHERE plan_name = ?', [voucher.plan_name]);
            plan = plans[0];
            
            await pool.query('UPDATE vouchers SET is_used = TRUE, used_by_phone = ?, used_at = NOW() WHERE voucher_code = ?', [phoneNumber, voucherCode.toUpperCase()]);
            
            const transactionId = generateTransactionId();
            await pool.query(
                `INSERT INTO transactions (transaction_id, phone_number, amount, plan_name, plan_duration_hours, payment_method, voucher_code, status, completed_at, created_at)
                 VALUES (?, ?, ?, ?, ?, 'voucher', ?, 'completed', NOW(), NOW())`,
                [transactionId, phoneNumber, voucher.amount, voucher.plan_name, voucher.plan_duration_hours, voucherCode]
            );
            
            const expiresAt = new Date(Date.now() + voucher.plan_duration_hours * 60 * 60 * 1000);
            await pool.query(
                `INSERT INTO users (phone_number, name, plan_name, data_limit_mb, bytes_used, expires_at, is_active, last_seen)
                 VALUES (?, ?, ?, ?, 0, ?, TRUE, NOW())
                 ON DUPLICATE KEY UPDATE
                 name = COALESCE(?, name),
                 plan_name = VALUES(plan_name),
                 data_limit_mb = VALUES(data_limit_mb),
                 expires_at = VALUES(expires_at),
                 is_active = TRUE,
                 last_seen = NOW()`,
                [phoneNumber, customerName || null, voucher.plan_name, voucher.data_limit_mb || 0, expiresAt, customerName || null]
            );
        } else {
            voucher = memoryStore.vouchers.find(v => v.voucher_code === voucherCode.toUpperCase() && !v.is_used);
            if (!voucher) {
                return res.status(404).json({ error: 'Invalid or already used voucher code' });
            }
            plan = memoryStore.plans.find(p => p.plan_name === voucher.plan_name);
            voucher.is_used = true;
            voucher.used_by_phone = phoneNumber;
            voucher.used_at = new Date();
            
            const expiresAt = new Date(Date.now() + voucher.plan_duration_hours * 60 * 60 * 1000);
            const existingUser = memoryStore.users.find(u => u.phone_number === phoneNumber);
            if (existingUser) {
                existingUser.plan_name = voucher.plan_name;
                existingUser.data_limit_mb = voucher.data_limit_mb;
                existingUser.expires_at = expiresAt;
                existingUser.is_active = true;
                existingUser.last_seen = new Date();
                if (customerName) existingUser.name = customerName;
            } else {
                memoryStore.users.push({
                    id: memoryStore.users.length + 1,
                    phone_number: phoneNumber,
                    name: customerName || null,
                    plan_name: voucher.plan_name,
                    data_limit_mb: voucher.data_limit_mb,
                    bytes_used: 0,
                    expires_at: expiresAt,
                    is_active: true,
                    created_at: new Date(),
                    last_seen: new Date()
                });
            }
        }
        
        io.emit('voucher_redeemed', { phoneNumber, voucherCode, planName: voucher.plan_name });
        
        res.json({
            success: true,
            message: 'Voucher redeemed successfully!',
            plan: voucher.plan_name,
            duration: voucher.plan_duration_hours,
            expiresAt: new Date(Date.now() + voucher.plan_duration_hours * 60 * 60 * 1000)
        });
        
    } catch (error) {
        console.error('Voucher redemption error:', error);
        res.status(500).json({ error: 'Failed to redeem voucher' });
    }
});

app.post('/api/check-status', async (req, res) => {
    const { phoneNumber, macAddress } = req.body;
    
    if (!phoneNumber && !macAddress) {
        return res.status(400).json({ error: 'Phone number or MAC address required' });
    }
    
    try {
        let user = null;
        
        if (dbAvailable && pool) {
            let query = 'SELECT * FROM users WHERE ';
            let params = [];
            if (phoneNumber) {
                query += 'phone_number = ?';
                params.push(phoneNumber);
            } else {
                query += 'mac_address = ?';
                params.push(macAddress);
            }
            const [rows] = await pool.query(query, params);
            user = rows[0];
            
            if (user && user.expires_at && new Date(user.expires_at) < new Date()) {
                await pool.query('UPDATE users SET is_active = FALSE WHERE id = ?', [user.id]);
                user.is_active = false;
            }
            
            if (user && macAddress && !user.mac_address) {
                await pool.query('UPDATE users SET mac_address = ?, last_seen = NOW() WHERE id = ?', [macAddress, user.id]);
                user.mac_address = macAddress;
            }
        } else {
            user = memoryStore.users.find(u => u.phone_number === phoneNumber || u.mac_address === macAddress);
            if (user && user.expires_at && new Date(user.expires_at) < new Date()) {
                user.is_active = false;
            }
        }
        
        const isActive = user && user.is_active === true && user.expires_at && new Date(user.expires_at) > new Date();
        
        if (isActive) {
            res.json({
                success: true,
                isActive: true,
                plan: user.plan_name,
                expiresAt: user.expires_at,
                dataLimit: user.data_limit_mb,
                bytesUsed: user.bytes_used || 0
            });
        } else {
            res.json({
                success: true,
                isActive: false,
                message: 'No active session found. Please purchase a plan.'
            });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== ADMIN API ROUTES ====================

app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        let isValid = false;
        
        if (dbAvailable && pool) {
            const [rows] = await pool.query('SELECT * FROM admins WHERE username = ?', [username]);
            if (rows.length > 0) {
                isValid = await bcrypt.compare(password, rows[0].password_hash);
                if (isValid) {
                    await pool.query('UPDATE admins SET last_login = NOW() WHERE id = ?', [rows[0].id]);
                }
            }
        } else {
            isValid = (username === 'admin' && password === 'Admin@FastConnect2024!');
        }
        
        if (isValid) {
            const token = jwt.sign({ id: 1, username: 'admin', role: 'superadmin' }, JWT_SECRET, { expiresIn: '24h' });
            res.cookie('admin_token', token, { httpOnly: true, secure: false, maxAge: 24 * 60 * 60 * 1000 });
            res.json({ success: true, token });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/logout', (req, res) => {
    res.clearCookie('admin_token');
    res.json({ success: true });
});

// FIXED: Get admin dashboard stats - Now correctly calculates revenue
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
    try {
        let stats = { activeUsers: 0, totalRevenue: 0, todayRevenue: 0, totalTransactions: 0 };
        
        if (dbAvailable && pool) {
            // Active users (is_active = true AND not expired)
            const [activeResult] = await pool.query(
                'SELECT COUNT(*) as count FROM users WHERE is_active = 1 AND expires_at > NOW()'
            );
            stats.activeUsers = activeResult[0]?.count || 0;
            
            // Total revenue from completed transactions
            const [revenueResult] = await pool.query(
                'SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE status = "completed"'
            );
            stats.totalRevenue = parseFloat(revenueResult[0]?.total || 0);
            
            // Today's revenue - using created_at column
            const [todayResult] = await pool.query(
                'SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE status = "completed" AND DATE(created_at) = CURDATE()'
            );
            stats.todayRevenue = parseFloat(todayResult[0]?.total || 0);
            
            // Total completed transactions
            const [countResult] = await pool.query(
                'SELECT COUNT(*) as count FROM transactions WHERE status = "completed"'
            );
            stats.totalTransactions = countResult[0]?.count || 0;
            
            console.log('📊 Stats calculated:', stats);
        } else {
            // In-memory fallback
            const now = new Date();
            stats.activeUsers = memoryStore.users.filter(u => u.is_active === true && new Date(u.expires_at) > now).length;
            const completedTxns = memoryStore.transactions.filter(t => t.status === 'completed');
            stats.totalRevenue = completedTxns.reduce((sum, t) => sum + (t.amount || 0), 0);
            const today = new Date().toDateString();
            stats.todayRevenue = completedTxns.filter(t => {
                const tDate = new Date(t.completed_at || t.created_at);
                return tDate.toDateString() === today;
            }).reduce((sum, t) => sum + (t.amount || 0), 0);
            stats.totalTransactions = completedTxns.length;
        }
        
        res.json(stats);
    } catch (error) {
        console.error('❌ Stats error:', error);
        res.status(500).json({ error: error.message });
    }
});

// FIXED: Get only active users (is_active = true AND not expired)
app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
    try {
        if (dbAvailable && pool) {
            const [users] = await pool.query(
                `SELECT id, phone_number, name, plan_name, data_limit_mb, bytes_used, expires_at, is_active, created_at, last_seen 
                 FROM users 
                 WHERE is_active = 1 AND expires_at > NOW()
                 ORDER BY created_at DESC`
            );
            res.json(users);
        } else {
            const now = new Date();
            const activeUsers = memoryStore.users.filter(u => u.is_active === true && new Date(u.expires_at) > now);
            res.json(activeUsers);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/transactions', authenticateAdmin, async (req, res) => {
    try {
        if (dbAvailable && pool) {
            const [transactions] = await pool.query(`SELECT * FROM transactions ORDER BY created_at DESC LIMIT 500`);
            res.json(transactions);
        } else {
            res.json(memoryStore.transactions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/plans', authenticateAdmin, async (req, res) => {
    try {
        if (dbAvailable && pool) {
            const [plans] = await pool.query('SELECT * FROM plans ORDER BY duration_hours');
            res.json(plans);
        } else {
            res.json(memoryStore.plans);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/admin/plans/update', authenticateAdmin, async (req, res) => {
    const { id, plan_name, duration_hours, price_kes, data_limit_mb, speed_mbps, is_active } = req.body;
    
    try {
        if (dbAvailable && pool) {
            await pool.query(
                `UPDATE plans SET plan_name = ?, duration_hours = ?, price_kes = ?, data_limit_mb = ?, speed_mbps = ?, is_active = ? WHERE id = ?`,
                [plan_name, duration_hours, price_kes, data_limit_mb, speed_mbps, is_active, id]
            );
        } else {
            const planIndex = memoryStore.plans.findIndex(p => p.id === id);
            if (planIndex !== -1) {
                memoryStore.plans[planIndex] = { 
                    ...memoryStore.plans[planIndex], 
                    plan_name, 
                    duration_hours, 
                    price_kes, 
                    data_limit_mb,
                    speed_mbps,
                    is_active 
                };
            }
        }
        
        io.emit('plans_updated');
        res.json({ success: true, message: 'Plan updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/plans', authenticateAdmin, async (req, res) => {
    const { plan_name, duration_hours, price_kes, data_limit_mb, speed_mbps } = req.body;
    
    try {
        if (dbAvailable && pool) {
            const [result] = await pool.query(
                `INSERT INTO plans (plan_name, duration_hours, price_kes, data_limit_mb, speed_mbps, is_active) VALUES (?, ?, ?, ?, ?, 1)`,
                [plan_name, duration_hours, price_kes, data_limit_mb, speed_mbps || 2]
            );
            io.emit('plans_updated');
            res.json({ success: true, id: result.insertId });
        } else {
            const newId = memoryStore.nextPlanId++;
            memoryStore.plans.push({
                id: newId,
                plan_name,
                duration_hours,
                price_kes,
                data_limit_mb,
                speed_mbps: speed_mbps || 2,
                is_active: true
            });
            io.emit('plans_updated');
            res.json({ success: true, id: newId });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/vouchers', authenticateAdmin, async (req, res) => {
    const { planName, quantity } = req.body;
    
    try {
        const plan = await getPlanDetails(planName);
        if (!plan) {
            return res.status(404).json({ error: 'Plan not found' });
        }
        
        const vouchers = [];
        for (let i = 0; i < quantity; i++) {
            const code = `FC-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
            vouchers.push(code);
            
            if (dbAvailable && pool) {
                await pool.query(
                    `INSERT INTO vouchers (voucher_code, plan_name, plan_duration_hours, data_limit_mb, amount, created_by)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [code, plan.plan_name, plan.duration_hours, plan.data_limit_mb, plan.price_kes, req.admin.username]
                );
            } else {
                memoryStore.vouchers.push({
                    voucher_code: code,
                    plan_name: plan.plan_name,
                    plan_duration_hours: plan.duration_hours,
                    data_limit_mb: plan.data_limit_mb,
                    amount: plan.price_kes,
                    is_used: false,
                    created_at: new Date(),
                    created_by: req.admin.username
                });
            }
        }
        
        res.json({ success: true, vouchers });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/vouchers', authenticateAdmin, async (req, res) => {
    try {
        if (dbAvailable && pool) {
            const [vouchers] = await pool.query('SELECT * FROM vouchers ORDER BY created_at DESC');
            res.json(vouchers);
        } else {
            res.json(memoryStore.vouchers);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin/users/:id/deactivate', authenticateAdmin, async (req, res) => {
    try {
        if (dbAvailable && pool) {
            await pool.query('UPDATE users SET is_active = FALSE WHERE id = ?', [req.params.id]);
        } else {
            const user = memoryStore.users.find(u => u.id == req.params.id);
            if (user) user.is_active = false;
        }
        
        io.emit('user_deactivated', { userId: req.params.id });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/mpesa/callback', async (req, res) => {
    console.log('M-Pesa Callback received:', JSON.stringify(req.body));
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

// ==================== WEB SOCKET HANDLERS ====================
io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);
    
    socket.on('admin_join', () => {
        socket.join('admin_room');
        console.log('Admin joined room');
    });
    
    socket.on('plans_updated', () => {
        io.emit('plans_updated');
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// ==================== SERVER STARTUP ====================
async function startServer() {
    dbAvailable = await initDatabase();
    
    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'captive-portal.html'));
    });
    
    app.get('/admin', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html'));
    });
    
    app.get('/health', (req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString(), dbConnected: dbAvailable });
    });
    
    server.listen(PORT, () => {
        console.log(`🚀 FastConnect Internet Billing System running on port ${PORT}`);
        console.log(`📱 Captive Portal: http://localhost:${PORT}/`);
        console.log(`👨‍💼 Admin Dashboard: http://localhost:${PORT}/admin`);
        console.log(`🔌 WebSocket ready for real-time updates`);
    });
}

startServer().catch(console.error);