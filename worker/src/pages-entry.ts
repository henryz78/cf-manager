import { handle } from 'hono/cloudflare-pages';
import { app } from './index';

export const onRequest = handle(app);
