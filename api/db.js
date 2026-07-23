import { Pool } from 'pg';

const pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// ============================================================
// ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ДЛЯ КАСКАДНОГО УДАЛЕНИЯ
// ============================================================
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
        if (result.rowCount > 0) {
            console.log(`✅ Автоочистка: ${result.rowCount} строк из "${row.referencing_table}".${row.referencing_column}`);
        }
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
        const { action, table, data, id } = req.body;

        console.log('📥 Запрос:', action, table, id);

        // ===== GET =====
        if (action === 'get') {
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
                pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 100'),
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
                    // При создании пользователя создаём баланс
                    if (!user.blocked) {
                        await pool.query(
                            `INSERT INTO balances (username, balance) VALUES ($1, 0) ON CONFLICT (username) DO NOTHING`,
                            [user.username]
                        );
                    }
                }
            }
            if (table === 'balances') {
                for (const bal of data) {
                    await pool.query(
                        `INSERT INTO balances (username, balance) VALUES ($1, $2)
                         ON CONFLICT (username) DO UPDATE SET balance = EXCLUDED.balance`,
                        [bal.username, bal.balance]
                    );
                }
            }
            if (table === 'transactions') {
                for (const tr of data) {
                    await pool.query(
                        `INSERT INTO transactions (id, username, type, amount, description, created_at)
                         VALUES ($1, $2, $3, $4, $5, NOW())`,
                        [tr.id, tr.username, tr.type, tr.amount, tr.description]
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
                         ON CONFLICT (user_id) DO UPDATE SET items = EXCLUDED.items`,
                        [cart.user_id, JSON.stringify(cart.items)]
                    );
                }
            }
            if (table === 'orders') {
                for (const order of data) {
                    await pool.query(
                        `INSERT INTO orders (id, buyer, seller, items, total_ar, total_diamonds, currency, pickup, status, payment_method, created_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
                         ON CONFLICT (id) DO UPDATE SET
                             buyer = EXCLUDED.buyer,
                             seller = EXCLUDED.seller,
                             items = EXCLUDED.items,
                             total_ar = EXCLUDED.total_ar,
                             total_diamonds = EXCLUDED.total_diamonds,
                             currency = EXCLUDED.currency,
                             pickup = EXCLUDED.pickup,
                             status = EXCLUDED.status,
                             payment_method = EXCLUDED.payment_method`,
                        [order.id, order.buyer, order.seller, JSON.stringify(order.items), order.total_ar, order.total_diamonds, order.currency, order.pickup, order.status || 'pending', order.payment_method || 'balance']
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

        // ===== DELETE =====
        if (action === 'delete') {
            console.log('🗑️ DELETE запрос:', table, id);

            if (table === 'products') {
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    await client.query('DELETE FROM wishlist WHERE product_id = $1', [id]);
                    await deleteAllReferencingRows(client, 'products', 'id', id);
                    await client.query('DELETE FROM products WHERE id = $1', [id]);
                    await client.query('COMMIT');
                } catch (err) {
                    await client.query('ROLLBACK');
                    throw err;
                } finally {
                    client.release();
                }
            }
            
            if (table === 'shops') {
                await pool.query('DELETE FROM shops WHERE id = $1', [id]);
            }

            // ===== КАСКАДНОЕ УДАЛЕНИЕ ПРОДАВЦА (С АНУЛИРОВАНИЕМ БАЛАНСА) =====
            if (table === 'users') {
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');

                    // 1. Получаем товары продавца
                    const productIds = (await client.query(
                        'SELECT id FROM products WHERE seller = $1', [id]
                    )).rows.map(r => r.id);

                    // 2. Чистим wishlist и другие таблицы для каждого товара
                    for (const pid of productIds) {
                        await client.query('DELETE FROM wishlist WHERE product_id = $1', [pid]);
                        await deleteAllReferencingRows(client, 'products', 'id', pid);
                    }

                    // 3. Удаляем товары продавца
                    await client.query('DELETE FROM products WHERE seller = $1', [id]);

                    // 4. Корзины и wishlist пользователя
                    await client.query('DELETE FROM carts WHERE user_id = $1', [id]);
                    await client.query('DELETE FROM wishlist WHERE user_id = $1', [id]);

                    // 5. Заказы
                    await client.query('DELETE FROM orders WHERE seller = $1', [id]);
                    await client.query('DELETE FROM orders WHERE buyer = $1', [id]);

                    // 6. Магазин
                    await client.query('DELETE FROM shops WHERE owner = $1', [id]);

                    // 7. Запись из banned_users
                    await client.query('DELETE FROM banned_users WHERE username = $1', [id]);

                    // 8. АНУЛИРУЕМ БАЛАНС (удаляем)
                    await client.query('DELETE FROM balances WHERE username = $1', [id]);

                    // 9. Удаляем транзакции пользователя
                    await client.query('DELETE FROM transactions WHERE username = $1', [id]);

                    // 10. Финальная зачистка
                    await deleteAllReferencingRows(client, 'users', 'username', id);

                    // 11. Удаляем самого пользователя
                    await client.query('DELETE FROM users WHERE username = $1', [id]);

                    await client.query('COMMIT');
                    console.log('✅ Пользователь и баланс удалены:', id);
                } catch (err) {
                    await client.query('ROLLBACK');
                    console.error('❌ Ошибка удаления:', err);
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

        // ============================================================
        // НОВЫЕ ACTION ДЛЯ БАЛАНСА
        // ============================================================

        // ===== ПОПОЛНЕНИЕ БАЛАНСА (СОТРУДНИК ПВЗ) =====
        if (action === 'depositBalance') {
            const { username, amount, description, staffName } = data;
            if (!username || !amount || amount <= 0) {
                return res.status(400).json({ error: 'Укажите пользователя и сумму' });
            }

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // Проверяем, что пользователь существует
                const userCheck = await client.query('SELECT username FROM users WHERE username = $1', [username]);
                if (userCheck.rowCount === 0) {
                    return res.status(404).json({ error: 'Пользователь не найден' });
                }

                // Обновляем баланс
                const result = await client.query(
                    `INSERT INTO balances (username, balance) VALUES ($1, $2)
                     ON CONFLICT (username) DO UPDATE SET balance = balances.balance + EXCLUDED.balance
                     RETURNING balance`,
                    [username, amount]
                );

                // Создаём транзакцию
                const trId = 'tr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                await client.query(
                    `INSERT INTO transactions (id, username, type, amount, description, created_at)
                     VALUES ($1, $2, 'deposit', $3, $4, NOW())`,
                    [trId, username, amount, description || `Пополнение через ПВЗ${staffName ? ' (сотрудник: ' + staffName + ')' : ''}`]
                );

                await client.query('COMMIT');
                return res.status(200).json({ 
                    success: true, 
                    newBalance: result.rows[0].balance,
                    transactionId: trId
                });
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        }

        // ===== ВЫВОД СРЕДСТВ (ДЛЯ ПРОДАВЦОВ ЧЕРЕЗ ПВЗ) =====
        if (action === 'withdrawBalance') {
            const { username, amount, description } = data;
            if (!username || !amount || amount <= 0) {
                return res.status(400).json({ error: 'Укажите пользователя и сумму' });
            }

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // Проверяем баланс
                const balanceCheck = await client.query(
                    'SELECT balance FROM balances WHERE username = $1',
                    [username]
                );
                if (balanceCheck.rowCount === 0 || balanceCheck.rows[0].balance < amount) {
                    return res.status(400).json({ error: 'Недостаточно средств на балансе' });
                }

                // Обновляем баланс
                const result = await client.query(
                    `UPDATE balances SET balance = balance - $1 WHERE username = $2 RETURNING balance`,
                    [amount, username]
                );

                // Создаём транзакцию
                const trId = 'tr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                await client.query(
                    `INSERT INTO transactions (id, username, type, amount, description, created_at)
                     VALUES ($1, $2, 'withdraw', $3, $4, NOW())`,
                    [trId, username, amount, description || 'Вывод средств через ПВЗ']
                );

                await client.query('COMMIT');
                return res.status(200).json({ 
                    success: true, 
                    newBalance: result.rows[0].balance,
                    transactionId: trId
                });
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        }

        // ===== ПЕРЕВОД МЕЖДУ ПОЛЬЗОВАТЕЛЯМИ =====
        if (action === 'transferBalance') {
            const { fromUser, toUser, amount, description } = data;
            if (!fromUser || !toUser || !amount || amount <= 0) {
                return res.status(400).json({ error: 'Укажите отправителя, получателя и сумму' });
            }
            if (fromUser === toUser) {
                return res.status(400).json({ error: 'Нельзя перевести самому себе' });
            }

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // Проверяем, что оба пользователя существуют
                const usersCheck = await client.query(
                    'SELECT username FROM users WHERE username IN ($1, $2)',
                    [fromUser, toUser]
                );
                if (usersCheck.rowCount < 2) {
                    return res.status(404).json({ error: 'Один из пользователей не найден' });
                }

                // Проверяем баланс отправителя
                const balanceCheck = await client.query(
                    'SELECT balance FROM balances WHERE username = $1',
                    [fromUser]
                );
                if (balanceCheck.rowCount === 0 || balanceCheck.rows[0].balance < amount) {
                    return res.status(400).json({ error: 'Недостаточно средств на балансе' });
                }

                // Списываем с отправителя
                await client.query(
                    `UPDATE balances SET balance = balance - $1 WHERE username = $2`,
                    [amount, fromUser]
                );

                // Зачисляем получателю
                await client.query(
                    `INSERT INTO balances (username, balance) VALUES ($1, $2)
                     ON CONFLICT (username) DO UPDATE SET balance = balances.balance + EXCLUDED.balance`,
                    [toUser, amount]
                );

                // Транзакция для отправителя (списание)
                const trId1 = 'tr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                await client.query(
                    `INSERT INTO transactions (id, username, type, amount, description, created_at)
                     VALUES ($1, $2, 'transfer_out', $3, $4, NOW())`,
                    [trId1, fromUser, amount, `Перевод пользователю ${toUser}${description ? ' (' + description + ')' : ''}`]
                );

                // Транзакция для получателя (зачисление)
                const trId2 = 'tr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                await client.query(
                    `INSERT INTO transactions (id, username, type, amount, description, created_at)
                     VALUES ($1, $2, 'transfer_in', $3, $4, NOW())`,
                    [trId2, toUser, amount, `Перевод от пользователя ${fromUser}${description ? ' (' + description + ')' : ''}`]
                );

                // Получаем новый баланс отправителя
                const newBalanceResult = await client.query(
                    'SELECT balance FROM balances WHERE username = $1',
                    [fromUser]
                );

                await client.query('COMMIT');
                return res.status(200).json({ 
                    success: true, 
                    newBalance: newBalanceResult.rows[0]?.balance || 0
                });
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        }

        // ===== ПОЛУЧЕНИЕ БАЛАНСА ПОЛЬЗОВАТЕЛЯ =====
        if (action === 'getBalance') {
            const result = await pool.query(
                'SELECT balance FROM balances WHERE username = $1',
                [id]
            );
            return res.status(200).json({ 
                balance: result.rowCount > 0 ? result.rows[0].balance : 0 
            });
        }

        // ===== ПОЛУЧЕНИЕ ТРАНЗАКЦИЙ ПОЛЬЗОВАТЕЛЯ =====
        if (action === 'getTransactions') {
            const result = await pool.query(
                `SELECT * FROM transactions WHERE username = $1 ORDER BY created_at DESC LIMIT 50`,
                [id]
            );
            return res.status(200).json(result.rows);
        }

        // ===== ПОЛУЧЕНИЕ ВСЕХ ТРАНЗАКЦИЙ (ДЛЯ АДМИНА) =====
        if (action === 'getAllTransactions') {
            const result = await pool.query(
                'SELECT * FROM transactions ORDER BY created_at DESC LIMIT 200'
            );
            return res.status(200).json(result.rows);
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
            
            await pool.query(
                `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
                [orderId]
            );
            
            // Если оплачено с баланса — возвращаем деньги
            if (order.payment_method === 'balance') {
                const amount = order.currency === 'AR' ? order.total_ar : order.total_diamonds;
                await pool.query(
                    `INSERT INTO balances (username, balance) VALUES ($1, $2)
                     ON CONFLICT (username) DO UPDATE SET balance = balances.balance + EXCLUDED.balance`,
                    [buyer, amount]
                );
                // Записываем транзакцию возврата
                const trId = 'tr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                await pool.query(
                    `INSERT INTO transactions (id, username, type, amount, description, created_at)
                     VALUES ($1, $2, 'refund', $3, $4, NOW())`,
                    [trId, buyer, amount, 'Возврат средств за отменённый заказ #' + orderId]
                );
            }
            
            const items = order.items;
            for (const item of items) {
                await pool.query(
                    `UPDATE products SET stock = stock + $1 WHERE id = $2`,
                    [item.quantity, item.productId]
                );
            }
            
            return res.status(200).json({ 
                success: true, 
                message: 'Заказ отменён. Товары возвращены на склад.' 
            });
        }

        // ===== СМЕНА СТАТУСА ЗАКАЗА =====
        if (action === 'updateOrderStatus') {
            const orderId = id;
            const seller = data?.seller;
            const status = data?.status;
            const allowedStatuses = ['pending', 'processing', 'ready', 'completed', 'cancelled'];

            if (!orderId || !seller || !status) {
                return res.status(400).json({ error: 'orderId, seller и status обязательны' });
            }
            if (!allowedStatuses.includes(status)) {
                return res.status(400).json({ error: 'Недопустимый статус: ' + status });
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
