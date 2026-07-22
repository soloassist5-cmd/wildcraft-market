import { Pool } from 'pg';

const pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

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
        const { action, table, data, id } = req.body;

        console.log('📥 Запрос:', action, table, id);

        // ===== GET =====
        if (action === 'get') {
            const result = await pool.query(`SELECT * FROM ${table}`);
            return res.status(200).json(result.rows);
        }

        // ===== GET ALL =====
        if (action === 'getAll') {
            const [users, shops, products, carts, orders, pickupPoints, bannedUsers, rules, wishlist] = await Promise.all([
                pool.query('SELECT * FROM users'),
                pool.query('SELECT * FROM shops'),
                pool.query('SELECT * FROM products'),
                pool.query('SELECT * FROM carts'),
                pool.query('SELECT * FROM orders'),
                pool.query('SELECT * FROM pickup_points'),
                pool.query('SELECT * FROM banned_users'),
                pool.query('SELECT * FROM rules'),
                pool.query('SELECT * FROM wishlist'),
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
            
            await pool.query(
                `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
                [orderId]
            );
            
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
