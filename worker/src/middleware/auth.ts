import { createMiddleware } from 'hono/factory';
import type { Env } from '../types';

export const authMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const secret = c.env.API_SECRET;
  if (!secret) return next();

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid authorization header' } }, 401);
  }
  if (authHeader.substring(7) !== secret) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Invalid API secret' } }, 403);
  }
  await next();
});
