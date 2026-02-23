const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

// --- MongoDB (Optional) ---
const MONGO_URI = process.env.MONGO_URI || null;

const orderSchema = new mongoose.Schema({
    tenantId: String, orderId: Number, shortId: String, tableNumber: String,
    items: Array, status: String, finalStatus: String, finalTotal: Number, finalTime: String, createdAt: Date
});
const Order = mongoose.model('Order', orderSchema);

if (MONGO_URI) {
    mongoose.connect(MONGO_URI).then(() => console.log('🟢 MongoDB Connected')).catch(err => console.error('❌ MongoDB Error:', err));
}

// --- Hardcoded Tenants for Beta ---
const TENANT_PINS = { "default": "0000", "gasthof": "1234", "berlincafe": "5555" };

// Railway Volumes usually mount to /app/data. Fallback to local dir if missing.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

// Ensure directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Helper: Load History on Startup
function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf8');
            orderHistory = JSON.parse(data);
            console.log(`📂 Loaded ${orderHistory.length} records from history.`);
        }
    } catch (err) {
        console.error("❌ Failed to load history:", err);
        orderHistory = []; // Fallback
    }
}

// Helper: Save History (Append-Only Logic)
function saveHistory() {
    try {
        // We write the full array to ensure sync.
        // In a high-scale app, we would append to a stream, but this ensures consistency for now.
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(orderHistory, null, 2));
    } catch (err) {
        console.error("❌ Failed to save history:", err);
    }
}

// Store active orders in memory with server-side timers
let activeOrders = [];
let orderHistory = [];

// INITIALIZE
loadHistory();

app.use(express.static('public'));

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/kitchen.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'kitchen.html')));
app.get('/pos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pos.html')));

// Server-side timer management
const orderTimers = new Map();

function setupOrderTimers(order) {
    // Clear any existing timers for this order
    if (orderTimers.has(order.orderId)) {
        const timers = orderTimers.get(order.orderId);
        timers.forEach(timer => clearTimeout(timer));
        orderTimers.delete(order.orderId);
    }

    const tenantId = order.tenantId || 'default';

    // 20s cancellation window
    const cancelTimer = setTimeout(() => {
        const o = activeOrders.find(x => x.orderId === order.orderId);
        if (o && o.status === "In Warteschlange") {
            o.canCancel = false;
            console.log(`Server: Order #${order.shortId} cancellation window closed at 20s`);
            io.to(tenantId).emit('status_update', { orderId: order.orderId, canCancel: false });
        }
    }, 20000);

    // 30s auto-cooking
    const cookingTimer = setTimeout(() => {
        const o = activeOrders.find(x => x.orderId === order.orderId);
        if (o && o.status === "In Warteschlange") {
            o.status = "In Zubereitung";
            o.progress = 50;
            o.canCancel = false;
            console.log(`Server: Order #${order.shortId} auto-moved to cooking at 30s`);

            io.to(tenantId).emit('status_change', {
                orderId: order.orderId,
                status: "In Zubereitung",
                progress: 50
            });
        }
    }, 30000);

    orderTimers.set(order.orderId, [cancelTimer, cookingTimer]);
}

function clearOrderTimers(orderId) {
    if (orderTimers.has(orderId)) {
        const timers = orderTimers.get(orderId);
        timers.forEach(timer => clearTimeout(timer));
        orderTimers.delete(orderId);
    }
}

