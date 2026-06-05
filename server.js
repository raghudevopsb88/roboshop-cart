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
let redisReady = false;

function log(msg) {
    console.log(msg);
}

function logError(context, err, extra = '') {
    const detail = err && err.stack ? err.stack : (err && err.message ? err.message : String(err));
    console.error(`[cart] ${context}${extra ? ` ${extra}` : ''}: ${detail}`);
}

function initRedisClient() {
    if (redisClient) {
        return;
    }
    redisClient = createClient({
        url: `redis://${REDIS_HOST}:6379`,
        socket: {
            connectTimeout: 10_000,
            reconnectStrategy: (retries) => Math.min(retries * 200, 3000),
        },
    });

    redisClient.on('error', (err) => {
        redisReady = false;
        logError('Redis client error', err, `host=${REDIS_HOST}`);
    });

    redisClient.on('ready', () => {
        redisReady = true;
        log(`Redis ready (host=${REDIS_HOST})`);
    });

    redisClient.on('end', () => {
        redisReady = false;
        log(`Redis connection ended (host=${REDIS_HOST})`);
    });
}

async function connectRedisOnce() {
    initRedisClient();
    if (redisClient.isOpen) {
        redisReady = true;
        return;
    }
    await redisClient.connect();
    redisReady = true;
    log(`Connected to Redis at ${REDIS_HOST}:6379`);
}

function ensureRedis(req, res, next) {
    if (!redisClient || !redisReady || !redisClient.isReady) {
        logError(
            'Request rejected — Redis unavailable',
            new Error('not ready'),
            `${req.method} ${req.originalUrl}`
        );
        return res.status(503).json({ error: 'Cart storage unavailable' });
    }
    next();
}

app.use((req, res, next) => {
    const start = Date.now();
    log(`>> ${req.method} ${req.originalUrl}`);
    res.on('finish', () => {
        const ms = Date.now() - start;
        log(`<< ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
    });
    next();
});

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

async function fetchProduct(productId) {
    const url = `${CATALOGUE_URL}/products/${productId}`;
    let response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    } catch (err) {
        logError('Catalogue fetch failed', err, `url=${url}`);
        throw err;
    }
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        logError(
            'Catalogue returned error',
            new Error(`HTTP ${response.status}`),
            `url=${url} body=${body.slice(0, 200)}`
        );
        return null;
    }
    return response.json();
}

app.get('/health', async (req, res) => {
    if (!redisClient || !redisReady || !redisClient.isReady) {
        return res.status(503).json({ status: 'DOWN', service: 'cart', redis: 'disconnected' });
    }
    try {
        await redisClient.ping();
        res.json({ status: 'OK', service: 'cart', redis: REDIS_HOST });
    } catch (err) {
        logError('Health check Redis ping failed', err);
        res.status(503).json({ status: 'DOWN', service: 'cart', redis: 'ping failed' });
    }
});

app.use(ensureRedis);

app.get('/cart/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const cart = await getCart(userId);
        log(`Get cart ${userId}: ${cart.items.length} item(s)`);
        res.json(cart);
    } catch (err) {
        logError('Get cart failed', err, `userId=${userId}`);
        res.status(500).json({ error: 'Failed to get cart' });
    }
});

app.post('/cart/:userId/add', async (req, res) => {
    const { userId } = req.params;
    try {
        const { productId, quantity = 1 } = req.body;
        if (!productId) {
            log(`Add to cart ${userId} rejected: missing productId`);
            return res.status(400).json({ error: 'productId is required' });
        }

        const cart = await getCart(userId);
        const product = await fetchProduct(productId);
        if (!product) {
            return res.status(400).json({ error: 'Product not found in catalogue' });
        }

        const existingItem = cart.items.find((item) => item.productId === productId);
        if (existingItem) {
            existingItem.quantity += quantity;
        } else {
            cart.items.push({
                productId,
                name: product.name,
                price: product.price,
                sku: product.sku,
                quantity,
            });
        }

        await saveCart(userId, cart);
        log(`Added product ${productId} to cart ${userId} (qty=${quantity}, items=${cart.items.length})`);
        res.json(cart);
    } catch (err) {
        logError('Add to cart failed', err, `userId=${userId} body=${JSON.stringify(req.body)}`);
        res.status(500).json({ error: 'Failed to add to cart' });
    }
});

app.put('/cart/:userId/update', async (req, res) => {
    const { userId } = req.params;
    try {
        const { productId, quantity } = req.body;
        if (!productId || quantity === undefined) {
            log(`Update cart ${userId} rejected: missing productId or quantity`);
            return res.status(400).json({ error: 'productId and quantity are required' });
        }

        const cart = await getCart(userId);
        const item = cart.items.find((i) => i.productId === productId);
        if (!item) {
            log(`Update cart ${userId} failed: product ${productId} not in cart`);
            return res.status(404).json({ error: 'Item not found in cart' });
        }

        if (quantity <= 0) {
            cart.items = cart.items.filter((i) => i.productId !== productId);
        } else {
            item.quantity = quantity;
        }

        await saveCart(userId, cart);
        log(`Updated cart ${userId}: product ${productId} qty=${quantity} items=${cart.items.length}`);
        res.json(cart);
    } catch (err) {
        logError('Update cart failed', err, `userId=${userId} body=${JSON.stringify(req.body)}`);
        res.status(500).json({ error: 'Failed to update cart' });
    }
});

app.delete('/cart/:userId/item/:productId', async (req, res) => {
    const { userId, productId } = req.params;
    try {
        const cart = await getCart(userId);
        const before = cart.items.length;
        cart.items = cart.items.filter((item) => String(item.productId) !== productId);
        await saveCart(userId, cart);
        log(`Removed product ${productId} from cart ${userId} (${before} -> ${cart.items.length} items)`);
        res.json(cart);
    } catch (err) {
        logError('Remove from cart failed', err, `userId=${userId} productId=${productId}`);
        res.status(500).json({ error: 'Failed to remove from cart' });
    }
});

app.delete('/cart/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        await redisClient.del(cartKey(userId));
        log(`Cleared cart ${userId}`);
        res.json({ status: 'ok' });
    } catch (err) {
        logError('Clear cart failed', err, `userId=${userId}`);
        res.status(500).json({ error: 'Failed to clear cart' });
    }
});

process.on('unhandledRejection', (reason) => {
    logError('Unhandled promise rejection', reason);
});

process.on('uncaughtException', (err) => {
    logError('Uncaught exception', err);
});

async function connectRedisWithRetry() {
    for (let attempt = 1; attempt <= 30; attempt++) {
        try {
            await connectRedisOnce();
            return;
        } catch (err) {
            log(`Redis connection attempt ${attempt}/30 failed: ${err.message}`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
    logError('Redis unavailable after 30 attempts', new Error('giving up initial burst'), `host=${REDIS_HOST}`);
}

// Listen immediately so nginx/kube probes get a TCP response (503 until Redis is ready).
app.listen(PORT, () => {
    log(`Cart HTTP listening on port ${PORT} (redis=${REDIS_HOST}, catalogue=${CATALOGUE_URL})`);
    connectRedisWithRetry().catch((err) => logError('Redis background connect failed', err));
});

///