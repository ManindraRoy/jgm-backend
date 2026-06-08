const request = require('supertest');
const crypto = require('crypto');
const axios = require('axios');
const orderRepository = require('../repositories/OrderRepository');

// Setup environment variables before requiring the app
process.env.secret = 'test-secret-key-12345';
process.env.API_URL = '/api/v1';
process.env.NODE_ENV = 'test';
process.env.PHONEPE_MERCHANT_ID = 'TEST_CLIENT_ID';
process.env.PHONEPE_SALT_KEY = 'TEST_CLIENT_SECRET';
process.env.PHONEPE_SALT_INDEX = '1';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.PHONEPE_WEBHOOK_USERNAME = 'webhook_user';
process.env.PHONEPE_WEBHOOK_PASSWORD = 'webhook_password';

const { app } = require('../app');

// Mock external integrations
jest.mock('axios');
jest.mock('../repositories/OrderRepository');

describe('PhonePe Payments Route Integration Tests (V2 API)', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        // Setup default mock handlers for Axios POST and GET requests
        axios.post.mockImplementation((url, data) => {
            if (url.includes('/v1/oauth/token')) {
                return Promise.resolve({
                    data: {
                        access_token: 'mock-access-token-12345',
                        expires_at: Math.floor(Date.now() / 1000) + 3600,
                        token_type: 'O-Bearer'
                    }
                });
            }
            if (url.includes('/checkout/v2/pay')) {
                return Promise.resolve({
                    data: {
                        redirectUrl: 'https://phonepe.com/mock-redirect',
                        orderId: 'OMO2403282020198641071317'
                    }
                });
            }
            return Promise.reject(new Error('Unknown POST endpoint: ' + url));
        });

        axios.get.mockImplementation((url) => {
            if (url.includes('/status')) {
                return Promise.resolve({
                    data: {
                        orderId: 'OMO2403282020198641071317',
                        state: 'COMPLETED',
                        amount: 10000 // default 100 Rs in paise
                    }
                });
            }
            return Promise.reject(new Error('Unknown GET endpoint: ' + url));
        });
    });

    describe('POST /api/v1/payments/checkout/:orderId', () => {
        it('should return 404 if order is not found', async () => {
            orderRepository.findById.mockResolvedValue(null);

            const res = await request(app).post('/api/v1/payments/checkout/order123');
            expect(res.statusCode).toBe(404);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toBe('Order not found');
        });

        it('should return 500 if the order has already been paid for', async () => {
            orderRepository.findById.mockResolvedValue({
                _id: 'order123',
                paymentStatus: 'Paid',
                totalPrice: 100
            });

            const res = await request(app).post('/api/v1/payments/checkout/order123');
            expect(res.statusCode).toBe(500);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('already been paid for');
        });

        it('should initiate payment, retrieve OAuth token, update transactionId in DB, and return paymentUrl', async () => {
            const mockOrder = {
                _id: '60c72b2f9b1d8b2a3c9d4e5f',
                paymentStatus: 'Pending',
                totalPrice: 150.50,
                user: 'user789'
            };
            orderRepository.findById.mockResolvedValue(mockOrder);
            orderRepository.update.mockResolvedValue({ ...mockOrder, transactionId: 'JGM-9d4e5f-123456789-abcdef' });

            const res = await request(app).post('/api/v1/payments/checkout/60c72b2f9b1d8b2a3c9d4e5f');
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.paymentUrl).toBe('https://phonepe.com/mock-redirect');

            expect(orderRepository.update).toHaveBeenCalledTimes(1);
            expect(orderRepository.update.mock.calls[0][1].transactionId).toMatch(/^JGM-\w+-\d+-\w+$/);

            // Access token retrieved, then payment created
            expect(axios.post).toHaveBeenCalledTimes(2);
            
            const oauthCallUrl = axios.post.mock.calls[0][0];
            const payCallUrl = axios.post.mock.calls[1][0];
            const payHeaders = axios.post.mock.calls[1][2].headers;

            expect(oauthCallUrl).toContain('/v1/oauth/token');
            expect(payCallUrl).toContain('/checkout/v2/pay');
            expect(payHeaders['Authorization']).toBe('O-Bearer mock-access-token-12345');
        });
    });

    describe('GET /api/v1/payments/checkout/:orderId', () => {
        it('should redirect to the payment URL on success', async () => {
            const mockOrder = {
                _id: '60c72b2f9b1d8b2a3c9d4e5f',
                paymentStatus: 'Pending',
                totalPrice: 100,
                user: 'user789'
            };
            orderRepository.findById.mockResolvedValue(mockOrder);

            const res = await request(app).get('/api/v1/payments/checkout/60c72b2f9b1d8b2a3c9d4e5f');
            expect(res.statusCode).toBe(302);
            expect(res.headers.location).toBe('https://phonepe.com/mock-redirect');
        });
    });

    describe('POST /api/v1/payments/webhook', () => {
        const getAuthorizationHeader = (username, password) => {
            const credentials = `${username}:${password}`;
            return crypto.createHash("sha256").update(credentials).digest("hex");
        };

        it('should return 401 for missing authorization header', async () => {
            const res = await request(app)
                .post('/api/v1/payments/webhook')
                .send({ event: 'checkout.order.completed', payload: {} });
            expect(res.statusCode).toBe(401);
            expect(res.text).toBe('Missing payload authentication credentials');
        });

        it('should return 401 for invalid authorization hash credentials', async () => {
            const res = await request(app)
                .post('/api/v1/payments/webhook')
                .set('Authorization', 'invalid-hash-value')
                .send({ event: 'checkout.order.completed', payload: {} });
            expect(res.statusCode).toBe(401);
            expect(res.text).toBe('Invalid Webhook Authentication Signature');
        });

        it('should return 400 for missing payload or event parameters', async () => {
            const authHeader = getAuthorizationHeader('webhook_user', 'webhook_password');
            const res = await request(app)
                .post('/api/v1/payments/webhook')
                .set('Authorization', authHeader)
                .send({ event: 'checkout.order.completed' });
            expect(res.statusCode).toBe(400);
            expect(res.text).toBe('Missing payload requirements');
        });

        it('should return 400 if merchantOrderId is missing in payload object', async () => {
            const authHeader = getAuthorizationHeader('webhook_user', 'webhook_password');
            const res = await request(app)
                .post('/api/v1/payments/webhook')
                .set('Authorization', `SHA256(${authHeader})`) // verify wrapper parsing works too
                .send({ event: 'checkout.order.completed', payload: { amount: 10000 } });
            expect(res.statusCode).toBe(400);
            expect(res.text).toBe('Missing Identification parameter context');
        });

        it('should return 404 if order associated with merchantOrderId is not found', async () => {
            const authHeader = getAuthorizationHeader('webhook_user', 'webhook_password');
            orderRepository.findByTransactionId.mockResolvedValue(null);

            const res = await request(app)
                .post('/api/v1/payments/webhook')
                .set('Authorization', authHeader)
                .send({ event: 'checkout.order.completed', payload: { merchantOrderId: 'JGM-nonexistent', amount: 10000 } });

            expect(res.statusCode).toBe(404);
            expect(res.text).toBe('Order reference pointer mismatch');
        });

        it('should return 200 OK immediately if order is already Paid', async () => {
            const authHeader = getAuthorizationHeader('webhook_user', 'webhook_password');
            orderRepository.findByTransactionId.mockResolvedValue({
                _id: 'order123',
                paymentStatus: 'Paid',
                status: 'Processing'
            });

            const res = await request(app)
                .post('/api/v1/payments/webhook')
                .set('Authorization', authHeader)
                .send({ event: 'checkout.order.completed', payload: { merchantOrderId: 'JGM-9d4e5f-12345', amount: 10000 } });

            expect(res.statusCode).toBe(200);
            expect(res.text).toBe('OK');
            expect(orderRepository.markAsPaidIfPending).not.toHaveBeenCalled();
        });

        it('should mark order as Paid on checkout.order.completed payload state COMPLETED', async () => {
            const authHeader = getAuthorizationHeader('webhook_user', 'webhook_password');
            orderRepository.findByTransactionId.mockResolvedValue({
                _id: 'order123',
                paymentStatus: 'Pending',
                totalPrice: 100, // Rs 100
                transactionId: 'JGM-9d4e5f-12345'
            });
            orderRepository.markAsPaidIfPending.mockResolvedValue(true);

            const res = await request(app)
                .post('/api/v1/payments/webhook')
                .set('Authorization', authHeader)
                .send({
                    event: 'checkout.order.completed',
                    payload: {
                        merchantOrderId: 'JGM-9d4e5f-12345',
                        state: 'COMPLETED',
                        amount: 10000, // Rs 100 in paise
                        orderId: 'OMO2403282020198641071317'
                    }
                });

            expect(res.statusCode).toBe(200);
            expect(res.text).toBe('OK');
            expect(orderRepository.markAsPaidIfPending).toHaveBeenCalledWith('order123', {
                paymentStatus: 'Paid',
                status: 'Processing',
                gatewayTransactionId: 'OMO2403282020198641071317'
            });
        });

        it('should atomically cancel and restore stock if webhook payload indicates failure', async () => {
            const authHeader = getAuthorizationHeader('webhook_user', 'webhook_password');
            orderRepository.findByTransactionId.mockResolvedValue({
                _id: 'order123',
                paymentStatus: 'Pending',
                totalPrice: 100,
                status: 'Pending'
            });

            const res = await request(app)
                .post('/api/v1/payments/webhook')
                .set('Authorization', authHeader)
                .send({
                    event: 'checkout.order.failed',
                    payload: {
                        merchantOrderId: 'JGM-9d4e5f-12345',
                        state: 'FAILED',
                        amount: 10000,
                        orderId: 'OMO2403282020198641071317'
                    }
                });

            expect(res.statusCode).toBe(200);
            expect(res.text).toBe('OK');
            expect(orderRepository.cancelAndRestoreStock).toHaveBeenCalledWith('order123');
        });
    });

    describe('GET /api/v1/payments/check-status/:orderId', () => {
        it('should return 404 if order is not found', async () => {
            orderRepository.findById.mockResolvedValue(null);

            const res = await request(app).get('/api/v1/payments/check-status/order123');
            expect(res.statusCode).toBe(404);
            expect(res.body.message).toBe('Order not found');
        });

        it('should return immediate state if order is already processed (Paid)', async () => {
            orderRepository.findById.mockResolvedValue({
                _id: 'order123',
                paymentStatus: 'Paid',
                status: 'Processing'
            });

            const res = await request(app).get('/api/v1/payments/check-status/order123');
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ paymentStatus: 'Paid', orderStatus: 'Processing' });
            expect(axios.get).not.toHaveBeenCalled();
        });

        it('should cancel order and restore stock atomically if order has no transactionId', async () => {
            orderRepository.findById.mockResolvedValue({
                _id: 'order123',
                paymentStatus: 'Pending',
                status: 'Pending',
                transactionId: null
            });

            const res = await request(app).get('/api/v1/payments/check-status/order123');
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ paymentStatus: 'Failed', orderStatus: 'Cancelled' });
            expect(orderRepository.cancelAndRestoreStock).toHaveBeenCalledWith('order123');
        });

        it('should catch Axios exceptions gracefully and return Pending status without canceling the order', async () => {
            orderRepository.findById.mockResolvedValue({
                _id: 'order123',
                paymentStatus: 'Pending',
                totalPrice: 200,
                status: 'Pending',
                transactionId: 'JGM-9d4e5f-12345'
            });

            axios.get.mockRejectedValue(new Error('Connection timed out'));

            const res = await request(app).get('/api/v1/payments/check-status/order123');
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({
                paymentStatus: 'Pending',
                orderStatus: 'Pending',
                note: 'Gateway synchronizing state.'
            });

            expect(orderRepository.cancelAndRestoreStock).not.toHaveBeenCalled();
            expect(orderRepository.markAsPaidIfPending).not.toHaveBeenCalled();
        });

        it('should return Paid status if PhonePe responds with COMPLETED', async () => {
            orderRepository.findById.mockResolvedValue({
                _id: 'order123',
                paymentStatus: 'Pending',
                totalPrice: 100,
                status: 'Pending',
                transactionId: 'JGM-9d4e5f-12345'
            });
            
            axios.get.mockResolvedValue({
                data: {
                    state: 'COMPLETED',
                    amount: 10000,
                    orderId: 'OMO2403282020198641071317'
                }
            });

            orderRepository.markAsPaidIfPending.mockResolvedValue(true);

            const res = await request(app).get('/api/v1/payments/check-status/order123');
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ paymentStatus: 'Paid', orderStatus: 'Processing' });

            expect(axios.get).toHaveBeenCalledTimes(1);
            expect(axios.get.mock.calls[0][0]).toContain('/checkout/v2/order/JGM-9d4e5f-12345/status');
            expect(axios.get.mock.calls[0][1].headers['Authorization']).toBe('O-Bearer mock-access-token-12345');

            expect(orderRepository.markAsPaidIfPending).toHaveBeenCalledWith('order123', {
                paymentStatus: 'Paid',
                status: 'Processing',
                gatewayTransactionId: 'OMO2403282020198641071317'
            });
        });

        it('should return Pending status if PhonePe responds with PENDING', async () => {
            orderRepository.findById.mockResolvedValue({
                _id: 'order123',
                paymentStatus: 'Pending',
                totalPrice: 100,
                status: 'Pending',
                transactionId: 'JGM-9d4e5f-12345'
            });

            axios.get.mockResolvedValue({
                data: {
                    state: 'PENDING'
                }
            });

            const res = await request(app).get('/api/v1/payments/check-status/order123');
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ paymentStatus: 'Pending', orderStatus: 'Pending' });
            expect(orderRepository.markAsPaidIfPending).not.toHaveBeenCalled();
        });

        it('should restore stock atomically and set Failed/Cancelled if PhonePe responds with failure code', async () => {
            orderRepository.findById.mockResolvedValue({
                _id: 'order123',
                paymentStatus: 'Pending',
                totalPrice: 100,
                status: 'Pending',
                transactionId: 'JGM-9d4e5f-12345'
            });

            axios.get.mockResolvedValue({
                data: {
                    state: 'FAILED'
                }
            });

            const res = await request(app).get('/api/v1/payments/check-status/order123');
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ paymentStatus: 'Failed', orderStatus: 'Cancelled' });

            expect(orderRepository.cancelAndRestoreStock).toHaveBeenCalledWith('order123');
        });

        it('should use correct production endpoints and caching when PHONEPE_ENV=PROD', async () => {
            const originalEnv = process.env.PHONEPE_ENV;
            process.env.PHONEPE_ENV = 'PROD';
            
            // Clear require cache for the payments route to force re-evaluation of isProd
            delete require.cache[require.resolve('../routes/payments')];
            const prodPaymentsRouter = require('../routes/payments');
            
            if (prodPaymentsRouter.clearTokenCache) {
                prodPaymentsRouter.clearTokenCache();
            }
            
            const express = require('express');
            const prodApp = express();
            prodApp.use(express.json());
            prodApp.use('/api/v1/payments', prodPaymentsRouter);
            
            const mockOrder = {
                _id: '60c72b2f9b1d8b2a3c9d4e5f',
                paymentStatus: 'Pending',
                totalPrice: 150.50,
                user: 'user789',
                transactionId: 'JGM-9d4e5f-12345'
            };
            orderRepository.findById.mockResolvedValue(mockOrder);
            orderRepository.update.mockResolvedValue({ ...mockOrder, transactionId: 'JGM-9d4e5f-12345' });

            axios.post.mockClear();
            axios.get.mockClear();

            // 1. Checkout test
            const checkoutRes = await request(prodApp).post('/api/v1/payments/checkout/60c72b2f9b1d8b2a3c9d4e5f');
            expect(checkoutRes.statusCode).toBe(200);
            
            expect(axios.post).toHaveBeenCalledTimes(2);
            // First call retrieves token
            expect(axios.post.mock.calls[0][0]).toBe('https://api.phonepe.com/apis/identity-manager/v1/oauth/token');
            // Second call sends payment request
            expect(axios.post.mock.calls[1][0]).toBe('https://api.phonepe.com/apis/pg/checkout/v2/pay');
            expect(axios.post.mock.calls[1][2].headers['Authorization']).toBe('O-Bearer mock-access-token-12345');

            // 2. Status check test (should use cached token, so only 1 axios call total)
            axios.post.mockClear();
            
            axios.get.mockResolvedValue({
                data: {
                    state: 'COMPLETED',
                    amount: 15050,
                    orderId: 'OMO2403282020198641071317'
                }
            });

            const statusRes = await request(prodApp).get('/api/v1/payments/check-status/60c72b2f9b1d8b2a3c9d4e5f');
            expect(statusRes.statusCode).toBe(200);
            
            // Verifies OAuth token caching: axios.post was NOT called again to fetch token
            expect(axios.post).toHaveBeenCalledTimes(0);

            expect(axios.get).toHaveBeenCalledTimes(1);
            expect(axios.get.mock.calls[0][0]).toBe('https://api.phonepe.com/apis/pg/checkout/v2/order/JGM-9d4e5f-12345/status');
            expect(axios.get.mock.calls[0][1].headers['Authorization']).toBe('O-Bearer mock-access-token-12345');

            process.env.PHONEPE_ENV = originalEnv;
            delete require.cache[require.resolve('../routes/payments')];
        });
    });
});
