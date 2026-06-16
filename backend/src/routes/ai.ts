import { Router, Request, Response, NextFunction } from 'express';
import { selectBestAccount, getAccountsByPriority, clearCache } from '../services/accountRouter';
import { getAccountById } from '../models/account';
import { getAvailableModels, runInferenceStream, getAiUsageToday } from '../services/aiService';
import { getActiveAccountsByFeature } from '../models/account';
import { setQuota } from '../models/quotaUsage';
import { appLogger } from '../services/logger';

const router = Router();

router.get('/models', async (req, res, next) => {
  try {
    const accountId = req.query.accountId ? Number(req.query.accountId) : undefined;
    const account = accountId ? getAccountById(accountId) : await selectBestAccount('ai_neurons');
    if (!account) {
      throw Object.assign(new Error(`Account ${accountId} not found`), { statusCode: 404 });
    }
    const taskFilter = req.query.task as string | undefined;
    const models = await getAvailableModels(account, taskFilter);
    res.json(models);
  } catch (err) { next(err); }
});

router.post('/inference', async (req, res, next) => {
  try {
    const { model, prompt, messages: historyMessages, accountId } = req.body;

    if (accountId) {
      const account = getAccountById(accountId);
      if (!account) {
        throw Object.assign(new Error(`Account ${accountId} not found`), { statusCode: 404 });
      }
      return startStream(account);
    }

    const accounts = await getAccountsByPriority('ai_neurons');
    if (accounts.length === 0) {
      throw Object.assign(new Error('No active accounts'), { statusCode: 503, code: 'NO_ACCOUNTS' });
    }

    async function startStream(account: any) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      await runInferenceStream(
        account, model, prompt, historyMessages,
        (chunk) => { res.write(`data: ${JSON.stringify({ type: 'content', chunk })}\n\n`); },
        (chunk) => { res.write(`data: ${JSON.stringify({ type: 'reasoning', chunk })}\n\n`); },
        () => { res.write('data: [DONE]\n\n'); res.end(); },
        (err) => { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); }
      );
    }

    function ensureSSEHeaders() {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
      }
    }

    async function tryWithFallback(idx: number): Promise<void> {
      const account = accounts[idx];
      return new Promise<void>((resolve) => {
        runInferenceStream(
          account, model, prompt, historyMessages,
          (chunk) => { ensureSSEHeaders(); res.write(`data: ${JSON.stringify({ type: 'content', chunk })}\n\n`); },
          (chunk) => { ensureSSEHeaders(); res.write(`data: ${JSON.stringify({ type: 'reasoning', chunk })}\n\n`); },
          () => { ensureSSEHeaders(); res.write('data: [DONE]\n\n'); res.end(); resolve(); },
          async (err) => {
            const is4006 = err.message.includes('4006') || err.message.includes('daily free allocation');
            if (is4006) {
              setQuota(account.id, 'ai_neurons', 10000);
              clearCache();
            }
            if (is4006 && idx + 1 < accounts.length) {
              appLogger.warn(`[AI] Account ${account.name} neuron limit (4006), switching...`);
              await tryWithFallback(idx + 1);
              resolve();
            } else {
              ensureSSEHeaders();
              res.write(`data: ${JSON.stringify({ error: is4006 ? 'ALL_ACCOUNTS_EXHAUSTED: 所有账户神经元已耗尽' : err.message })}\n\n`);
              res.end();
              resolve();
            }
          }
        );
      });
    }

    await tryWithFallback(0);
  } catch (err) { next(err); }
});

router.get('/usage', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const accounts = getActiveAccountsByFeature('ai');
    const results = await Promise.all(
      accounts.map(async (account) => {
        try {
          const usage = await getAiUsageToday(account);
          return { accountId: account.id, accountName: account.name, ...usage };
        } catch (err) {
          appLogger.error(`[AI Usage] Failed for account ${account.name}: ${err}`);
          return { accountId: account.id, accountName: account.name, totalNeurons: 0, models: [] };
        }
      })
    );
    res.json(results);
  } catch (err) { next(err); }
});

export default router;
