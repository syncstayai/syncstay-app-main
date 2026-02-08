const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Store active orders in memory
let activeOrders = [];
let orderHistory = []; // Fixed: Initialize orderHistory to prevent crash

app.use(express.static('public'));

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/kitchen.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'kitchen.html')));
app.get('/pos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pos.html')));

io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);

    // 1. Send data immediately upon connection
    socket.emit('manager_update', activeOrders);

    // 2. Receive New Order from App
    socket.on('new_order', (order) => {
        // Fix: Ensure tableNumber is set correctly from the incoming "table" property
        order.tableNumber = order.table || order.tableNumber || "?";

        console.log('🍔 New Order Recieved from Table:', order.tableNumber);

        // Ensure items have the "isPaid" flag
        order.items = order.items.map(item => ({ ...item, isPaid: false }));

        // Add to memory
        activeOrders.push(order);

        // Broadcast to Manager (pos.html) with new event name
        io.emit('manager_update', activeOrders);

        // Broadcast to Kitchen (unchanged)
        io.emit('send_to_kitchen', order);
    });

    // 3. Mark Item as Paid (Split Bill)
    socket.on('mark_item_paid', ({ orderId, itemIndex }) => {
        const order = activeOrders.find(o => o.orderId === orderId);
        if (order && order.items[itemIndex]) {
            order.items[itemIndex].isPaid = !order.items[itemIndex].isPaid; // Toggle status
            io.emit('manager_update', activeOrders);
        }
    });

    // 5. Kitchen: Mark Order Ready (Triggers Customer Notification)
    socket.on('mark_ready', (orderId) => {
        console.log('✅ Kitchen marked ready:', orderId);

        const order = activeOrders.find(o => o.orderId === orderId);
        if (order) {
            order.status = 'Prêt à être servi';
            order.progress = 100;

            // 1. Notify Customer (Index.html listens for 'status_change')
            io.emit('status_change', {
                orderId: orderId,
                status: 'Prêt à être servi',
                shortId: order.shortId
            });

            // 2. Sync Manager Dashboard
            io.emit('manager_update', activeOrders);
        }
    });

    // 6. Close Table
    socket.on('close_table', (orderId) => {
        console.log('✅ Closing Table for Order:', orderId);
        activeOrders = activeOrders.filter(o => o.orderId !== orderId);
        io.emit('manager_update', activeOrders);
    });

    // 7. Kitchen: Reject Entire Order
    socket.on('kitchen_reject_order', (orderId) => {
        console.log('❌ Kitchen rejected order:', orderId);
        const order = activeOrders.find(o => o.orderId === orderId);
        if (order) {
            order.status = 'Annulé';
            // Broadcast to everyone. Clients will filter if it belongs to them.
            io.emit('alert_customer', {
                type: 'order',
                orderId: orderId,
                message: "Commande annulée par la cuisine"
            });
            io.emit('manager_update', activeOrders);
        }
    });

    // 8. Kitchen: Reject Specific Item
    socket.on('kitchen_reject_item', ({ orderId, itemIndex }) => {
        console.log('⚠️ Kitchen rejected item in order:', orderId, 'Index:', itemIndex);
        const order = activeOrders.find(o => o.orderId === orderId);
        if (order && order.items[itemIndex]) {
            order.items[itemIndex].cancelled = true;

            // Broadcast to everyone
            io.emit('alert_customer', {
                type: 'item',
                orderId: orderId,
                itemIndex: itemIndex,
                itemName: order.items[itemIndex].name,
                message: `Article non disponible: ${order.items[itemIndex].name}`
            });
            io.emit('manager_update', activeOrders);
        }
    });

    // NEW: Customer Cancel Order - FIXED VERSION
    socket.on('cancel_order', (data) => {
        // Handle both object and direct ID for robustness
        const orderId = typeof data === 'object' ? data.orderId : data;

        console.log('🚫 Customer canceled order:', orderId);
        const order = activeOrders.find(o => o.orderId === orderId);

        if (order) {
            // 1. Mark order as canceled
            order.status = 'Annulé';
            order.canCancel = false;

            // Mark items as cancelled for consistency
            if (order.items) {
                order.items.forEach(item => item.cancelled = true);
            }

            // 2. Store in history
            const historyEntry = {
                ...order,
                finalStatus: 'canceled',
                finalTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                finalTotal: 0
            };
            orderHistory.push(historyEntry);

            // 3. BROADCAST TO KITCHEN (Triggers Animation)
            console.log('📡 Broadcasting kitchen_cancel to all clients for order:', orderId);
            io.emit('kitchen_cancel', {
                orderId: orderId,
                status: 'Annulé'
            });

            // 4. Remove from active orders immediately (so it vanishes from POS)
            activeOrders = activeOrders.filter(o => o.orderId !== orderId);

            // 5. BROADCAST TO POS (Refreshes Grid)
            console.log('📡 Broadcasting manager_update to all clients');
            io.emit('manager_update', activeOrders);

            // Alert customer
            io.emit('alert_customer', {
                type: 'order',
                orderId: orderId,
                message: "Votre commande a été annulée"
            });

        } else {
            console.log('⚠️ Order not found for cancellation:', orderId);
        }
    });

    // NEW: Customer Cancel Item
    socket.on('cancel_item', ({ orderId, itemIndex }) => {
        console.log('⚠️ Customer canceled item in order:', orderId, 'Index:', itemIndex);
        const order = activeOrders.find(o => o.orderId === orderId);
        if (order && order.items[itemIndex]) {
            order.items[itemIndex].cancelled = true;

            // Broadcast to kitchen
            io.emit('kitchen_cancel_item', { orderId, itemIndex });

            // Broadcast to POS
            io.emit('manager_update', activeOrders);
        }
    });

    // 9. Call Waiter Signal
    socket.on('call_waiter', (payload) => {
        // Support both object { orderId } or direct table/order ID for backward compatibility/robustness
        const orderId = payload.orderId || payload;
        const tableNum = payload.tableNumber;

        console.log('🔔 Waiter called. Payload:', payload);

        let order;
        if (orderId) {
            order = activeOrders.find(o => o.orderId === orderId);
        }

        // Fallback: Try to find by table number if orderId didn't match or wasn't provided
        if (!order && tableNum) {
            order = activeOrders.find(o => o.tableNumber == tableNum);
        }

        if (order) {
            order.needsWaiter = true;
            console.log(`✅ set needsWaiter=true for order ${order.orderId}`);
            io.emit('waiter_call', order); // NEW: Broadcast event
            io.emit('manager_update', activeOrders);
        } else if (tableNum) {
            console.log("⚠️ No active order found, creating placeholder for waiter call");
            const newOrder = {
                orderId: Date.now(),
                shortId: Date.now().toString().slice(-4),
                tableNumber: tableNum,
                items: [], // Empty items
                status: 'Service Demandé',
                needsWaiter: true,
                isPaid: false
            };
            activeOrders.push(newOrder);
            io.emit('waiter_call', newOrder); // NEW: Broadcast event
            io.emit('manager_update', activeOrders);
        } else {
            console.log("❌ Could not find order for waiter call");
        }
    });

    // 10. Resolve Waiter Signal
    socket.on('resolve_waiter_call', (orderId) => {
        console.log('🔕 Waiter signal resolved:', orderId);
        const order = activeOrders.find(o => o.orderId === orderId);
        if (order) {
            order.needsWaiter = false;

            // NEW: If this was an empty "service request" (no items), remove it completely
            if (!order.items || order.items.length === 0) {
                console.log(`🗑️ Removing empty service request for table ${order.tableNumber}`);
                activeOrders = activeOrders.filter(o => o.orderId !== orderId);
            }

            io.emit('manager_update', activeOrders);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});