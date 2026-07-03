import { Router, Request, Response, NextFunction } from 'express';
import { selectBestAccount, getAccountsByPriority, clearCache } from '../services/accountRouter';
import { getAvailableModels } from '../services/aiService';
import { getAuthHeaders } from '../services/cfFactory';
import { createAuditLog } from '../models/auditLog';
import { setQuota } from '../models/quotaUsage';
import { proxyFetch } from '../services/proxyService';

const router = Router();

function isNeuronLimitError(text: string): boolean {
  return text.includes('4006') || text.includes('daily free allocation') || text.includes('neuron limit');
}

router.get('/models', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await selectBestAccount('ai_neurons');
    const models = await getAvailableModels(account);
    const data = models.map((m: any) => ({
      id: m.name || m.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'cloudflare',
    }));
    res.json({ object: 'list', data });
  } catch (err) { next(err); }
});

router.post('/chat/completions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accounts = await getAccountsByPriority('ai_neurons');
    if (accounts.length === 0) {
      res.status(503).json({
        error: { message: 'No active accounts available', type: 'service_error', code: 'NO_ACCOUNTS' },
      });
      return;
    }

    const isStream = req.body.stream === true;
    let lastError = '';

    for (const account of accounts) {
      if (!account.account_id) continue;

      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/v1/chat/completions`;
      const headers = { 'Content-Type': 'application/json', ...getAuthHeaders(account) };

      const cfResp = await proxyFetch(cfUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(req.body),
      });

      if (!cfResp.ok) {
        const errorText = await cfResp.text();

        if (isNeuronLimitError(errorText)) {
          console.log(`[AI] Account ${account.name} neuron limit hit (4006)`);
          setQuota(account.id, 'ai_neurons', 10000);
          clearCache();
          createAuditLog(account.id, 'ai_inference', req.body.model, '4006 neuron limit, switching', 'error');
          if (accounts.indexOf(account) < accounts.length - 1) {
            lastError = errorText;
            continue;
          }
        }

        res.status(cfResp.status).json({
          error: { message: errorText, type: 'upstream_error', code: cfResp.status },
        });
        return;
      }

      if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        if (cfResp.body) {
          const body = cfResp.body as any;
          try {
            if (typeof body.getReader === 'function') {
              const reader = body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(Buffer.from(value));
              }
            } else if (typeof body.pipe === 'function') {
              await new Promise<void>((resolve, reject) => {
                body.pipe(res, { end: false });
                body.on('end', resolve);
                body.on('error', reject);
              });
            }
          } catch { /* client disconnected */ }
        }
        res.end();
        createAuditLog(account.id, 'ai_inference', req.body.model, 'stream via /v1', 'success');
      } else {
        const data = await cfResp.json() as any;
        res.json(data);
        createAuditLog(account.id, 'ai_inference', req.body.model,
          `tokens: ${data?.usage?.total_tokens || '?'}`, 'success');
      }
      return;
    }

    res.status(429).json({
      error: {
        message: 'All accounts have reached daily neuron limit',
        type: 'quota_exceeded',
        code: 'ALL_ACCOUNTS_EXHAUSTED',
      },
    });
  } catch (err) { next(err); }
});

export default router;
