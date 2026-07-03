import { createMiddleware } from 'hono/factory';
import type { Env } from '../types';

export const errorHandler = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  try {
    await next();
  } catch (err: any) {
    const status = err.statusCode || err.status || 500;
    const message = err.message || 'Internal server error';
    console.error(`[Error] ${c.req.method} ${c.req.path}: ${message}`);
    return c.json({ error: { code: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR', message } }, status);
  }
});
