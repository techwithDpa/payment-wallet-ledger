import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { toJson } from './json.js';
import { adminRoutes } from './routes/admin.js';
import { healthRoutes } from './routes/health.js';
import { transferRoutes } from './routes/transfers.js';
import { userRoutes } from './routes/users.js';
import { walletRoutes } from './routes/wallets.js';

// Builds the app without starting a server, so tests can call it directly.
export function buildApp() {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
    genReqId: () => randomUUID(), // becomes request_id in every error response
  });

  // Money and ids are bigint; send them as strings so no precision is lost.
  app.setReplySerializer((payload) => toJson(payload));

  // One error shape everywhere: {"code": "...", "message": "...", "request_id": "..."}
  app.setErrorHandler((error, req, reply) => {
    const err = error as { statusCode?: number; code?: string; message?: string };
    const status = err.statusCode ?? 500;
    if (status === 500) req.log.error(error);
    reply.status(status).send({
      code: err.code ?? (status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'),
      message: status === 500 ? 'Something went wrong' : (err.message ?? 'Bad request'),
      request_id: req.id,
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ code: 'NOT_FOUND', message: `${req.method} ${req.url} not found`, request_id: req.id });
  });

  app.register(healthRoutes);
  app.register(userRoutes);
  app.register(walletRoutes);
  app.register(transferRoutes);
  app.register(adminRoutes);
  return app;
}