io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);

    // --- Multi-Tenant Auth ---
    socket.on('authenticate', ({ tenantId, pin }, callback) => {
        if (TENANT_PINS[tenantId] && TENANT_PINS[tenantId] === pin) {
            socket.join(tenantId);
            socket.tenantId = tenantId;
            socket.isAuthenticated = true;
            callback({ success: true });
            socket.emit('manager_update', activeOrders.filter(o => o.tenantId === tenantId));
        } else {
            callback({ success: false, message: "Falscher PIN Code" });
        }
    });

    socket.on('join_tenant', (tenantId) => {
        socket.join(tenantId);
        socket.tenantId = tenantId;
    });

    // 1. Receive New Order from App
    socket.on('new_order', (order) => {
        const tenantId = order.tenantId || socket.tenantId || 'default';
        order.tenantId = tenantId;
        order.tableNumber = order.table || order.tableNumber || "?";
        order.createdAt = Date.now();
        order.lastUpdated = Date.now();
        order.canCancel = true;
        order.needsWaiter = false;

        console.log('🍔 New Order from Table:', order.tableNumber, 'ID:', order.shortId, 'Tenant:', tenantId);

        // Ensure items have the "isPaid" flag
        order.items = order.items.map(item => ({ ...item, isPaid: false, cancelled: false }));

        // Add to memory
        activeOrders.push(order);

        // Setup server-side timers
        setupOrderTimers(order);

        // Broadcast to Manager (pos.html)
        io.to(tenantId).emit('manager_update', activeOrders.filter(o => o.tenantId === tenantId));

        // Broadcast to Kitchen
        io.to(tenantId).emit('send_to_kitchen', order);

        // Notify customer (for their own order)
        socket.emit('order_confirmed', {
            orderId: order.orderId,
            shortId: order.shortId,
            status: "In Warteschlange"
        });
    });

    // 2. Session Restoration Handshake
    socket.on('restore_session', (orderId) => {
        console.log('🔄 Session restore requested for:', orderId);
        const order = activeOrders.find(o => o.orderId == orderId);
        if (order) {
            console.log(`✅ Restoring session for Order #${order.shortId}`);
            socket.emit('session_restored', order);
        } else {
            console.log(`❌ Session expired for: ${orderId}`);
            socket.emit('session_expired');
        }
    });

    // 3. Mark Item as Paid (Split Bill)
    socket.on('mark_item_paid', ({ orderId, itemIndex, tenantId }) => {
        const tid = tenantId || socket.tenantId || 'default';
        const order = activeOrders.find(o => o.orderId === orderId);
        if (order && order.items[itemIndex]) {
            order.items[itemIndex].isPaid = !order.items[itemIndex].isPaid;
            io.to(tid).emit('manager_update', activeOrders.filter(o => o.tenantId === tid));
        }
    });

    // 4. Kitchen: Mark Order Ready
    socket.on('mark_ready', (data) => {
        const orderId = typeof data === 'object' ? data.orderId : data;
        const tenantId = (typeof data === 'object' && data.tenantId) ? data.tenantId : socket.tenantId || 'default';
        console.log('✅ Kitchen marked ready:', orderId);

        const order = activeOrders.find(o => o.orderId === orderId);
        if (order) {
            clearOrderTimers(orderId);
            const tid = order.tenantId || tenantId;

            order.status = 'Prêt à être servi';
            order.progress = 100;
            order.lastUpdated = Date.now();

            // Notify Customer
            io.to(tid).emit('status_change', {
                orderId: orderId,
                status: 'Prêt à être servi',
                shortId: order.shortId
            });

            // Sync Manager Dashboard
            io.to(tid).emit('manager_update', activeOrders.filter(o => o.tenantId === tid));
        }
    });

    // 5. Close Table
    socket.on('close_table', (data) => {
        const orderId = typeof data === 'object' ? data.orderId : data;
        const tenantId = (typeof data === 'object' && data.tenantId) ? data.tenantId : socket.tenantId || 'default';
        console.log('✅ Closing Table for Order:', orderId);

        // Add to history before removing
        const order = activeOrders.find(o => o.orderId === orderId);
        if (order) {
            const tid = order.tenantId || tenantId;
            const historyEntry = {
                ...order,
                finalStatus: 'Abgeschlossen',
                finalTime: new Date().toLocaleTimeString(),
                finalTotal: order.items.reduce((sum, item) => sum + (item.cancelled ? 0 : item.price), 0)
            };
            orderHistory.unshift(historyEntry);
            saveHistory(); // <--- Persist to disk

            // Also save to MongoDB if connected
            if (MONGO_URI) {
                new Order(historyEntry).save().catch(err => console.error('MongoDB save error:', err));
            }

            clearOrderTimers(orderId);
            activeOrders = activeOrders.filter(o => o.orderId !== orderId);
            io.to(tid).emit('manager_update', activeOrders.filter(o => o.tenantId === tid));
        }
    });

    // 6. Kitchen: Reject Entire Order
    socket.on('kitchen_reject_order', (data) => {
        const orderId = typeof data === 'object' ? data.orderId : data;
        const tenantId = (typeof data === 'object' && data.tenantId) ? data.tenantId : socket.tenantId || 'default';
        console.log('❌ Kitchen rejected order:', orderId);
        const order = activeOrders.find(o => o.orderId === orderId);
        if (order) {
            const tid = order.tenantId || tenantId;
            clearOrderTimers(orderId);
            order.status = 'Annulé';
            order.lastUpdated = Date.now();

            // Broadcast to everyone in tenant
            io.to(tid).emit('alert_customer', {
                type: 'order',
                orderId: orderId,
                message: "Commande annulée par la cuisine"
            });

            // Update POS immediately
            io.to(tid).emit('kitchen_cancel', orderId);
            io.to(tid).emit('manager_update', activeOrders.filter(o => o.tenantId === tid));
        }
    });

    // 7. Kitchen: Reject Specific Item
    socket.on('kitchen_reject_item', ({ orderId, itemIndex, tenantId }) => {
        const tid = tenantId || socket.tenantId || 'default';
        console.log('⚠️ Kitchen rejected item:', orderId, 'Index:', itemIndex);
        const order = activeOrders.find(o => o.orderId === orderId);
        if (order && order.items[itemIndex]) {
            order.items[itemIndex].cancelled = true;
            order.lastUpdated = Date.now();

            io.to(order.tenantId || tid).emit('alert_customer', {
                type: 'item',
                orderId: orderId,
                itemIndex: itemIndex,
                itemName: order.items[itemIndex].name
            });

            io.to(order.tenantId || tid).emit('manager_update', activeOrders.filter(o => o.tenantId === (order.tenantId || tid)));
        }
    });

    // 8. Customer Cancel Order
    socket.on('cancel_order', (data) => {
        const orderId = typeof data === 'object' ? data.orderId : data;
        const tenantId = (typeof data === 'object' && data.tenantId) ? data.tenantId : socket.tenantId || 'default';
        console.log('🚫 Customer canceled order:', orderId);

        const order = activeOrders.find(o => o.orderId === orderId);
        if (order) {
            const tid = order.tenantId || tenantId;
            clearOrderTimers(orderId);
            order.status = 'Annulé';
            order.canCancel = false;
            order.lastUpdated = Date.now();

            // Mark all items as cancelled
            order.items.forEach(item => item.cancelled = true);

            // Store in history
            const historyEntry = {
                ...order,
                finalStatus: 'Storniert',
                finalTime: new Date().toLocaleTimeString(),
                finalTotal: 0
            };
            orderHistory.push(historyEntry);
            saveHistory(); // <--- Persist to disk

            // Also save to MongoDB if connected
            if (MONGO_URI) {
                new Order(historyEntry).save().catch(err => console.error('MongoDB save error:', err));
            }

            // Notify kitchen with premium animation
            io.to(tid).emit('kitchen_cancel', {
                orderId: orderId,
                shortId: order.shortId
            });

            // Update POS
            activeOrders = activeOrders.filter(o => o.orderId !== orderId);
            io.to(tid).emit('manager_update', activeOrders.filter(o => o.tenantId === tid));

            // Alert customer
            io.to(tid).emit('alert_customer', {
                type: 'order',
                orderId: orderId,
                message: "Votre commande a été annulée"
            });
        }
    });

    // 9. Customer Cancel Item
    socket.on('cancel_item', ({ orderId, itemIndex, tenantId }) => {
        const tid = tenantId || socket.tenantId || 'default';
        console.log('⚠️ Customer canceled item:', orderId, 'Index:', itemIndex);
        const order = activeOrders.find(o => o.orderId === orderId);
        if (order && order.items[itemIndex]) {
            const orderTid = order.tenantId || tid;
            order.items[itemIndex].cancelled = true;
            order.lastUpdated = Date.now();

            // Check if all items are cancelled
            const allCancelled = order.items.every(item => item.cancelled === true);
            if (allCancelled) {
                order.status = 'Annulé';
                order.canCancel = false;
                clearOrderTimers(orderId);

                setTimeout(() => {
                    activeOrders = activeOrders.filter(o => o.orderId !== orderId);
                    io.to(orderTid).emit('manager_update', activeOrders.filter(o => o.tenantId === orderTid));
                }, 5000);
            }

            io.to(orderTid).emit('kitchen_cancel_item', { orderId, itemIndex });
            io.to(orderTid).emit('manager_update', activeOrders.filter(o => o.tenantId === orderTid));
        }
    });

    // 10. Call Waiter - ENHANCED with server-side persistence
    socket.on('call_waiter', (payload) => {
        const orderId = payload.orderId;
        const tableNum = payload.tableNumber || payload.table;
        const tenantId = payload.tenantId || socket.tenantId || 'default';

        console.log('🔔 Waiter called for Table:', tableNum, 'Order:', orderId, 'Tenant:', tenantId);

        let order;

        // Find order by orderId first
        if (orderId) {
            order = activeOrders.find(o => o.orderId === orderId);
        }

        // If not found by orderId, find by table number
        if (!order && tableNum) {
            order = activeOrders.find(o => o.table == tableNum || o.tableNumber == tableNum);
        }

        if (order) {
            order.needsWaiter = true;
            order.waiterCalledAt = Date.now();
            console.log(`✅ Waiter flag set for order ${order.shortId}`);
        } else {
            // Create a placeholder service request
            order = {
                orderId: Date.now(),
                shortId: Date.now().toString().slice(-4),
                tableNumber: tableNum,
                table: tableNum,
                items: [],
                status: 'Service Demandé',
                needsWaiter: true,
                waiterCalledAt: Date.now(),
                createdAt: Date.now(),
                tenantId: tenantId
            };
            activeOrders.push(order);
            console.log(`📝 Created service request for table ${tableNum}`);
        }

        const tid = order.tenantId || tenantId;

        // Broadcast to POS with animation
        io.to(tid).emit('waiter_call', order);
        io.to(tid).emit('manager_update', activeOrders.filter(o => o.tenantId === tid));
    });

    // 11. Resolve Waiter Call
    socket.on('resolve_waiter_call', (data) => {
        const orderId = typeof data === 'object' ? data.orderId : data;
        const tenantId = (typeof data === 'object' && data.tenantId) ? data.tenantId : socket.tenantId || 'default';
        console.log('🔕 Waiter signal resolved:', orderId);
        const order = activeOrders.find(o => o.orderId === orderId);
        if (order) {
            const tid = order.tenantId || tenantId;
            order.needsWaiter = false;

            // Remove empty service requests
            if (!order.items || order.items.length === 0) {
                console.log(`🗑️ Removing empty service request for table ${order.table}`);
                activeOrders = activeOrders.filter(o => o.orderId !== orderId);
            }

            io.to(tid).emit('manager_update', activeOrders.filter(o => o.tenantId === tid));
        }
    });

    // 12. Heartbeat/ping for connection monitoring
    socket.on('ping', () => {
        socket.emit('pong', { timestamp: Date.now() });
    });

    // 13. Disconnect handling
    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
    });
});

