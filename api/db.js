import { Pool } from 'pg';
import crypto from 'crypto';

const pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

const ADMIN_USERNAME = 'Admin';
const COMMISSION_PERCENT = 10;

let schemaReady = false;

async function ensureSchema() {
    if (schemaReady) return;

    await pool.query(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'buyer',
        shop_id TEXT,
        approved BOOLEAN DEFAULT FALSE,
        pending BOOLEAN DEFAULT FALSE,
        blocked BOOLEAN DEFAULT FALSE
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS shops (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        approved BOOLEAN DEFAULT FALSE,
        pending BOOLEAN DEFAULT TRUE,
        rating NUMERIC DEFAULT 0,
        review_count INTEGER DEFAULT 0
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        shop_name TEXT NOT NULL,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        icon TEXT DEFAULT '📦',
        price_ar INTEGER NOT NULL,
        stock INTEGER NOT NULL DEFAULT 0,
        seller TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        status TEXT DEFAULT 'pending',
        rating NUMERIC DEFAULT 0,
        review_count INTEGER DEFAULT 0,
        sales INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS carts (
        user_id TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
        items JSONB NOT NULL DEFAULT '[]'
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        buyer TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        seller TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        items JSONB NOT NULL,
        total_ar INTEGER NOT NULL,
        total_diamonds INTEGER NOT NULL,
        currency TEXT NOT NULL,
        pickup TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        payment_method TEXT DEFAULT 'cash',
        created_at TIMESTAMP DEFAULT NOW()
    )`);

    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier TEXT`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);

    await pool.query(`CREATE TABLE IF NOT EXISTS orders_archive (
        id TEXT PRIMARY KEY,
        buyer TEXT NOT NULL,
        seller TEXT NOT NULL,
        items JSONB NOT NULL,
        total_ar INTEGER NOT NULL,
        total_diamonds INTEGER NOT NULL,
        currency TEXT NOT NULL,
        pickup TEXT NOT NULL,
        status TEXT NOT NULL,
        payment_method TEXT DEFAULT 'cash',
        created_at TIMESTAMP NOT NULL,
        archived_at TIMESTAMP DEFAULT NOW()
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS pickup_points (
        name TEXT PRIMARY KEY
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS banned_users (
        username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS rules (
        id SERIAL PRIMARY KEY,
        rule_text TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS wishlist (
        user_id TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, product_id)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS balances (
        username TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
        balance INTEGER NOT NULL DEFAULT 0
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        type TEXT NOT NULL,
        amount INTEGER NOT NULL,
        description TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS admin_sessions (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        ip TEXT,
        created_at TIMESTAMP DEFAULT NOW()
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS pending_commissions (
        seller TEXT PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
        amount INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS withdraw_requests (
        id SERIAL PRIMARY KEY,
        seller TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        amount INTEGER NOT NULL,
        pickup TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        processed_at TIMESTAMP,
        processed_by TEXT
    )`);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_courier ON orders(courier)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_status ON products(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_transactions_username ON transactions(username)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdraw_requests_seller ON withdraw_requests(seller)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_withdraw_requests_status ON withdraw_requests(status)`);

    await pool.query(
        `INSERT INTO users (username, password, role, shop_id, approved, pending, blocked)
         VALUES
            ('Admin', 'Admin2026!', 'admin', NULL, TRUE, FALSE, FALSE),
            ('staff', 'Staff2026!', 'staff', NULL, TRUE, FALSE, FALSE),
            ('courier', 'Courier2026!', 'courier', NULL, TRUE, FALSE, FALSE)
         ON CONFLICT (username) DO NOTHING`
    );

    schemaReady = true;
    console.log('✅ Схема БД инициализирована');
}

async function adjustBalance(client, username, delta) {
    await client.query(
        `INSERT INTO balances (username, balance) VALUES ($1, $2)
         ON CONFLICT (username) DO UPDATE SET balance = balances.balance + $2`,
        [username, delta]
    );
}

async function logTransaction(client, username, type, amount, description) {
    await client.query(
        `INSERT INTO transactions (username, type, amount, description, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [username, type, amount, description]
    );
}

async function deleteAllReferencingRows(client, referencedTable, referencedColumn, value) {
    const { rows } = await client.query(
        `SELECT tc.table_name AS referencing_table, kcu.column_name AS referencing_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
             ON tc.constraint_name = ccu.constraint_name
             AND tc.table_schema = ccu.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
             AND ccu.table_name = $1
             AND ccu.column_name = $2
             AND tc.table_schema = 'public'`,
        [referencedTable, referencedColumn]
    );

    for (const row of rows) {
        const sql = `DELETE FROM "${row.referencing_table}" WHERE "${row.referencing_column}" = $1`;
        const result = await client.query(sql, [value]);
        console.log(`✅ Автоочистка: ${result.rowCount} строк из "${row.referencing_table}".${row.referencing_column}`);
    }
}

async function addPendingCommission(client, seller, amount) {
    await client.query(
        `INSERT INTO pending_commissions (seller, amount) VALUES ($1, $2)
         ON CONFLICT (seller) DO UPDATE SET amount = pending_commissions.amount + $2, updated_at = NOW()`,
        [seller, amount]
    );
}

async function processPendingCommission(client, seller) {
    const [pendingRes, balanceRes] = await Promise.all([
        client.query('SELECT amount FROM pending_commissions WHERE seller = $1 FOR UPDATE', [seller]),
        client.query('SELECT balance FROM balances WHERE username = $1 FOR UPDATE', [seller])
    ]);

    if (pendingRes.rows.length === 0) return 0;

    const pendingAmount = Number(pendingRes.rows[0].amount);
    const currentBalance = Number(balanceRes.rows[0]?.balance || 0);

    const threshold = Math.floor(currentBalance * COMMISSION_PERCENT / 100);

    if (pendingAmount < threshold || pendingAmount === 0) return 0;

    const toDeduct = Math.min(pendingAmount, currentBalance);
    if (toDeduct === 0) return 0;

    const remaining = pendingAmount - toDeduct;

    if (remaining === 0) {
        await client.query(`DELETE FROM pending_commissions WHERE seller = $1`, [seller]);
    } else {
        await client.query(
            `UPDATE pending_commissions SET amount = $1, updated_at = NOW() WHERE seller = $2`,
            [remaining, seller]
        );
    }

    await adjustBalance(client, seller, -toDeduct);
    await logTransaction(client, seller, 'commission', -toDeduct,
        `Списана комиссия за обслуживание (${toDeduct} АР) — накоплено было ${pendingAmount} АР`);

    await adjustBalance(client, ADMIN_USERNAME, toDeduct);
    await logTransaction(client, ADMIN_USERNAME, 'commission', toDeduct,
        `Получена комиссия от ${seller} (${toDeduct} АР)`);

    return toDeduct;
}

async function forceDeductCommission(client, seller, amount, actor) {
    const pendingRes = await client.query(
        'SELECT amount FROM pending_commissions WHERE seller = $1 FOR UPDATE',
        [seller]
    );

    const pendingAmount = Number(pendingRes.rows[0]?.amount || 0);
    const toDeduct = Math.min(amount, pendingAmount);

    if (toDeduct === 0) return 0;

    const remaining = pendingAmount - toDeduct;

    if (remaining === 0) {
        await client.query(`DELETE FROM pending_commissions WHERE seller = $1`, [seller]);
    } else {
        await client.query(
            `UPDATE pending_commissions SET amount = $1, updated_at = NOW() WHERE seller = $2`,
            [remaining, seller]
        );
    }

    await adjustBalance(client, seller, -toDeduct);
    await logTransaction(client, seller, 'commission_forced', -toDeduct,
        `Принудительное списание комиссии администратором ${actor} (${toDeduct} АР)`);

    await adjustBalance(client, ADMIN_USERNAME, toDeduct);
    await logTransaction(client, ADMIN_USERNAME, 'commission', toDeduct,
        `Получена комиссия от ${seller} (${toDeduct} АР) — принудительно`);

    return toDeduct;
}

async function createWithdrawRequest(client, seller, amount, pickup) {
    await client.query(
        `INSERT INTO withdraw_requests (seller, amount, pickup, status, created_at)
         VALUES ($1, $2, $3, 'pending', NOW())`,
        [seller, amount, pickup]
    );
}

async function processWithdrawRequest(client, requestId, actor) {
    const reqRes = await client.query(
        `SELECT * FROM withdraw_requests WHERE id = $1 AND status = 'pending' FOR UPDATE`,
        [requestId]
    );
    if (reqRes.rows.length === 0) {
        throw new Error('Заявка не найдена или уже обработана');
    }
    const req = reqRes.rows[0];

    const balRes = await client.query('SELECT balance FROM balances WHERE username = $1 FOR UPDATE', [req.seller]);
    const currentBalance = Number(balRes.rows[0]?.balance || 0);

    if (currentBalance < req.amount) {
        throw new Error(`Недостаточно средств на балансе продавца (нужно: ${req.amount}, доступно: ${currentBalance})`);
    }

    await adjustBalance(client, req.seller, -req.amount);
    await logTransaction(client, req.seller, 'withdraw', -req.amount,
        `Вывод средств через ПВЗ ${req.pickup} (заявка #${requestId})`);

    await client.query(
        `UPDATE withdraw_requests 
         SET status = 'completed', processed_at = NOW(), processed_by = $1 
         WHERE id = $2`,
        [actor, requestId]
    );

    return req;
}

async function cancelWithdrawRequest(client, requestId, actor) {
    const reqRes = await client.query(
        `SELECT * FROM withdraw_requests WHERE id = $1 AND status = 'pending' FOR UPDATE`,
        [requestId]
    );
    if (reqRes.rows.length === 0) {
        throw new Error('Заявка не найдена или уже обработана');
    }
    await client.query(
        `UPDATE withdraw_requests 
         SET status = 'cancelled', processed_at = NOW(), processed_by = $1 
         WHERE id = $2`,
        [actor, requestId]
    );
    return reqRes.rows[0];
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (!process.env.POSTGRES_URL) {
        return res.status(500).json({ error: 'POSTGRES_URL not configured' });
    }

    try {
        await ensureSchema();
        const { action, table, data, id } = req.body;

        const requestIp = (
            (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
        ).toString().split(',')[0].trim() || 'unknown';

        console.log('📥 Запрос:', action, table, id);

        if (action === 'get') {
            if (table === 'transactions') {
                const result = await pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 500');
                return res.status(200).json(result.rows);
            }
            if (table === 'pending_commissions') {
                const result = await pool.query('SELECT * FROM pending_commissions');
                return res.status(200).json(result.rows);
            }
            if (table === 'withdraw_requests') {
                const result = await pool.query('SELECT * FROM withdraw_requests ORDER BY created_at DESC');
                return res.status(200).json(result.rows);
            }
            if (table === 'users') {
                const result = await pool.query('SELECT username, role, shop_id, approved, pending, blocked FROM users');
                return res.status(200).json(result.rows);
            }
            const result = await pool.query(`SELECT * FROM ${table}`);
            return res.status(200).json(result.rows);
        }

        if (action === 'getAll') {
            const [users, shops, products, carts, orders, pickupPoints, bannedUsers, rules, wishlist, balances, transactions, pendingCommissions, withdrawRequests] = await Promise.all([
                pool.query('SELECT username, role, shop_id, approved, pending, blocked FROM users'),
                pool.query('SELECT * FROM shops'),
                pool.query('SELECT * FROM products'),
                pool.query('SELECT * FROM carts'),
                pool.query('SELECT * FROM orders'),
                pool.query('SELECT * FROM pickup_points'),
                pool.query('SELECT * FROM banned_users'),
                pool.query('SELECT * FROM rules ORDER BY sort_order'),
                pool.query('SELECT * FROM wishlist'),
                pool.query('SELECT * FROM balances'),
                pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 500'),
                pool.query('SELECT * FROM pending_commissions'),
                pool.query('SELECT * FROM withdraw_requests ORDER BY created_at DESC'),
            ]);
            return res.status(200).json({
                users: users.rows,
                shops: shops.rows,
                products: products.rows,
                carts: carts.rows,
                orders: orders.rows,
                pickupPoints: pickupPoints.rows.map(p => p.name),
                bannedUsers: bannedUsers.rows.map(b => b.username),
                rules: rules.rows.map(r => r.rule_text),
                wishlist: wishlist.rows,
                balances: balances.rows,
                transactions: transactions.rows,
                pendingCommissions: pendingCommissions.rows,
                withdrawRequests: withdrawRequests.rows,
            });
        }

        if (action === 'getSellerProfile') {
            const { username } = data || {};
            if (!username) return res.status(400).json({ error: 'Username required' });

            const [shopRes, productsRes, balanceRes, ordersRes, transactionsRes, userRes, pendingRes] = await Promise.all([
                pool.query('SELECT * FROM shops WHERE owner = $1', [username]),
                pool.query('SELECT * FROM products WHERE seller = $1', [username]),
                pool.query('SELECT * FROM balances WHERE username = $1', [username]),
                pool.query('SELECT * FROM orders WHERE seller = $1 ORDER BY created_at DESC', [username]),
                pool.query('SELECT * FROM transactions WHERE username = $1 ORDER BY created_at DESC LIMIT 100', [username]),
                pool.query('SELECT * FROM users WHERE username = $1', [username]),
                pool.query('SELECT * FROM pending_commissions WHERE seller = $1', [username]),
            ]);

            const products = productsRes.rows;
            const orders = ordersRes.rows;
            const totalEarned = orders.reduce((sum, o) => {
                if (o.status === 'completed') {
                    return sum + Number(o.total_ar);
                }
                return sum;
            }, 0);

            return res.status(200).json({
                shop: shopRes.rows[0] || null,
                products: productsRes.rows,
                balance: balanceRes.rows[0]?.balance || 0,
                orders: ordersRes.rows,
                transactions: transactionsRes.rows,
                user: userRes.rows[0] || null,
                pendingCommission: pendingRes.rows[0]?.amount || 0,
                stats: {
                    totalProducts: products.length,
                    totalOrders: orders.length,
                    totalEarned: totalEarned
                }
            });
        }

        if (action === 'getCourierProfile') {
            const { username } = data || {};
            if (!username) return res.status(400).json({ error: 'Username required' });

            const [balanceRes, ordersRes, transactionsRes, userRes] = await Promise.all([
                pool.query('SELECT * FROM balances WHERE username = $1', [username]),
                pool.query('SELECT * FROM orders WHERE courier = $1 ORDER BY created_at DESC', [username]),
                pool.query('SELECT * FROM transactions WHERE username = $1 ORDER BY created_at DESC LIMIT 100', [username]),
                pool.query('SELECT * FROM users WHERE username = $1', [username])
            ]);

            const completedOrders = ordersRes.rows.filter(o => o.status === 'completed');
            const totalDeliveries = completedOrders.length;
            const totalCommission = completedOrders.reduce((sum, o) => sum + 1, 0);

            return res.status(200).json({
                balance: balanceRes.rows[0]?.balance || 0,
                orders: ordersRes.rows,
                transactions: transactionsRes.rows,
                user: userRes.rows[0] || null,
                stats: {
                    totalDeliveries: totalDeliveries,
                    totalCommission: totalCommission
                }
            });
        }

        if (action === 'forceDeductCommission') {
            const { seller, amount, actor } = data || {};
            if (!seller || !amount || !actor) {
                return res.status(400).json({ error: 'seller, amount и actor обязательны' });
            }
            const actorRes = await pool.query('SELECT role FROM users WHERE username = $1', [actor]);
            if (actorRes.rows[0]?.role !== 'admin') {
                return res.status(403).json({ error: 'Только администратор может принудительно списывать комиссию' });
            }
            const amt = Math.floor(Number(amount));
            if (amt <= 0) {
                return res.status(400).json({ error: 'Сумма должна быть положительным целым числом' });
            }
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const result = await forceDeductCommission(client, seller, amt, actor);
                await client.query('COMMIT');
                return res.status(200).json({ success: true, deducted: result });
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        }

        if (action === 'withdrawBalance') {
            const { username, amount, pickup } = data || {};
            const amt = Math.floor(Number(amount));
            if (!username || !amt || amt <= 0 || !pickup) {
                return res.status(400).json({ error: 'username, amount и pickup обязательны, amount должен быть положительным целым' });
            }
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const balRes = await client.query('SELECT balance FROM balances WHERE username = $1 FOR UPDATE', [username]);
                const currentBalance = Number(balRes.rows[0]?.balance || 0);
                if (currentBalance < amt) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: 'Недостаточно средств для вывода' });
                }
                await createWithdrawRequest(client, username, amt, pickup);
                await logTransaction(client, username, 'withdraw_request', amt,
                    `Создана заявка на вывод ${amt} АР через ПВЗ ${pickup}`);
                await client.query('COMMIT');
                return res.status(200).json({
                    success: true,
                    message: `Заявка на вывод ${amt} АР создана. Ожидайте подтверждения в ПВЗ.`
                });
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        }

        if (action === 'getWithdrawRequests') {
            const result = await pool.query(
                `SELECT * FROM withdraw_requests ORDER BY created_at DESC`
            );
            return res.status(200).json(result.rows);
        }

        if (action === 'processWithdrawRequest') {
            const { requestId, actor } = data || {};
            if (!requestId || !actor) {
                return res.status(400).json({ error: 'requestId и actor обязательны' });
            }
            const actorRes = await pool.query('SELECT role FROM users WHERE username = $1', [actor]);
            if (actorRes.rows[0]?.role !== 'staff' && actorRes.rows[0]?.role !== 'admin') {
                return res.status(403).json({ error: 'Только сотрудник ПВЗ или администратор может подтверждать вывод' });
            }
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const result = await processWithdrawRequest(client, requestId, actor);
                await client.query('COMMIT');
                return res.status(200).json({ success: true, request: result });
            } catch (err) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: err.message });
            } finally {
                client.release();
            }
        }

        if (action === 'cancelWithdrawRequest') {
            const { requestId, actor } = data || {};
            if (!requestId || !actor) {
                return res.status(400).json({ error: 'requestId и actor обязательны' });
            }
            const actorRes = await pool.query('SELECT role FROM users WHERE username = $1', [actor]);
            if (actorRes.rows[0]?.role !== 'staff' && actorRes.rows[0]?.role !== 'admin') {
                return res.status(403).json({ error: 'Только сотрудник ПВЗ или администратор может отменять вывод' });
            }
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const result = await cancelWithdrawRequest(client, requestId, actor);
                await client.query('COMMIT');
                return res.status(200).json({ success: true, request: result });
            } catch (err) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: err.message });
            } finally {
                client.release();
            }
        }

        if (action === 'changePassword') {
            const { username, newPassword, actor } = data || {};
            if (!username || !newPassword || !actor) {
                return res.status(400).json({ error: 'username, newPassword и actor обязательны' });
            }
            const actorRes = await pool.query('SELECT role FROM users WHERE username = $1', [actor]);
            if (actorRes.rows[0]?.role !== 'admin') {
                return res.status(403).json({ error: 'Только администратор может менять пароли' });
            }
            await pool.query('UPDATE users SET password = $1 WHERE username = $2', [newPassword, username]);
            return res.status(200).json({ success: true });
        }

        if (action === 'createAdminSession') {
            const { username } = data || {};
            if (!username) return res.status(400).json({ error: 'username required' });
            const token = crypto.randomUUID();
            await pool.query(
                `INSERT INTO admin_sessions (username, token, ip, created_at) VALUES ($1, $2, $3, NOW())`,
                [username, token, requestIp]
            );
            return res.status(200).json({ token });
        }

        if (action === 'getAdminSessions') {
            const { username } = data || {};
            if (!username) return res.status(400).json({ error: 'username required' });
            const result = await pool.query(
                `SELECT token, ip, created_at FROM admin_sessions WHERE username = $1 ORDER BY created_at DESC`,
                [username]
            );
            return res.status(200).json(result.rows);
        }

        if (action === 'revokeAdminSession') {
            const { username, token } = data || {};
            if (!username || !token) return res.status(400).json({ error: 'username and token required' });
            await pool.query('DELETE FROM admin_sessions WHERE username = $1 AND token = $2', [username, token]);
            return res.status(200).json({ success: true });
        }

        if (action === 'getCourierOrders') {
            const result = await pool.query(
                `SELECT * FROM orders WHERE status = 'ready_for_courier' ORDER BY pickup, created_at`
            );
            const grouped = {};
            for (const order of result.rows) {
                if (!grouped[order.pickup]) grouped[order.pickup] = [];
                grouped[order.pickup].push(order);
            }
            return res.status(200).json({ grouped, total: result.rows.length });
        }

        if (action === 'getStaffOrders') {
            const result = await pool.query(
                `SELECT * FROM orders WHERE status = 'ready_for_pickup' ORDER BY pickup, created_at`
            );
            const grouped = {};
            for (const order of result.rows) {
                if (!grouped[order.pickup]) grouped[order.pickup] = [];
                grouped[order.pickup].push(order);
            }
            return res.status(200).json({ grouped, total: result.rows.length });
        }

        if (action === 'updateOrderStatus') {
            const orderId = id;
            const { actor, status } = data || {};
            const allowedStatuses = ['pending', 'processing', 'ready_for_courier', 'in_transit', 'ready_for_pickup', 'completed', 'cancelled'];

            if (!orderId || !status) {
                return res.status(400).json({ error: 'orderId и status обязательны' });
            }
            if (!allowedStatuses.includes(status)) {
                return res.status(400).json({ error: 'Недопустимый статус: ' + status });
            }

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
                if (orderRes.rows.length === 0) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ error: 'Заказ не найден' });
                }
                const order = orderRes.rows[0];

                const actorRes = await client.query('SELECT role FROM users WHERE username = $1', [actor]);
                if (actorRes.rows.length === 0) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ error: 'Пользователь не найден' });
                }
                const actorRole = actorRes.rows[0].role;

                switch (status) {
                    case 'processing':
                        if (order.seller !== actor) {
                            await client.query('ROLLBACK');
                            return res.status(403).json({ error: 'Только продавец может взять заказ в работу' });
                        }
                        if (order.status !== 'pending') {
                            await client.query('ROLLBACK');
                            return res.status(400).json({ error: 'Заказ уже обрабатывается' });
                        }
                        break;

                    case 'ready_for_courier':
                        if (order.seller !== actor) {
                            await client.query('ROLLBACK');
                            return res.status(403).json({ error: 'Только продавец может передать заказ курьеру' });
                        }
                        if (order.status !== 'processing') {
                            await client.query('ROLLBACK');
                            return res.status(400).json({ error: 'Заказ должен быть в статусе "В обработке"' });
                        }
                        break;

                    case 'in_transit':
                        if (actorRole !== 'courier') {
                            await client.query('ROLLBACK');
                            return res.status(403).json({ error: 'Только курьер может взять заказ в доставку' });
                        }
                        if (order.status !== 'ready_for_courier') {
                            await client.query('ROLLBACK');
                            return res.status(400).json({ error: 'Заказ должен быть готов к передаче курьеру' });
                        }
                        await client.query('UPDATE orders SET courier = $1 WHERE id = $2', [actor, orderId]);
                        break;

                    case 'ready_for_pickup':
                        if (actorRole !== 'courier') {
                            await client.query('ROLLBACK');
                            return res.status(403).json({ error: 'Только курьер может отметить заказ как доставленный в ПВЗ' });
                        }
                        if (order.courier !== actor) {
                            await client.query('ROLLBACK');
                            return res.status(403).json({ error: 'Этот заказ назначен другому курьеру' });
                        }
                        if (order.status !== 'in_transit') {
                            await client.query('ROLLBACK');
                            return res.status(400).json({ error: 'Заказ должен быть в пути' });
                        }
                        await adjustBalance(client, actor, 1);
                        await logTransaction(client, actor, 'delivery_fee', 1, `Доставка заказа #${orderId} на ПВЗ ${order.pickup}`);
                        break;

                    case 'completed':
                        if (actorRole !== 'staff' && actorRole !== 'admin') {
                            await client.query('ROLLBACK');
                            return res.status(403).json({ error: 'Только сотрудник ПВЗ может выдать заказ' });
                        }
                        if (order.status !== 'ready_for_pickup') {
                            await client.query('ROLLBACK');
                            return res.status(400).json({ error: 'Заказ должен быть готов к выдаче' });
                        }

                        const orderTotal = Number(order.total_ar);

                        if (order.payment_method === 'cash') {
                            const buyerBalance = await client.query('SELECT balance FROM balances WHERE username = $1 FOR UPDATE', [order.buyer]);
                            const currentBalance = Number(buyerBalance.rows[0]?.balance || 0);
                            if (currentBalance < orderTotal) {
                                await client.query('ROLLBACK');
                                return res.status(400).json({ error: `Недостаточно средств. Нужно: ${orderTotal} АР` });
                            }
                            await adjustBalance(client, order.buyer, -orderTotal);
                            await logTransaction(client, order.buyer, 'purchase', -orderTotal, `Оплата заказа #${orderId} при получении`);
                        }

                        await adjustBalance(client, order.seller, orderTotal);
                        await logTransaction(client, order.seller, 'sale', orderTotal, `Продажа заказа #${orderId}`);

                        const commission = Math.ceil(orderTotal * COMMISSION_PERCENT / 100);
                        if (commission > 0) {
                            await addPendingCommission(client, order.seller, commission);
                            await logTransaction(client, order.seller, 'commission_pending', commission,
                                `Накоплена комиссия с заказа #${orderId} (${commission} АР)`);
                            await processPendingCommission(client, order.seller);
                        }

                        if (order.courier) {
                            await adjustBalance(client, order.courier, 1);
                            await logTransaction(client, order.courier, 'delivery_fee', 1,
                                `Доставка заказа #${orderId} на ПВЗ ${order.pickup}`);
                        }

                        await client.query(`UPDATE orders SET delivered_at = NOW() WHERE id = $1`, [orderId]);

                        await client.query(
                            `INSERT INTO orders_archive (
                                id, buyer, seller, items, total_ar, total_diamonds, currency, pickup, status, payment_method, created_at, archived_at
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
                            [order.id, order.buyer, order.seller, order.items, order.total_ar, order.total_diamonds, order.currency, order.pickup, 'completed', order.payment_method, order.created_at]
                        );
                        await client.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
                        break;

                    case 'cancelled':
                        if (actor !== order.buyer && actorRole !== 'admin') {
                            await client.query('ROLLBACK');
                            return res.status(403).json({ error: 'Только покупатель или администратор может отменить заказ' });
                        }
                        if (order.status === 'completed') {
                            await client.query('ROLLBACK');
                            return res.status(400).json({ error: 'Выданный заказ нельзя отменить' });
                        }
                        if (actor === order.buyer && actorRole !== 'admin') {
                            const createdAt = new Date(order.created_at);
                            const now = new Date();
                            const diffMinutes = (now - createdAt) / (1000 * 60);
                            if (diffMinutes > 15) {
                                await client.query('ROLLBACK');
                                return res.status(400).json({ error: 'Отмена доступна только в течение 15 минут после оформления' });
                            }
                        }
                        const items = order.items;
                        for (const item of items) {
                            await client.query(
                                `UPDATE products SET stock = stock + $1 WHERE id = $2`,
                                [item.quantity, item.productId]
                            );
                        }
                        if (order.payment_method === 'balance') {
                            await adjustBalance(client, order.buyer, Number(order.total_ar));
                            await logTransaction(client, order.buyer, 'refund', Number(order.total_ar), `Возврат за отменённый заказ #${orderId}`);
                        }
                        await client.query(
                            `INSERT INTO orders_archive (
                                id, buyer, seller, items, total_ar, total_diamonds, currency, pickup, status, payment_method, created_at, archived_at
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
                            [order.id, order.buyer, order.seller, order.items, order.total_ar, order.total_diamonds, order.currency, order.pickup, 'cancelled', order.payment_method, order.created_at]
                        );
                        await client.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
                        break;
                }

                await client.query('COMMIT');
                return res.status(200).json({ success: true });
            } catch (err) {
                await client.query('ROLLBACK');
                console.error('❌ Ошибка обновления статуса:', err);
                return res.status(500).json({ error: err.message });
            } finally {
                client.release();
            }
        }

        if (action === 'placeOrder') {
            const { buyer, items, pickup, currency, paymentMethod } = data || {};
            if (!buyer || !Array.isArray(items) || items.length === 0 || !pickup) {
                return res.status(400).json({ error: 'Некорректные данные заказа' });
            }
            if (!['balance', 'cash'].includes(paymentMethod)) {
                return res.status(400).json({ error: 'Некорректный способ оплаты' });
            }
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                for (const item of items) {
                    const prodRes = await client.query('SELECT stock, name FROM products WHERE id = $1 FOR UPDATE', [item.productId]);
                    if (prodRes.rows.length === 0) {
                        const e = new Error(`Товар "${item.name}" больше недоступен`);
                        e.status = 404;
                        throw e;
                    }
                    if (prodRes.rows[0].stock < item.quantity) {
                        const e = new Error(`Недостаточно товара "${item.name}" на складе`);
                        e.status = 400;
                        throw e;
                    }
                }

                const totalAll = items.reduce((s, it) => s + it.priceAR * it.quantity, 0);

                if (paymentMethod === 'balance') {
                    const balRes = await client.query('SELECT balance FROM balances WHERE username = $1 FOR UPDATE', [buyer]);
                    const currentBalance = Number(balRes.rows[0]?.balance || 0);
                    if (currentBalance < totalAll) {
                        const e = new Error(`Недостаточно средств. Нужно: ${totalAll} АР`);
                        e.status = 400;
                        throw e;
                    }
                }

                const grouped = {};
                for (const item of items) {
                    if (!grouped[item.seller]) grouped[item.seller] = [];
                    grouped[item.seller].push(item);
                }

                const createdOrders = [];
                for (const seller of Object.keys(grouped)) {
                    const sellerItems = grouped[seller];
                    const orderTotalAR = sellerItems.reduce((s, it) => s + it.priceAR * it.quantity, 0);
                    const orderTotalDiamonds = orderTotalAR * 3;
                    const orderId = 'ORD-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
                    await client.query(
                        `INSERT INTO orders (id, buyer, seller, items, total_ar, total_diamonds, currency, pickup, status, payment_method, created_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, NOW())`,
                        [
                            orderId, buyer, seller,
                            JSON.stringify(sellerItems.map(it => ({
                                productId: it.productId,
                                name: it.name,
                                icon: it.icon,
                                quantity: it.quantity,
                                priceAR: it.priceAR,
                                shopName: it.shopName
                            }))),
                            orderTotalAR, orderTotalDiamonds, currency, pickup, paymentMethod
                        ]
                    );
                    createdOrders.push(orderId);
                }

                for (const item of items) {
                    await client.query('UPDATE products SET stock = stock - $1, sales = sales + $1 WHERE id = $2', [item.quantity, item.productId]);
                }

                if (paymentMethod === 'balance') {
                    await adjustBalance(client, buyer, -totalAll);
                    await logTransaction(client, buyer, 'purchase', -totalAll, `Оплата заказа(ов): ${createdOrders.join(', ')}`);
                }

                for (const seller of Object.keys(grouped)) {
                    const sellerItems = grouped[seller];
                    const sellerTotal = sellerItems.reduce((s, it) => s + it.priceAR * it.quantity, 0);
                    const commission = Math.ceil(sellerTotal * COMMISSION_PERCENT / 100);
                    if (commission > 0) {
                        await addPendingCommission(client, seller, commission);
                        await logTransaction(client, seller, 'commission_pending', commission,
                            `Накоплена комиссия с заказа(ов): ${createdOrders.join(', ')} (${commission} АР)`);
                        await processPendingCommission(client, seller);
                    }
                }

                await client.query('DELETE FROM carts WHERE user_id = $1', [buyer]);

                await client.query('COMMIT');
                return res.status(200).json({ success: true, orderIds: createdOrders });
            } catch (err) {
                await client.query('ROLLBACK');
                return res.status(err.status || 500).json({ error: err.message });
            } finally {
                client.release();
            }
        }

        if (action === 'archiveOrders') {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const oldOrders = await client.query(
                    `SELECT * FROM orders WHERE status IN ('completed', 'cancelled') AND created_at < NOW() - INTERVAL '24 hours'`
                );
                for (const order of oldOrders.rows) {
                    await client.query(
                        `INSERT INTO orders_archive (
                            id, buyer, seller, items, total_ar, total_diamonds, currency, pickup, status, payment_method, created_at, archived_at
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
                        [order.id, order.buyer, order.seller, order.items, order.total_ar, order.total_diamonds, order.currency, order.pickup, order.status, order.payment_method, order.created_at]
                    );
                    await client.query(`DELETE FROM orders WHERE id = $1`, [order.id]);
                }
                await client.query('COMMIT');
                return res.status(200).json({ success: true, archived: oldOrders.rowCount });
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        }

        if (action === 'topUpBalance') {
            const { username, amount, actor } = data || {};
            const amt = Math.floor(Number(amount));
            if (!username || !actor || !amt || amt <= 0) {
                return res.status(400).json({ error: 'username, amount и actor обязательны, amount должен быть положительным целым' });
            }
            const actorRes = await pool.query('SELECT role FROM users WHERE username = $1', [actor]);
            const actorRole = actorRes.rows[0]?.role;
            if (actorRole !== 'admin' && actorRole !== 'staff') {
                return res.status(403).json({ error: 'Пополнять баланс может только администратор или сотрудник ПВЗ' });
            }
            const targetRes = await pool.query('SELECT username FROM users WHERE username = $1', [username]);
            if (targetRes.rows.length === 0) {
                return res.status(404).json({ error: 'Пользователь не найден' });
            }
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await adjustBalance(client, username, amt);
                await logTransaction(client, username, 'topup', amt, `Пополнение через ${actorRole === 'admin' ? 'администратора' : 'ПВЗ'} (${actor})`);

                const userRes = await client.query('SELECT role FROM users WHERE username = $1', [username]);
                if (userRes.rows[0]?.role === 'seller') {
                    await processPendingCommission(client, username);
                }

                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
            return res.status(200).json({ success: true });
        }

        if (action === 'transferBalance') {
            const { from, to, amount } = data || {};
            const amt = Math.floor(Number(amount));
            if (!from || !to || !amt || amt <= 0) {
                return res.status(400).json({ error: 'from, to и amount обязательны, amount должен быть положительным целым' });
            }
            if (from === to) {
                return res.status(400).json({ error: 'Нельзя перевести деньги самому себе' });
            }
            const targetRes = await pool.query('SELECT username FROM users WHERE username = $1', [to]);
            if (targetRes.rows.length === 0) {
                return res.status(404).json({ error: 'Получатель с таким логином не найден' });
            }
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const balRes = await client.query('SELECT balance FROM balances WHERE username = $1 FOR UPDATE', [from]);
                const currentBalance = Number(balRes.rows[0]?.balance || 0);
                if (currentBalance < amt) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: 'Недостаточно средств на балансе' });
                }
                await adjustBalance(client, from, -amt);
                await adjustBalance(client, to, amt);
                await logTransaction(client, from, 'transfer_out', -amt, `Перевод пользователю ${to}`);
                await logTransaction(client, to, 'transfer_in', amt, `Перевод от ${from}`);

                const fromUserRes = await client.query('SELECT role FROM users WHERE username = $1', [from]);
                if (fromUserRes.rows[0]?.role === 'seller') {
                    await processPendingCommission(client, from);
                }

                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
            return res.status(200).json({ success: true });
        }

        if (action === 'toggleBlockUser') {
            const { username, blocked } = data || {};
            if (!username) {
                return res.status(400).json({ error: 'username обязателен' });
            }
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('DELETE FROM banned_users WHERE username = $1', [username]);
                if (blocked) {
                    await client.query('INSERT INTO banned_users (username) VALUES ($1)', [username]);
                    const balRes = await client.query('SELECT balance FROM balances WHERE username = $1', [username]);
                    const currentBalance = Number(balRes.rows[0]?.balance || 0);
                    if (currentBalance !== 0) {
                        await client.query('UPDATE balances SET balance = 0 WHERE username = $1', [username]);
                        await logTransaction(client, username, 'balance_voided', -currentBalance, 'Баланс аннулирован при блокировке аккаунта');
                    }
                    await client.query('DELETE FROM pending_commissions WHERE seller = $1', [username]);
                }
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
            return res.status(200).json({ success: true });
        }

        if (action === 'adminResetBalance') {
            const { username, actor } = data || {};
            if (!username || !actor) {
                return res.status(400).json({ error: 'username и actor обязательны' });
            }
            const actorRes = await pool.query('SELECT role FROM users WHERE username = $1', [actor]);
            if (actorRes.rows[0]?.role !== 'admin') {
                return res.status(403).json({ error: 'Обнулять баланс может только администратор' });
            }
            const targetRes = await pool.query('SELECT username FROM users WHERE username = $1', [username]);
            if (targetRes.rows.length === 0) {
                return res.status(404).json({ error: 'Пользователь не найден' });
            }
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const balRes = await client.query('SELECT balance FROM balances WHERE username = $1 FOR UPDATE', [username]);
                const currentBalance = Number(balRes.rows[0]?.balance || 0);
                if (currentBalance !== 0) {
                    await client.query('UPDATE balances SET balance = 0 WHERE username = $1', [username]);
                    await logTransaction(client, username, 'balance_reset', -currentBalance, `Баланс обнулён администратором (${actor})`);
                }
                await client.query('DELETE FROM pending_commissions WHERE seller = $1', [username]);
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
            return res.status(200).json({ success: true });
        }

        if (action === 'login') {
            const { username, password } = data || {};
            if (!username || !password) {
                return res.status(400).json({ error: 'username и password обязательны' });
            }
            const result = await pool.query(
                'SELECT username, password, role, shop_id, approved, pending, blocked FROM users WHERE username = $1',
                [username]
            );
            if (result.rowCount === 0) {
                return res.status(401).json({ error: 'Неверный логин или пароль' });
            }
            if (result.rows[0].password !== password) {
                return res.status(401).json({ error: 'Неверный логин или пароль' });
            }
            const { password: _unused, ...safeUser } = result.rows[0];
            return res.status(200).json({ success: true, user: safeUser });
        }

        if (action === 'register') {
            const { username, password, role } = data || {};
            if (!username || !password || !role) {
                return res.status(400).json({ error: 'username, password и role обязательны' });
            }

            // 🔒 ЗАЩИТА: ТОЛЬКО ПОКУПАТЕЛЬ ИЛИ ПРОДАВЕЦ!
            const allowedRoles = ['buyer', 'seller'];
            if (!allowedRoles.includes(role)) {
                return res.status(403).json({ error: 'Недопустимая роль. Доступны: buyer, seller' });
            }

            // Защита от создания admin через API
            if (role === 'admin' || role === 'staff' || role === 'courier') {
                return res.status(403).json({ error: 'Создание административных аккаунтов запрещено' });
            }

            const approved = role === 'buyer';
            const pending = role === 'seller';

            const result = await pool.query(
                `INSERT INTO users (username, password, role, shop_id, approved, pending, blocked)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (username) DO NOTHING
                 RETURNING username, role, shop_id, approved, pending, blocked`,
                [username, password, role, null, approved, pending, false]
            );

            if (result.rowCount === 0) {
                return res.status(409).json({ error: 'Пользователь с таким логином уже существует' });
            }
            return res.status(200).json({ success: true, user: result.rows[0] });
        }

        if (action === 'set') {
            if (table === 'users') {
                for (const user of data) {
                    await pool.query(
                        `INSERT INTO users (username, password, role, shop_id, approved, pending, blocked)
                         VALUES ($1, COALESCE($2, ''), $3, $4, $5, $6, $7)
                         ON CONFLICT (username) DO UPDATE SET
                             role = EXCLUDED.role,
                             shop_id = EXCLUDED.shop_id,
                             approved = EXCLUDED.approved,
                             pending = EXCLUDED.pending,
                             blocked = EXCLUDED.blocked`,
                        [user.username, user.password || null, user.role, user.shop_id || null, user.approved || false, user.pending || false, user.blocked || false]
                    );
                }
            }
            if (table === 'shops') {
                for (const shop of data) {
                    await pool.query(
                        `INSERT INTO shops (id, owner, name, description, approved, pending, rating, review_count)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                         ON CONFLICT (id) DO UPDATE SET
                             owner = EXCLUDED.owner,
                             name = EXCLUDED.name,
                             description = EXCLUDED.description,
                             approved = EXCLUDED.approved,
                             pending = EXCLUDED.pending,
                             rating = EXCLUDED.rating,
                             review_count = EXCLUDED.review_count`,
                        [shop.id, shop.owner, shop.name, shop.description || '', shop.approved || false, shop.pending || true, shop.rating || 0, shop.review_count || 0]
                    );
                }
            }
            if (table === 'products') {
                for (const product of data) {
                    await pool.query(
                        `INSERT INTO products (id, shop_id, shop_name, category, name, icon, price_ar, stock, seller, status, rating, review_count, sales, created_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
                         ON CONFLICT (id) DO UPDATE SET
                             shop_id = EXCLUDED.shop_id,
                             shop_name = EXCLUDED.shop_name,
                             category = EXCLUDED.category,
                             name = EXCLUDED.name,
                             icon = EXCLUDED.icon,
                             price_ar = EXCLUDED.price_ar,
                             stock = EXCLUDED.stock,
                             seller = EXCLUDED.seller,
                             status = EXCLUDED.status,
                             rating = EXCLUDED.rating,
                             review_count = EXCLUDED.review_count,
                             sales = EXCLUDED.sales`,
                        [product.id, product.shop_id, product.shop_name, product.category, product.name, product.icon || '📦', product.price_ar, product.stock, product.seller, product.status || 'pending', product.rating || 0, product.review_count || 0, product.sales || 0]
                    );
                }
            }
            if (table === 'carts') {
                for (const cart of data) {
                    await pool.query(
                        `INSERT INTO carts (user_id, items)
                         VALUES ($1, $2)
                         ON CONFLICT (user_id) DO UPDATE SET
                             items = EXCLUDED.items`,
                        [cart.user_id, JSON.stringify(cart.items)]
                    );
                }
            }
            if (table === 'pickup_points') {
                await pool.query('DELETE FROM pickup_points');
                for (const name of data) {
                    await pool.query('INSERT INTO pickup_points (name) VALUES ($1)', [name]);
                }
            }
            if (table === 'banned_users') {
                await pool.query('DELETE FROM banned_users');
                for (const username of data) {
                    await pool.query('INSERT INTO banned_users (username) VALUES ($1)', [username]);
                }
            }
            if (table === 'rules') {
                await pool.query('DELETE FROM rules');
                for (let i = 0; i < data.length; i++) {
                    await pool.query('INSERT INTO rules (rule_text, sort_order) VALUES ($1, $2)', [data[i], i + 1]);
                }
            }
            if (table === 'wishlist') {
                await pool.query('DELETE FROM wishlist WHERE user_id = $1', [data.user_id]);
                for (const product_id of data.product_ids || []) {
                    await pool.query('INSERT INTO wishlist (user_id, product_id) VALUES ($1, $2)', [data.user_id, product_id]);
                }
            }
            if (table === 'pending_commissions') {
                for (const pc of data) {
                    await pool.query(
                        `INSERT INTO pending_commissions (seller, amount) VALUES ($1, $2)
                         ON CONFLICT (seller) DO UPDATE SET amount = EXCLUDED.amount, updated_at = NOW()`,
                        [pc.seller, pc.amount]
                    );
                }
            }
            if (table === 'withdraw_requests') {
                for (const wr of data) {
                    await pool.query(
                        `INSERT INTO withdraw_requests (id, seller, amount, pickup, status, created_at, processed_at, processed_by)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                         ON CONFLICT (id) DO UPDATE SET
                             seller = EXCLUDED.seller,
                             amount = EXCLUDED.amount,
                             pickup = EXCLUDED.pickup,
                             status = EXCLUDED.status,
                             processed_at = EXCLUDED.processed_at,
                             processed_by = EXCLUDED.processed_by`,
                        [wr.id, wr.seller, wr.amount, wr.pickup, wr.status || 'pending', wr.created_at || new Date(), wr.processed_at || null, wr.processed_by || null]
                    );
                }
            }
            return res.status(200).json({ success: true });
        }

        if (action === 'delete') {
            if (table === 'products') {
                await pool.query('DELETE FROM products WHERE id = $1', [id]);
            }
            if (table === 'shops') {
                await pool.query('DELETE FROM shops WHERE id = $1', [id]);
            }
            if (table === 'users') {
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    await client.query('DELETE FROM pending_commissions WHERE seller = $1', [id]);
                    await client.query('DELETE FROM withdraw_requests WHERE seller = $1', [id]);
                    await client.query('DELETE FROM users WHERE username = $1', [id]);
                    await client.query('COMMIT');
                } catch (err) {
                    await client.query('ROLLBACK');
                    throw err;
                } finally {
                    client.release();
                }
            }
            if (table === 'withdraw_requests') {
                await pool.query('DELETE FROM withdraw_requests WHERE id = $1', [id]);
            }
            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ error: 'Unknown action' });

    } catch (error) {
        console.error('❌ Ошибка:', {
            message: error.message,
            code: error.code,
            table: error.table,
            constraint: error.constraint,
            detail: error.detail,
        });
        return res.status(500).json({
            error: error.message,
            code: error.code,
            table: error.table,
            constraint: error.constraint,
            detail: error.detail,
        });
    }
}
