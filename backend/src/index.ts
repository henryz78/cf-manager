import express from 'express';
import cors from 'cors';
import { config } from './config';
import { initDb } from './db';
import { authMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { responseWrapper } from './middleware/responseWrapper';
import accountsRouter from './routes/accounts';
import dnsRouter from './routes/dns';
import workersRouter from './routes/workers';
import aiRouter from './routes/ai';
import browserRenderRouter from './routes/browserRender';
import settingsRouter from './routes/settings';
import storageRouter from './routes/storage';
import tasksRouter from './routes/tasks';
import openaiRouter from './routes/openai';
import externalBrowserRenderRouter from './routes/externalBrowserRender';
import { getQuotaSummary, syncUsageFromCloudflare } from './services/quotaTracker';
import { getRecentLogs } from './models/auditLog';
import { initScheduler } from './services/taskScheduler';
import { initBrowserRateLimiter } from './services/browserRateLimiter';
import { v1RequestLogger } from './middleware/v1Logger';
import { apiRequestLogger } from './middleware/apiLogger';
import { appLogger } from './services/logger';

const app = express();

app.use(cors());
app.use(express.json({ limit: '100mb' }));

// Health check — before auth so Docker healthcheck works without API_SECRET
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use(authMiddleware);

app.use('/api', apiRequestLogger);
app.use('/api', responseWrapper);

app.use('/api/accounts', accountsRouter);
app.use('/api/dns', dnsRouter);
app.use('/api/workers', workersRouter);
app.use('/api/ai', aiRouter);
app.use('/api/browser-render', browserRenderRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/storage', storageRouter);
app.use('/api/tasks', tasksRouter);

// External APIs — no responseWrapper, keep original format
app.use('/v1', v1RequestLogger);
app.use('/v1', openaiRouter);
app.use('/v1/browser', externalBrowserRenderRouter);

app.get('/api/quota', async (_req, res, next) => {
  try {
    await syncUsageFromCloudflare();
    res.json(getQuotaSummary());
  } catch (err) { next(err); }
});

app.get('/api/audit-log', (_req, res, next) => {
  try {
    res.json(getRecentLogs(20));
  } catch (err) { next(err); }
});

app.use(errorHandler);

async function start() {
  initDb();
  initScheduler();
  initBrowserRateLimiter();
  app.listen(config.port, () => {
    appLogger.info(`Server running on port ${config.port}`);
  });
}

process.on('uncaughtException', (err) => {
  appLogger.error(`[UNCAUGHT] ${err}`);
});
process.on('unhandledRejection', (err) => {
  appLogger.error(`[UNHANDLED_REJECTION] ${err}`);
});

start().catch((err) => appLogger.error(`[STARTUP] ${err}`));
