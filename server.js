const express = require('express');
const cors = require('cors');
const { createClient } = require('redis');

const app = express();
app.use(cors());
app.use(express.json());

const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const CATALOGUE_URL = process.env.CATALOGUE_URL || 'http://catalogue:8002';
const PORT = process.env.PORT || 8003;
const CART_TTL = 3600; // 1 hour

let redisClient;

async function connectRedis() {
    redisClient = createClient({ url: `redis://${REDIS_HOST}:6379` });
    redisClient.on('error', (err) => console.error('Redis error:', err));

    for (let i = 0; i < 30; i++) {
        try {
            await redisClient.connect();
            console.log('Connected to Redis');
            return;
        } catch (err) {
            console.log(`Redis connection attempt ${i + 1}/30 failed, retrying in 2s...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    throw new Error('Failed to connect to Redis');
}

function cartKey(userId) {
    return `cart:${userId}`;
}

async function getCart(userId) {
    const data = await redisClient.get(cartKey(userId));
    return data ? JSON.parse(data) : { userId, items: [] };
}

async function saveCart(userId, cart) {
    await redisClient.setEx(cartKey(userId), CART_TTL, JSON.stringify(cart));
}

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'OK', service: 'cart' });
});

// Get cart
app.get('/cart/:userId', async (req, res) => {
    try {
        const cart = await getCart(req.params.userId);
        res.json(cart);
    } catch (err) {
        console.error('Get cart error:', err.message);
        res.status(500).json({ error: 'Failed to get cart' });
    }
});

// Add to cart
app.post('/cart/:userId/add', async (req, res) => {
    try {
        const { productId, quantity = 1 } = req.body;
        const cart = await getCart(req.params.userId);

        // Fetch product info from catalogue service
        let product;
        try {
            const response = await fetch(`${CATALOGUE_URL}/products/${productId}`);
            if (!response.ok) throw new Error('Product not found');
            product = await response.json();
        } catch (err) {
            return res.status(400).json({ error: 'Product not found in catalogue' });
        }

        const existingItem = cart.items.find(item => item.productId === productId);
        if (existingItem) {
            existingItem.quantity += quantity;
        } else {
            cart.items.push({
                productId,
                name: product.name,
                price: product.price,
                sku: product.sku,
                quantity
            });
        }

        await saveCart(req.params.userId, cart);
        console.log(`Added product ${productId} to cart ${req.params.userId}`);
        res.json(cart);
    } catch (err) {
        console.error('Add to cart error:', err.message);
        res.status(500).json({ error: 'Failed to add to cart' });
    }
});

// Update item quantity
app.put('/cart/:userId/update', async (req, res) => {
    try {
        const { productId, quantity } = req.body;
        const cart = await getCart(req.params.userId);

        const item = cart.items.find(item => item.productId === productId);
        if (!item) {
            return res.status(404).json({ error: 'Item not found in cart' });
        }

        if (quantity <= 0) {
            cart.items = cart.items.filter(item => item.productId !== productId);
        } else {
            item.quantity = quantity;
        }

        await saveCart(req.params.userId, cart);
        res.json(cart);
    } catch (err) {
        console.error('Update cart error:', err.message);
        res.status(500).json({ error: 'Failed to update cart' });
    }
});

// Remove item
app.delete('/cart/:userId/item/:productId', async (req, res) => {
    try {
        const cart = await getCart(req.params.userId);
        cart.items = cart.items.filter(item => String(item.productId) !== req.params.productId);
        await saveCart(req.params.userId, cart);
        res.json(cart);
    } catch (err) {
        console.error('Remove from cart error:', err.message);
        res.status(500).json({ error: 'Failed to remove from cart' });
    }
});

// Clear cart
app.delete('/cart/:userId', async (req, res) => {
    try {
        await redisClient.del(cartKey(req.params.userId));
        res.json({ status: 'ok' });
    } catch (err) {
        console.error('Clear cart error:', err.message);
        res.status(500).json({ error: 'Failed to clear cart' });
    }
});

connectRedis().then(() => {
    app.listen(PORT, () => {
        console.log(`Cart service listening on port ${PORT}`);
    });
});
