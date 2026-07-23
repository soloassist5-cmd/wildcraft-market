import { Pool } from 'pg';

const pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// ============================================================
// СХЕМА БД (баланс/транзакции) — создаётся один раз на "холодный
// старт" serverless-функции. IF NOT EXISTS делает это безопасным
// при повторных вызовах и не мешает уже существующим таблицам,
// которые создаются вручную в Neon.
// ============================================================
let schemaReady = false;
async function ensureSchema() {
    if (schemaReady) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS balances (
        username TEXT PRIMARY KEY,
        balance NUMERIC NOT NULL DEFAULT 0
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        type TEXT NOT NULL,
        amount NUMERIC NOT NULL,
        description TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'cash'`);

    // ------------------------------------------------------------
    // МИГРАЦИЯ: гарантируем автозаполнение transactions.id.
    // В реальной Neon-базе таблица transactions могла быть создана
    // ДО того, как id стал SERIAL — CREATE TABLE IF NOT EXISTS выше
    // такую уже существующую таблицу не трогает, поэтому id мог
    // остаться без DEFAULT/sequence, и INSERT (который id не передаёт)
    // падал с "null value in column id violates not-null constraint".
    // Ниже — идемпотентная миграция, безопасная при любом текущем
    // состоянии таблицы (свежесозданной или существующей давно):
    // 1) создаём/привязываем sequence к transactions.id, если её ещё нет;
    // 2) выставляем DEFAULT nextval(...) на колонку id;
    // 3) синхронизируем sequence с максимальным существующим id;
    // 4) и только после этого, если id ещё nullable и NULL-строк нет,
    //    делаем её NOT NULL.
    // ------------------------------------------------------------
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS transactions_id_seq OWNED BY transactions.id`);
    await pool.query(`ALTER TABLE transactions ALTER COLUMN id SET DEFAULT nextval('transactions_id_seq')`);
    await pool.query(`SELECT setval('transactions_id_seq', COALESCE((SELECT MAX(id) FROM transactions), 0) + 1, false)`);
    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM transactions WHERE id IS NULL) THEN
                ALTER TABLE transactions ALTER COLUMN id SET NOT NULL;
            END IF;
        END $$;
    `);

    schemaReady = true;
}

// Прибавляет (или отнимает, если delta < 0) delta к балансу пользователя.
// Если строки ещё нет — создаёт с этим значением. ДОЛЖНА вызываться
// внутри транзакции (client), чтобы гонки при параллельных запросах
// не портили баланс.
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

// Находит ВСЕ таблицы/столбцы, у которых есть FOREIGN KEY на
// referencedTable.referencedColumn, и удаляет из них строки с данным
// значением. Это подстраховка на случай таблиц, о которых мы не знаем
// заранее (reviews, messages, notifications и т.п.) — вместо того чтобы
// вручную перечислять каждую зависимую таблицу и рисковать что-то забыть.
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
        console.log(`✅ Автоочистка: ${result.rowCount} строк из "${row.referencing_table}".${row.referencing_column} для ${referencedTable}.${referencedColumn}=${value}`);
    }
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

        console.log('📥 Запрос:', action, table, id);

        // ===== GET =====
        if (action === 'get') {
            if (table === 'transactions') {
                const result = await pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 500');
                return res.status(200).json(result.rows);
            }
            const result = await pool.query(`SELECT * FROM ${table}`);
            return res.status(200).json(result.rows);
        }

        // ===== GET ALL =====
        if (action === 'getAll') {
            const [users, shops, products, carts, orders, pickupPoints, bannedUsers, rules, wishlist, balances, transactions] = await Promise.all([
                pool.query('SELECT * FROM users'),
                pool.query('SELECT * FROM shops'),
                pool.query('SELECT * FROM products'),
                pool.query('SELECT * FROM carts'),
                pool.query('SELECT * FROM orders'),
                pool.query('SELECT * FROM pickup_points'),
                pool.query('SELECT * FROM banned_users'),
                pool.query('SELECT * FROM rules'),
                pool.query('SELECT * FROM wishlist'),
                pool.query('SELECT * FROM balances'),
                pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 500'),
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
            });
        }

        // ===== ПОПОЛНЕНИЕ БАЛАНСА (админ или сотрудник ПВЗ) =====
        if (action === 'topUpBalance') {
            const { username, amount, actor } = data || {};
            const amt = Number(amount);
            if (!username || !actor || !amt || amt <= 0) {
                return res.status(400).json({ error: 'username, amount и actor обязательны, amount должен быть положительным' });
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
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
            console.log('✅ Баланс пополнен:', username, '+', amt, 'от', actor);
            return res.status(200).json({ success: true });
        }

        // ===== ПЕРЕВОД МЕЖДУ ПОЛЬЗОВАТЕЛЯМИ ПО ЛОГИНУ =====
        if (action === 'transferBalance') {
            const { from, to, amount } = data || {};
            const amt = Number(amount);
            if (!from || !to || !amt || amt <= 0) {
                return res.status(400).json({ error: 'from, to и amount обязательны, amount должен быть положительным' });
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
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
            console.log('✅ Перевод выполнен:', from, '→', to, amt);
            return res.status(200).json({ success: true });
        }

        // ===== ВЫВОД СРЕДСТВ ПРОДАВЦОМ ЧЕРЕЗ ПВЗ =====
        if (action === 'withdrawBalance') {
            const { username, amount, pickup } = data || {};
            const amt = Number(amount);
            if (!username || !amt || amt <= 0) {
                return res.status(400).json({ error: 'username и amount обязательны, amount должен быть положительным' });
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
                await adjustBalance(client, username, -amt);
                await adjustBalance(client, 'staff', amt);
                await logTransaction(client, username, 'withdraw', -amt, `Вывод средств через ПВЗ${pickup ? ' (' + pickup + ')' : ''}`);
                await logTransaction(client, 'staff', 'withdraw_payout', amt, `Выдача средств продавцу ${username}${pickup ? ' (' + pickup + ')' : ''}`);
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
            console.log('✅ Вывод средств оформлен:', username, amt);
            return res.status(200).json({ success: true });
        }

        // ===== БЛОКИРОВКА / РАЗБЛОКИРОВКА ОДНОГО ПОЛЬЗОВАТЕЛЯ =====
        // Точечная операция вместо перезаписи всего списка banned_users —
        // так же, как updateOrderStatus. При блокировке баланс аннулируется.
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
                }
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
            console.log('✅ Статус блокировки обновлён:', username, '→', !!blocked);
            return res.status(200).json({ success: true });
        }

        // ===== АДМИН: ОБНУЛЕНИЕ БАЛАНСА ПОКУПАТЕЛЯ (НОВОЕ) =====
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
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
            console.log('✅ Баланс обнулён администратором:', username, 'от', actor);
            return res.status(200).json({ success: true });
        }

        // ===== АДМИН: ОТМЕНА ЗАКАЗА ИЗ-ЗА ТЕХ. НЕПОЛАДОК (НОВОЕ) =====
        // В отличие от обычного cancelOrder (доступного только покупателю
        // в первые 15 минут и только для статуса pending), эта отмена
        // доступна только администратору, не ограничена по времени и
        // работает для любого статуса, кроме уже completed/cancelled.
        if (action === 'adminCancelOrder') {
            const orderId = id;
            const { actor } = data || {};

            if (!orderId || !actor) {
                return res.status(400).json({ error: 'Order ID и actor обязательны' });
            }

            const actorRes = await pool.query('SELECT role FROM users WHERE username = $1', [actor]);
            if (actorRes.rows[0]?.role !== 'admin') {
                return res.status(403).json({ error: 'Отменять заказы таким способом может только администратор' });
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
                if (order.status === 'completed' || order.status === 'cancelled') {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: 'Заказ уже выдан или отменён' });
                }

                await client.query(
                    `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
                    [orderId]
                );

                const items = order.items;
                for (const item of items) {
                    await client.query(
                        `UPDATE products SET stock = stock + $1 WHERE id = $2`,
                        [item.quantity, item.productId]
                    );
                }

                // При оплате с баланса — деньги возвращаются покупателю
                if (order.payment_method === 'balance') {
                    await adjustBalance(client, order.buyer, Number(order.total_ar));
                    await logTransaction(client, order.buyer, 'refund', Number(order.total_ar), `Возврат за заказ #${orderId}, отменённый администратором (тех. неполадки)`);
                }

                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }

            console.log('✅ Заказ отменён администратором (тех. неполадки):', orderId, actor);
            return res.status(200).json({
                success: true,
                message: 'Заказ отменён из-за технических неполадок. Товары возвращены на склад.'
            });
        }

        // ===== ОФОРМЛЕНИЕ ЗАКАЗА (атомарно: склад + баланс + корзина) =====
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
                        const e = new Error(`Товар "${item.name}" больше недоступен`); e.status = 404; throw e;
                    }
                    if (prodRes.rows[0].stock < item.quantity) {
                        const e = new Error(`Недостаточно товара "${item.name}" на складе`); e.status = 400; throw e;
                    }
                }

                const totalAll = items.reduce((s, it) => s + it.priceAR * it.quantity, 0);

                if (paymentMethod === 'balance') {
                    const balRes = await client.query('SELECT balance FROM balances WHERE username = $1 FOR UPDATE', [buyer]);
                    const currentBalance = Number(balRes.rows[0]?.balance || 0);
                    if (currentBalance < totalAll) {
                        const e = new Error('Недостаточно средств на балансе для оплаты заказа'); e.status = 400; throw e;
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
                                productId: it.productId, name: it.name, icon: it.icon,
                                quantity: it.quantity, priceAR: it.priceAR, shopName: it.shopName
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

                await client.query('DELETE FROM carts WHERE user_id = $1', [buyer]);

                await client.query('COMMIT');
                console.log('✅ Заказ(ы) оформлен(ы):', createdOrders.join(', '));
                return res.status(200).json({ success: true, orderIds: createdOrders });
            } catch (err) {
                await client.query('ROLLBACK');
                console.error('❌ Ошибка оформления заказа:', err.message);
                return res.status(err.status || 500).json({ error: err.message });
            } finally {
                client.release();
            }
        }

        // ===== SET =====
        if (action === 'set') {
            if (table === 'users') {
                for (const user of data) {
                    await pool.query(
                        `INSERT INTO users (username, password, role, shop_id, approved, pending, blocked)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)
                         ON CONFLICT (username) DO UPDATE SET
                             password = EXCLUDED.password,
                             role = EXCLUDED.role,
                             shop_id = EXCLUDED.shop_id,
                             approved = EXCLUDED.approved,
                             pending = EXCLUDED.pending,
                             blocked = EXCLUDED.blocked`,
                        [user.username, user.password, user.role, user.shop_id || null, user.approved || false, user.pending || false, user.blocked || false]
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
                        `INSERT INTO products (id, shop_id, shop_name, category, name, icon, price_ar, stock, seller, status, rating, review_count, sales)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
            if (table === 'orders') {
                for (const order of data) {
                    await pool.query(
                        `INSERT INTO orders (id, buyer, seller, items, total_ar, total_diamonds, currency, pickup, status, created_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                         ON CONFLICT (id) DO UPDATE SET
                             buyer = EXCLUDED.buyer,
                             seller = EXCLUDED.seller,
                             items = EXCLUDED.items,
                             total_ar = EXCLUDED.total_ar,
                             total_diamonds = EXCLUDED.total_diamonds,
                             currency = EXCLUDED.currency,
                             pickup = EXCLUDED.pickup,
                             status = EXCLUDED.status`,
                        [order.id, order.buyer, order.seller, JSON.stringify(order.items), order.total_ar, order.total_diamonds, order.currency, order.pickup, order.status || 'pending']
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
            return res.status(200).json({ success: true });
        }

        // ===== DELETE (ИСПРАВЛЕНО — УДАЛЯЕТ ИЗ ИЗБРАННОГО) =====
        if (action === 'delete') {
            console.log('🗑️ DELETE запрос:', table, id);

            if (table === 'products') {
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    // Явно чистим wishlist (знаем про эту связь точно)...
                    await client.query('DELETE FROM wishlist WHERE product_id = $1', [id]);
                    // ...и на всякий случай подчищаем ЛЮБЫЕ другие таблицы,
                    // у которых есть FK на products.id (например reviews,
                    // order_items и т.п., о которых мы можем не знать).
                    await deleteAllReferencingRows(client, 'products', 'id', id);
                    const deleted = await client.query('DELETE FROM products WHERE id = $1 RETURNING id', [id]);
                    console.log('✅ Товар удалён:', id, '| затронуто строк:', deleted.rowCount);
                    await client.query('COMMIT');
                } catch (err) {
                    await client.query('ROLLBACK');
                    console.error('❌ Ошибка удаления товара, откат транзакции:', err);
                    throw err;
                } finally {
                    client.release();
                }
            }
            
            if (table === 'shops') {
                await pool.query('DELETE FROM shops WHERE id = $1', [id]);
            }

            // ===== КАСКАДНОЕ УДАЛЕНИЕ ПРОДАВЦА (ИСПРАВЛЕНО) =====
            // Удаляет пользователя вместе со всеми зависимыми записями внутри
            // одной транзакции, чтобы не нарушать foreign key constraints
            // и не оставлять "осиротевшие" данные при ошибке на середине.
            if (table === 'users') {
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');

                    // 1. Забираем id всех товаров продавца заранее
                    const productIds = (await client.query(
                        'SELECT id FROM products WHERE seller = $1', [id]
                    )).rows.map(r => r.id);

                    // 2. Для каждого товара чистим wishlist и ЛЮБЫЕ другие
                    //    таблицы, ссылающиеся на products.id (reviews и т.п.)
                    for (const pid of productIds) {
                        await client.query('DELETE FROM wishlist WHERE product_id = $1', [pid]);
                        await deleteAllReferencingRows(client, 'products', 'id', pid);
                    }

                    // 3. Сами товары продавца
                    const deletedProducts = await client.query(
                        'DELETE FROM products WHERE seller = $1 RETURNING id',
                        [id]
                    );
                    console.log('✅ [users] удалено товаров:', deletedProducts.rowCount);

                    // 4. Корзины и wishlist самого пользователя
                    await client.query('DELETE FROM carts WHERE user_id = $1', [id]);
                    await client.query('DELETE FROM wishlist WHERE user_id = $1', [id]);

                    // 5. Заказы, где пользователь выступает продавцом
                    const deletedOrders = await client.query(
                        'DELETE FROM orders WHERE seller = $1 RETURNING id',
                        [id]
                    );
                    console.log('✅ [users] удалено заказов (как продавец):', deletedOrders.rowCount);

                    // 6. Магазин пользователя
                    await client.query('DELETE FROM shops WHERE owner = $1', [id]);
                    console.log('✅ [users] магазин продавца удалён:', id);

                    // 7. Запись из списка заблокированных
                    await client.query('DELETE FROM banned_users WHERE username = $1', [id]);

                    // 7.5. Баланс и история транзакций пользователя (НОВОЕ)
                    await client.query('DELETE FROM balances WHERE username = $1', [id]);
                    await client.query('DELETE FROM transactions WHERE username = $1', [id]);

                    // 8. Финальная зачистка: ЛЮБЫЕ другие таблицы, ссылающиеся
                    //    на users.username, о которых мы могли не знать
                    //    (reviews, messages, notifications, orders.buyer и т.д.)
                    await deleteAllReferencingRows(client, 'users', 'username', id);

                    // 9. И наконец — сам пользователь
                    const deletedUser = await client.query(
                        'DELETE FROM users WHERE username = $1 RETURNING username', [id]
                    );
                    console.log('✅ [users] пользователь удалён:', id, '| затронуто строк:', deletedUser.rowCount);

                    await client.query('COMMIT');
                } catch (err) {
                    await client.query('ROLLBACK');
                    console.error('❌ Ошибка каскадного удаления продавца, откат транзакции:', err);
                    throw err;
                } finally {
                    client.release();
                }
            }

            if (table === 'wishlist') {
                await pool.query('DELETE FROM wishlist WHERE product_id = $1', [id]);
            }
            
            return res.status(200).json({ success: true });
        }

        // ===== ОТМЕНА ЗАКАЗА =====
        if (action === 'cancelOrder') {
            const orderId = id;
            const buyer = data?.buyer;
            
            if (!orderId || !buyer) {
                return res.status(400).json({ error: 'Order ID and buyer required' });
            }
            
            const orderResult = await pool.query(
                'SELECT * FROM orders WHERE id = $1 AND buyer = $2',
                [orderId, buyer]
            );
            
            if (orderResult.rows.length === 0) {
                return res.status(404).json({ error: 'Заказ не найден' });
            }
            
            const order = orderResult.rows[0];
            const createdAt = new Date(order.created_at);
            const now = new Date();
            const diffMinutes = (now - createdAt) / (1000 * 60);
            
            if (diffMinutes > 15) {
                return res.status(400).json({ 
                    error: `Отмена невозможна. Прошло ${Math.floor(diffMinutes)} минут. Отмена доступна только в течение 15 минут.`,
                    minutes: Math.floor(diffMinutes)
                });
            }
            
            if (order.status !== 'pending') {
                return res.status(400).json({ error: 'Заказ уже обрабатывается и не может быть отменён' });
            }

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(
                    `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
                    [orderId]
                );

                const items = order.items;
                for (const item of items) {
                    await client.query(
                        `UPDATE products SET stock = stock + $1 WHERE id = $2`,
                        [item.quantity, item.productId]
                    );
                }

                // При оплате с баланса — деньги возвращаются покупателю (НОВОЕ)
                if (order.payment_method === 'balance') {
                    await adjustBalance(client, order.buyer, Number(order.total_ar));
                    await logTransaction(client, order.buyer, 'refund', Number(order.total_ar), `Возврат за отменённый заказ #${orderId}`);
                }

                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }

            return res.status(200).json({ 
                success: true, 
                message: 'Заказ отменён. Товары возвращены на склад.' 
            });
        }

        // ===== СМЕНА СТАТУСА ЗАКАЗА (ИСПРАВЛЕНО) =====
        // Раньше смена статуса ОДНОГО заказа делалась через action:'set',
        // который перезаливает ВООБЩЕ ВСЕ заказы маркетплейса построчно
        // (по одному запросу на каждый заказ). Чем больше заказов в базе,
        // тем дольше "висит" кнопка — на большом магазине это могло идти
        // секундами и упираться в таймаут serverless-функции. Теперь это
        // один точечный UPDATE по id.
        if (action === 'updateOrderStatus') {
            const orderId = id;
            const { seller, status, actor } = data || {};
            const allowedStatuses = ['pending', 'processing', 'ready', 'completed', 'cancelled'];

            if (!orderId || !status) {
                return res.status(400).json({ error: 'orderId и status обязательны' });
            }
            if (!allowedStatuses.includes(status)) {
                return res.status(400).json({ error: 'Недопустимый статус: ' + status });
            }

            // Выдавать заказ (ready → completed) может только сотрудник ПВЗ (НОВОЕ)
            if (status === 'completed') {
                if (!actor) {
                    return res.status(400).json({ error: 'actor обязателен для выдачи заказа' });
                }
                const actorRes = await pool.query('SELECT role FROM users WHERE username = $1', [actor]);
                if (actorRes.rows[0]?.role !== 'staff') {
                    return res.status(403).json({ error: 'Выдавать заказы может только сотрудник ПВЗ' });
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
                    if (order.status !== 'ready') {
                        await client.query('ROLLBACK');
                        return res.status(400).json({ error: 'Заказ ещё не готов к выдаче' });
                    }
                    await client.query(`UPDATE orders SET status = 'completed', updated_at = NOW() WHERE id = $1`, [orderId]);
                    // Деньги переходят продавцу только в момент выдачи заказа —
                    // до этого они "заморожены" на балансе площадки со времени оформления.
                    if (order.payment_method === 'balance') {
                        await adjustBalance(client, order.seller, Number(order.total_ar));
                        await logTransaction(client, order.seller, 'sale', Number(order.total_ar), `Выплата за заказ #${orderId}`);
                    }
                    await client.query('COMMIT');
                    console.log('✅ Заказ выдан сотрудником ПВЗ:', orderId, actor);
                    return res.status(200).json({ success: true });
                } catch (err) {
                    await client.query('ROLLBACK');
                    throw err;
                } finally {
                    client.release();
                }
            }

            // pending → processing → ready — меняет продавец
            if (!seller) {
                return res.status(400).json({ error: 'seller обязателен' });
            }
            const result = await pool.query(
                `UPDATE orders SET status = $1, updated_at = NOW()
                 WHERE id = $2 AND seller = $3
                 RETURNING *`,
                [status, orderId, seller]
            );

            if (result.rowCount === 0) {
                return res.status(404).json({ error: 'Заказ не найден или у вас нет прав на его изменение' });
            }

            console.log('✅ Статус заказа обновлён:', orderId, '→', status);
            return res.status(200).json({ success: true, order: result.rows[0] });
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