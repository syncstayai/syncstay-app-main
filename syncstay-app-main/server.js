const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Store active orders in memory with server-side timers
let activeOrders = [];
let orderHistory = [];

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

    // 20s cancellation window
    const cancelTimer = setTimeout(() => {
        const o = activeOrders.find(x => x.orderId === order.orderId);
        if (o && o.status === "In Warteschlange") {
            o.canCancel = false;
            console.log(`Server: Order #${order.shortId} cancellation window closed at 20s`);
            io.emit('status_update', { orderId: order.orderId, canCancel: false });
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

            io.emit('status_change', {
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

    // Send data immediately upon connection
    socket.emit('manager_update', activeOrders);

    // 1. Receive New Order from App
    socket.on('new_order', (order) => {
        order.tableNumber = order.table || order.tableNumber || "?";
        order.createdAt = Date.now();
        order.lastUpdated = Date.now();
        order.canCancel = true;
        order.needsWaiter = false;

        console.log('🍔 New Order from Table:', order.tableNumber, 'ID:', order.shortId);

        // Ensure items have the "isPaid" flag
        order.items = order.items.map(item => ({ ...item, isPaid: false, cancelled: false }));

        // Add to memory
        activeOrders.push(order);

        // Setup server-side timers
        setupOrderTimers(order);

        // Broadcast to Manager (pos.html)
        io.emit('manager_update', activeOrders);

        // Broadcast to Kitchen
        io.emit('send_to_kitchen', order);

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
    socket.on('mark_item_paid', ({ orderId, itemIndex }) => {
        const order = activeOrders.find(o => o.orderId === orderId);
        if (order && order.items[itemIndex]) {
            order.items[itemIndex].isPaid = !order.items[itemIndex].isPaid;
            io.emit('manager_update', activeOrders);
        }
    });

    // 4. Kitchen: Mark Order Ready
    socket.on('mark_ready', (orderId) => {
        console.log('✅ Kitchen marked ready:', orderId);

        const order = activeOrders.find(o => o.orderId === orderId);
        if (order) {
            clearOrderTimers(orderId);

            order.status = 'Prêt à être servi';
            order.progress = 100;
            order.lastUpdated = Date.now();

            // Notify Customer
            io.emit('status_change', {
                orderId: orderId,
                status: 'Prêt à être servi',
                shortId: order.shortId
            });

            // Sync Manager Dashboard
            io.emit('manager_update', activeOrders);
        }
    });

    // 5. Close Table
    socket.on('close_table', (orderId) => {
        console.log('✅ Closing Table for Order:', orderId);

        // Add to history before removing
        const order = activeOrders.find(o => o.orderId === orderId);
        if (order) {
            const historyEntry = {
                ...order,
                finalStatus: 'completed',
                finalTime: new Date().toLocaleTimeString(),
                finalTotal: order.items.reduce((sum, item) => sum + (item.cancelled ? 0 : item.price), 0)
            };
            orderHistory.push(historyEntry);
        }

        clearOrderTimers(orderId);
        activeOrders = activeOrders.filter(o => o.orderId !== orderId);
        io.emit('manager_update', activeOrders);
    });

    // 6. Kitchen: Reject Entire Order
    socket.on('kitchen_reject_order', (orderId) => {
        console.log('❌ Kitchen rejected order:', orderId);
        const order = activeOrders.find(o => o.orderId === orderId);
        if (order) {
            clearOrderTimers(orderId);
            order.status = 'Annulé';
            order.lastUpdated = Date.now();

            // Broadcast to everyone
            io.emit('alert_customer', {
                type: 'order',
                orderId: orderId,
                message: "Commande annulée par la cuisine"
            });

            // Update POS immediately
            io.emit('kitchen_cancel', orderId);
            io.emit('manager_update', activeOrders);
        }
    });

    // 7. Kitchen: Reject Specific Item
    socket.on('kitchen_reject_item', ({ orderId, itemIndex }) => {
        console.log('⚠️ Kitchen rejected item:', orderId, 'Index:', itemIndex);
        const order = activeOrders.find(o => o.orderId === orderId);
        if (order && order.items[itemIndex]) {
            order.items[itemIndex].cancelled = true;
            order.lastUpdated = Date.now();

            io.emit('alert_customer', {
                type: 'item',
                orderId: orderId,
                itemIndex: itemIndex,
                itemName: order.items[itemIndex].name
            });

            io.emit('manager_update', activeOrders);
        }
    });

    // 8. Customer Cancel Order
    socket.on('cancel_order', (data) => {
        const orderId = typeof data === 'object' ? data.orderId : data;
        console.log('🚫 Customer canceled order:', orderId);

        const order = activeOrders.find(o => o.orderId === orderId);
        if (order) {
            clearOrderTimers(orderId);
            order.status = 'Annulé';
            order.canCancel = false;
            order.lastUpdated = Date.now();

            // Mark all items as cancelled
            order.items.forEach(item => item.cancelled = true);

            // Store in history
            const historyEntry = {
                ...order,
                finalStatus: 'canceled',
                finalTime: new Date().toLocaleTimeString(),
                finalTotal: 0
            };
            orderHistory.push(historyEntry);

            // Notify kitchen with premium animation
            io.emit('kitchen_cancel', {
                orderId: orderId,
                shortId: order.shortId
            });

            // Update POS
            activeOrders = activeOrders.filter(o => o.orderId !== orderId);
            io.emit('manager_update', activeOrders);

            // Alert customer
            io.emit('alert_customer', {
                type: 'order',
                orderId: orderId,
                message: "Votre commande a été annulée"
            });
        }
    });

    // 9. Customer Cancel Item
    socket.on('cancel_item', ({ orderId, itemIndex }) => {
        console.log('⚠️ Customer canceled item:', orderId, 'Index:', itemIndex);
        const order = activeOrders.find(o => o.orderId === orderId);
        if (order && order.items[itemIndex]) {
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
                    io.emit('manager_update', activeOrders);
                }, 5000);
            }

            io.emit('kitchen_cancel_item', { orderId, itemIndex });
            io.emit('manager_update', activeOrders);
        }
    });

    // 10. Call Waiter - ENHANCED with server-side persistence
    socket.on('call_waiter', (payload) => {
        const orderId = payload.orderId;
        const tableNum = payload.tableNumber || payload.table;

        console.log('🔔 Waiter called for Table:', tableNum, 'Order:', orderId);

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
                createdAt: Date.now()
            };
            activeOrders.push(order);
            console.log(`📝 Created service request for table ${tableNum}`);
        }

        // Broadcast to POS with animation
        io.emit('waiter_call', order);
        io.emit('manager_update', activeOrders);
    });

    // 11. Resolve Waiter Call
    socket.on('resolve_waiter_call', (orderId) => {
        console.log('🔕 Waiter signal resolved:', orderId);
        const order = activeOrders.find(o => o.orderId === orderId);
        if (order) {
            order.needsWaiter = false;

            // Remove empty service requests
            if (!order.items || order.items.length === 0) {
                console.log(`🗑️ Removing empty service request for table ${order.table}`);
                activeOrders = activeOrders.filter(o => o.orderId !== orderId);
            }

            io.emit('manager_update', activeOrders);
        }
    });

    // 12. Heartbeat/ping for connection monitoring
    socket.on('ping', () => {
        socket.emit('pong', { timestamp: Date.now() });
    });

    // 13. Disconnect handling
    socket.on('disconnect', () => {
        console.log('� Client disconnected:', socket.id);
    });
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
});