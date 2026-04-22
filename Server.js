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
const M_PESA_ENV = process.env.M_PESA_ENV || 'sandbox'; // sandbox or production
const BUSINESS_SHORT_CODE = M_PESA_SHORTCODE;
const CALLBACK_URL = process.env.CALLBACK_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/api/mpesa/callback`;

// Database connection pool
let pool;

async function initDatabase() {
    try {
        pool = mysql.createPool({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'fastconnect_db',
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            enableKeepAlive: true,
            keepAliveInitialDelay: 0
        });
        
        // Test connection
        const connection = await pool.getConnection();
        console.log('✅ MySQL database connected');
        connection.release();
        
        // Run cleanup on startup
        await pool.execute('CALL cleanup_expired_users()');
        
        return true;
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        console.log('⚠️ Running in demo mode - using in-memory storage');
        return false;
    }
}

// In-memory fallback when DB is not available
let memoryStore = {
    users: [],
    transactions: [],
    vouchers: [{ voucher_code: 'FC-DEMO-2024', plan_name: '1 Day', plan_duration_hours: 24, data_limit_mb: 3000, is_used: false }],
    plans: [
        { plan_name: '2 Hours', duration_hours: 2, price_kes: 20, data_limit_mb: 500 },
        { plan_name: '5 Hours', duration_hours: 5, price_kes: 40, data_limit_mb: 1200 },
        { plan_name: '1 Day', duration_hours: 24, price_kes: 70, data_limit_mb: 3000 },
        { plan_name: '3 Days', duration_hours: 72, price_kes: 150, data_limit_mb: 6000 },
        { plan_name: '1 Week', duration_hours: 168, price_kes: 300, data_limit_mb: 15000 },
        { plan_name: '1 Month', duration_hours: 720, price_kes: 1000, data_limit_mb: 50000 }
    ]
};
let dbAvailable = false;

// ==================== MIDDLEWARE ====================
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Cache control headers for captive portal
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Serve static files
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
            const [rows] = await pool.execute(
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

function getMpesaAccessToken() {
    if (!M_PESA_CONSUMER_KEY || !M_PESA_CONSUMER_SECRET) {
        return Promise.reject(new Error('M-Pesa credentials not configured'));
    }
    const auth = Buffer.from(`${M_PESA_CONSUMER_KEY}:${M_PESA_CONSUMER_SECRET}`).toString('base64');
    const url = M_PESA_ENV === 'sandbox' 
        ? 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
        : 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
    
    return axios.get(url, {
        headers: { Authorization: `Basic ${auth}` }
    }).then(response => response.data.access_token);
}

async function processPayment(phoneNumber, amount, planName, planDuration, transactionId) {
    // This is a mock implementation for Render free tier
    // For real M-Pesa, you'd call the STK Push API
    console.log(`Processing payment: ${phoneNumber}, ${amount}, ${planName}`);
    
    // Simulate async payment processing
    setTimeout(async () => {
        const success = Math.random() > 0.1; // 90% success rate for demo
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
            
            // Update transaction
            await connection.execute(
                `UPDATE transactions SET status = 'completed', completed_at = NOW(), mpesa_receipt = ? 
                 WHERE transaction_id = ?`,
                [mpesaReceipt, transactionId]
            );
            
            // Upsert user
            await connection.execute(
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
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    } else {
        // In-memory update
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
    
    // Notify all admins via WebSocket
    io.emit('user_activated', { phoneNumber, planName, expiresAt });
}

async function updateTransactionStatus(transactionId, status) {
    if (dbAvailable && pool) {
        await pool.execute(
            'UPDATE transactions SET status = ? WHERE transaction_id = ?',
            [status, transactionId]
        );
    } else {
        const txn = memoryStore.transactions.find(t => t.transaction_id === transactionId);
        if (txn) txn.status = status;
    }
}

async function getPlanDetails(planName) {
    if (dbAvailable && pool) {
        const [rows] = await pool.execute('SELECT * FROM plans WHERE plan_name = ?', [planName]);
        return rows[0];
    } else {
        return memoryStore.plans.find(p => p.plan_name === planName);
    }
}

async function getAllPlans() {
    if (dbAvailable && pool) {
        const [rows] = await pool.execute('SELECT * FROM plans WHERE is_active = TRUE');
        return rows;
    } else {
        return memoryStore.plans;
    }
}

// ==================== API ROUTES ====================

// Get all available plans
app.get('/api/plans', async (req, res) => {
    try {
        const plans = await getAllPlans();
        res.json({ success: true, plans });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Initiate M-Pesa payment
app.post('/api/mpesa/stkpush', async (req, res) => {
    const { phoneNumber, planName, amount } = req.body;
    
    if (!phoneNumber || !planName || !amount) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Format phone number (2547XXXXXXXX)
    let formattedPhone = phoneNumber.replace(/\D/g, '');
    if (formattedPhone.startsWith('0')) {
        formattedPhone = '254' + formattedPhone.substring(1);
    }
    if (!formattedPhone.startsWith('254')) {
        formattedPhone = '254' + formattedPhone;
    }
    
    const transactionId = generateTransactionId();
    const plan = await getPlanDetails(planName);
    
    // Save transaction
    if (dbAvailable && pool) {
        await pool.execute(
            `INSERT INTO transactions (transaction_id, phone_number, amount, plan_name, plan_duration_hours, status)
             VALUES (?, ?, ?, ?, ?, 'pending')`,
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
    
    // Process payment
    const paymentResult = await processPayment(formattedPhone, amount, planName, plan?.duration_hours, transactionId);
    
    res.json({
        success: true,
        message: 'STK Push sent successfully',
        transactionId: transactionId
    });
});

// Redeem voucher
app.post('/api/voucher/redeem', async (req, res) => {
    const { voucherCode, phoneNumber, customerName } = req.body;
    
    if (!voucherCode || !phoneNumber) {
        return res.status(400).json({ error: 'Voucher code and phone number required' });
    }
    
    try {
        let voucher, plan;
        
        if (dbAvailable && pool) {
            const [vouchers] = await pool.execute(
                'SELECT * FROM vouchers WHERE voucher_code = ? AND is_used = FALSE',
                [voucherCode.toUpperCase()]
            );
            voucher = vouchers[0];
            
            if (!voucher) {
                return res.status(404).json({ error: 'Invalid or already used voucher code' });
            }
            
            const [plans] = await pool.execute('SELECT * FROM plans WHERE plan_name = ?', [voucher.plan_name]);
            plan = plans[0];
            
            // Mark voucher as used
            await pool.execute(
                'UPDATE vouchers SET is_used = TRUE, used_by_phone = ?, used_at = NOW() WHERE voucher_code = ?',
                [phoneNumber, voucherCode.toUpperCase()]
            );
            
            // Create transaction record
            const transactionId = generateTransactionId();
            await pool.execute(
                `INSERT INTO transactions (transaction_id, phone_number, amount, plan_name, plan_duration_hours, payment_method, voucher_code, status, completed_at)
                 VALUES (?, ?, ?, ?, ?, 'voucher', ?, 'completed', NOW())`,
                [transactionId, phoneNumber, voucher.amount, voucher.plan_name, voucher.plan_duration_hours, voucherCode]
            );
            
            // Activate user
            const expiresAt = new Date(Date.now() + voucher.plan_duration_hours * 60 * 60 * 1000);
            await pool.execute(
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
            // In-memory voucher redemption
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

// Check user status (for captive portal)
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
            const [rows] = await pool.execute(query, params);
            user = rows[0];
            
            if (user && user.expires_at && new Date(user.expires_at) < new Date()) {
                await pool.execute('UPDATE users SET is_active = FALSE WHERE id = ?', [user.id]);
                user.is_active = false;
            }
            
            if (user && macAddress && !user.mac_address) {
                await pool.execute('UPDATE users SET mac_address = ?, last_seen = NOW() WHERE id = ?', [macAddress, user.id]);
                user.mac_address = macAddress;
            }
        } else {
            user = memoryStore.users.find(u => u.phone_number === phoneNumber || u.mac_address === macAddress);
            if (user && user.expires_at && new Date(user.expires_at) < new Date()) {
                user.is_active = false;
            }
        }
        
        if (user && user.is_active && new Date(user.expires_at) > new Date()) {
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

// Admin login
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        let isValid = false;
        
        if (dbAvailable && pool) {
            const [rows] = await pool.execute('SELECT * FROM admins WHERE username = ?', [username]);
            if (rows.length > 0) {
                isValid = await bcrypt.compare(password, rows[0].password_hash);
                if (isValid) {
                    await pool.execute('UPDATE admins SET last_login = NOW() WHERE id = ?', [rows[0].id]);
                }
            }
        } else {
            // Default admin check for demo
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

// Admin logout
app.post('/api/admin/logout', (req, res) => {
    res.clearCookie('admin_token');
    res.json({ success: true });
});

// Get admin dashboard stats
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
    try {
        let stats = { activeUsers: 0, totalRevenue: 0, todayRevenue: 0, totalTransactions: 0 };
        
        if (dbAvailable && pool) {
            const [activeCount] = await pool.execute('SELECT COUNT(*) as count FROM users WHERE is_active = TRUE AND expires_at > NOW()');
            stats.activeUsers = activeCount[0].count;
            
            const [revenue] = await pool.execute('SELECT SUM(amount) as total FROM transactions WHERE status = "completed"');
            stats.totalRevenue = revenue[0].total || 0;
            
            const [todayRevenue] = await pool.execute('SELECT SUM(amount) as total FROM transactions WHERE status = "completed" AND DATE(completed_at) = CURDATE()');
            stats.todayRevenue = todayRevenue[0].total || 0;
            
            const [txnCount] = await pool.execute('SELECT COUNT(*) as count FROM transactions WHERE status = "completed"');
            stats.totalTransactions = txnCount[0].count;
        } else {
            stats.activeUsers = memoryStore.users.filter(u => u.is_active && new Date(u.expires_at) > new Date()).length;
            const completedTxns = memoryStore.transactions.filter(t => t.status === 'completed');
            stats.totalRevenue = completedTxns.reduce((sum, t) => sum + (t.amount || 0), 0);
            stats.todayRevenue = completedTxns.filter(t => {
                const today = new Date().toDateString();
                return new Date(t.completed_at || t.created_at).toDateString() === today;
            }).reduce((sum, t) => sum + (t.amount || 0), 0);
            stats.totalTransactions = completedTxns.length;
        }
        
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get all active users
app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
    try {
        if (dbAvailable && pool) {
            const [users] = await pool.execute(
                `SELECT id, phone_number, name, plan_name, data_limit_mb, bytes_used, expires_at, is_active, created_at, last_seen 
                 FROM users WHERE is_active = TRUE OR expires_at > NOW()
                 ORDER BY created_at DESC`
            );
            res.json(users);
        } else {
            const activeUsers = memoryStore.users.filter(u => u.is_active || new Date(u.expires_at) > new Date());
            res.json(activeUsers);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get all transactions
app.get('/api/admin/transactions', authenticateAdmin, async (req, res) => {
    try {
        if (dbAvailable && pool) {
            const [transactions] = await pool.execute(
                `SELECT * FROM transactions ORDER BY created_at DESC LIMIT 500`
            );
            res.json(transactions);
        } else {
            res.json(memoryStore.transactions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create voucher
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
                await pool.execute(
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

// Get all vouchers
app.get('/api/admin/vouchers', authenticateAdmin, async (req, res) => {
    try {
        if (dbAvailable && pool) {
            const [vouchers] = await pool.execute('SELECT * FROM vouchers ORDER BY created_at DESC');
            res.json(vouchers);
        } else {
            res.json(memoryStore.vouchers);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Deactivate user (disconnect)
app.post('/api/admin/users/:id/deactivate', authenticateAdmin, async (req, res) => {
    try {
        if (dbAvailable && pool) {
            await pool.execute('UPDATE users SET is_active = FALSE WHERE id = ?', [req.params.id]);
        } else {
            const user = memoryStore.users.find(u => u.id == req.params.id);
            if (user) user.is_active = false;
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// M-Pesa Callback endpoint
app.post('/api/mpesa/callback', async (req, res) => {
    console.log('M-Pesa Callback received:', JSON.stringify(req.body));
    // Process callback and update transaction
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

// ==================== WEB SOCKET HANDLERS ====================
io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);
    
    socket.on('admin_join', () => {
        socket.join('admin_room');
        console.log('Admin joined room');
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// ==================== SERVER STARTUP ====================
async function startServer() {
    dbAvailable = await initDatabase();
    
    // Serve HTML pages
    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'captive-portal.html'));
    });
    
    app.get('/admin', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html'));
    });
    
    // Health check for Render
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