// CSV Export Route (Tenant-scoped)
app.get('/api/export-history/:tenantId', async (req, res) => {
    try {
        const tenantId = req.params.tenantId;
        let orders;

        if (MONGO_URI) {
            orders = await Order.find({ tenantId: tenantId });
        } else {
            orders = orderHistory.filter(o => o.tenantId === tenantId);
        }

        const fields = ['Datum', 'Uhrzeit', 'Bestell-Nr.', 'Tisch', 'Status', 'Gesamt(EUR)', 'Artikel'];
        const csvRows = [fields.join(',')];

        orders.forEach(order => {
            // Safe comma handling for CSV
            const itemsList = order.items.map(i =>
                `${i.qty}x ${i.name} (${i.cancelled ? 'VOID' : i.price.toFixed(2)})`
            ).join(' | ').replace(/\"/g, '""');

            const row = [
                new Date(order.createdAt || Date.now()).toLocaleDateString('de-DE'),
                order.finalTime || '00:00',
                order.shortId,
                order.tableNumber,
                order.finalStatus,
                (order.finalTotal || 0).toFixed(2),
                `"${itemsList}"` // Wrap items in quotes
            ];
            csvRows.push(row.join(','));
        });

        const csvString = csvRows.join('\n');
        res.header('Content-Type', 'text/csv');
        res.attachment(`SyncStay_Report_${tenantId}_${new Date().toISOString().split('T')[0]}.csv`);
        res.send(csvString);
    } catch (e) {
        console.error(e);
        res.status(500).send("Error generating report");
    }
});

// Keep legacy route for backward compatibility
app.get('/api/export-history', (req, res) => {
    res.redirect('/api/export-history/default');
});

// Periodic cleanup of old orders (24 hours)
setInterval(() => {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000);
    activeOrders = activeOrders.filter(order => order.lastUpdated > cutoff);
}, 3600000); // Run every hour

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Active orders in memory: ${activeOrders.length}`);
    console.log(`🏢 Tenants: ${Object.keys(TENANT_PINS).join(', ')}`);
});