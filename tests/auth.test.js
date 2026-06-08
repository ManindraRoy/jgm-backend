const request = require('supertest');
const jwt = require('jsonwebtoken');

// Set environment variables for testing before requiring app
process.env.secret = 'test-secret-key-12345';
process.env.API_URL = '/api/v1';
process.env.NODE_ENV = 'test';

const { app } = require('../app');
const { Order } = require('../models/order');

// Mock mongoose models so they don't query a real database
jest.mock('../models/order');
jest.mock('../models/user');

describe('JGM Backend Production-Ready Security Tests', () => {
    let adminToken;
    let customerToken;
    let user456Token;

    beforeAll(() => {
        // Generate test tokens
        adminToken = jwt.sign(
            { userId: 'admin123', isAdmin: true, isSuperAdmin: true },
            process.env.secret,
            { expiresIn: '1h' }
        );
        customerToken = jwt.sign(
            { userId: 'customer123', isAdmin: false, isSuperAdmin: false },
            process.env.secret,
            { expiresIn: '1h' }
        );
        user456Token = jwt.sign(
            { userId: 'user456', isAdmin: false, isSuperAdmin: false },
            process.env.secret,
            { expiresIn: '1h' }
        );
    });

    afterAll(() => {
        jest.clearAllMocks();
    });

    describe('GET /api/v1/orders - Access Control', () => {
        it('should return 401 Unauthorized if no JWT cookie is provided', async () => {
            const res = await request(app).get('/api/v1/orders');
            expect(res.statusCode).toBe(401);
            expect(res.body.message).toBe('The user is not authorized.');
        });

        it('should return 401 Unauthorized if user is logged in but not an admin', async () => {
            const res = await request(app)
                .get('/api/v1/orders')
                .set('Cookie', [`jgm_token=${customerToken}`]);
            expect(res.statusCode).toBe(401);
        });

        it('should allow access if user is logged in as an admin', async () => {
            // Mock Mongoose Order find response
            Order.find = jest.fn().mockReturnValue({
                populate: jest.fn().mockReturnValue({
                    sort: jest.fn().mockReturnValue({
                        skip: jest.fn().mockReturnValue({
                            limit: jest.fn().mockResolvedValue([])
                        })
                    })
                })
            });
            Order.countDocuments = jest.fn().mockResolvedValue(0);

            const res = await request(app)
                .get('/api/v1/orders')
                .set('Cookie', [`jgm_token=${adminToken}`]);
            expect(res.statusCode).toBe(200);
            expect(res.body).toHaveProperty('orders');
        });
    });

    describe('GET /api/v1/orders/get/dashboard-stats - Access Control', () => {
        it('should return 401 Unauthorized if no JWT cookie is provided', async () => {
            const res = await request(app).get('/api/v1/orders/get/dashboard-stats');
            expect(res.statusCode).toBe(401);
        });

        it('should return 401 Unauthorized if user is logged in but not an admin', async () => {
            const res = await request(app)
                .get('/api/v1/orders/get/dashboard-stats')
                .set('Cookie', [`jgm_token=${customerToken}`]);
            expect(res.statusCode).toBe(401);
        });
    });

    describe('GET /api/v1/orders/get/userorders/:userid - Access Control', () => {
        it('should return 401 if unauthenticated', async () => {
            const res = await request(app).get('/api/v1/orders/get/userorders/user456');
            expect(res.statusCode).toBe(401);
        });

        it('should allow users to view their own orders', async () => {
            // Mock OrderRepository findByUserId
            const orderRepository = require('../repositories/OrderRepository');
            orderRepository.findByUserId = jest.fn().mockResolvedValue([{ id: 'order1' }]);

            const res = await request(app)
                .get('/api/v1/orders/get/userorders/user456')
                .set('Cookie', [`jgm_token=${user456Token}`]);
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual([{ id: 'order1' }]);
        });

        it('should block users from viewing other users orders', async () => {
            const res = await request(app)
                .get('/api/v1/orders/get/userorders/user456')
                .set('Cookie', [`jgm_token=${customerToken}`]);
            expect(res.statusCode).toBe(403);
            expect(res.body.message).toBe('Access denied. You can only view your own orders.');
        });

        it('should allow admins to view any users orders', async () => {
            const orderRepository = require('../repositories/OrderRepository');
            orderRepository.findByUserId = jest.fn().mockResolvedValue([{ id: 'order1' }]);

            const res = await request(app)
                .get('/api/v1/orders/get/userorders/user456')
                .set('Cookie', [`jgm_token=${adminToken}`]);
            expect(res.statusCode).toBe(200);
        });
    });

    describe('POST /api/v1/orders - Access Control', () => {
        it('should return 401 if unauthenticated', async () => {
            const res = await request(app).post('/api/v1/orders').send({});
            expect(res.statusCode).toBe(401);
        });

        it('should NOT return 401 revoked token for authenticated customer', async () => {
            const res = await request(app)
                .post('/api/v1/orders')
                .set('Cookie', [`jgm_token=${customerToken}`])
                .send({});
            // Should get past JWT checks and fail at Joi validation (400)
            expect(res.statusCode).toBe(400);
        });
    });

    describe('GET /api/v1/orders/:id - Access Control', () => {
        it('should return 401 if unauthenticated', async () => {
            const res = await request(app).get('/api/v1/orders/6a00afde6235f14af7a9c0f5');
            expect(res.statusCode).toBe(401);
        });

        it('should allow customer to view their own order details', async () => {
            const orderRepository = require('../repositories/OrderRepository');
            orderRepository.findById = jest.fn().mockResolvedValue({
                _id: '6a00afde6235f14af7a9c0f5',
                user: 'customer123',
                totalPrice: 100
            });

            const res = await request(app)
                .get('/api/v1/orders/6a00afde6235f14af7a9c0f5')
                .set('Cookie', [`jgm_token=${customerToken}`]);
            expect(res.statusCode).toBe(200);
            expect(res.body.user).toBe('customer123');
        });

        it('should block customer from viewing other users order details', async () => {
            const orderRepository = require('../repositories/OrderRepository');
            orderRepository.findById = jest.fn().mockResolvedValue({
                _id: '6a00afde6235f14af7a9c0f5',
                user: 'otherUser',
                totalPrice: 100
            });

            const res = await request(app)
                .get('/api/v1/orders/6a00afde6235f14af7a9c0f5')
                .set('Cookie', [`jgm_token=${customerToken}`]);
            expect(res.statusCode).toBe(403);
            expect(res.body.message).toBe('Access denied. You can only view your own orders.');
        });
    });
});
