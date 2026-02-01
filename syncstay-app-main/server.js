const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Store active orders
const activeOrders = new Map();

app.use(express.static('public'));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/kitchen.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'kitchen.html'));
});

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // 1. New Order (Customer -> Kitchen)
    socket.on('new_order', (data) => {
        // Store the order
        activeOrders.set(data.orderId, data);

        // Send to kitchen
        io.emit('send_to_kitchen', data);
        console.log('📦 New order:', data.orderId, 'Short ID:', data.shortId);
    });

    // 2. Cancel Entire Order (Customer -> Kitchen)
    socket.on('cancel_order', (data) => {
        console.log('❌ Cancel entire order:', data.orderId);
        // Mark order as canceled
        const order = activeOrders.get(data.orderId);
        if (order) {
            order.status = 'Annulé';
        }
        io.emit('kitchen_cancel', data);
    });

    // 3. Cancel Single Item (Customer -> Kitchen)
    socket.on('cancel_item', (data) => {
        console.log('🔪 Cancel item:', data.orderId, 'itemIndex:', data.itemIndex);
        io.emit('kitchen_cancel_item', data);
    });

    // 4. Mark as Ready (Kitchen -> Customer) - FIXED: Send French status
    socket.on('mark_ready', (orderId) => {
        console.log('✅ Order ready:', orderId);
        io.emit('status_change', {
            orderId: Number(orderId),
            status: 'Prêt à être servi'  // Fixed French status
        });
    });

    // Send all active orders when kitchen connects
    socket.on('request_orders', () => {
        console.log('Sending all active orders to kitchen');
        activeOrders.forEach((order) => {
            if (order.status !== 'Annulé') {
                socket.emit('send_to_kitchen', order);
            }
        });
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`SyncStay running on port ${PORT}`);
});