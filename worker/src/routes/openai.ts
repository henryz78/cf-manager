import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { Env } from '../types';
import { getActiveAccountsByFeature, setQuota, addAuditLog } from '../db/models';
import { getAuthHeaders, cfFetchRaw } from '../services/cfApi';
import { getAiUsageToday } from '../services/quotaTracker';

const AI_NEURON_LIMIT = 10000;

function isNeuronLimitError(text: string): boolean {
  return text.includes('4006') || text.includes('daily free allocation') || text.includes('neuron limit');
}

const app = new Hono<{ Bindings: Env }>();

async function getAccountsByPriority(db: D1Database, encryptionKey: string) {
  const accounts = await getActiveAccountsByFeature(db, 'ai');
  const results = await Promise.all(accounts.map(async (account) => {
    try {
      const usage = await getAiUsageToday(account, encryptionKey);
      return { account, remaining: AI_NEURON_LIMIT - usage.totalNeurons };
    } catch { return { account, remaining: 0 }; }
  }));
  return results.sort((a, b) => b.remaining - a.remaining).map(r => r.account);
}

app.get('/models', async (c) => {
  const accounts = await getAccountsByPriority(c.env.DB, c.env.ENCRYPTION_KEY);
  if (accounts.length === 0) return c.json({ object: 'list', data: [] });
  const account = accounts[0];

  const resp = await cfFetchRaw(account, `/accounts/${account.account_id}/ai/models/search`, c.env.ENCRYPTION_KEY);
  const json = await resp.json() as any;
  const data = (json.result || []).map((m: any) => ({
    id: m.name || m.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'cloudflare',
  }));
  return c.json({ object: 'list', data });
});

app.post('/chat/completions', async (c) => {
  const accounts = await getAccountsByPriority(c.env.DB, c.env.ENCRYPTION_KEY);
  if (accounts.length === 0) return c.json({ error: { message: 'No active accounts', type: 'service_error', code: 'NO_ACCOUNTS' } }, 503);

  const body = await c.req.json();
  const isStream = body.stream === true;

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    if (!account.account_id) continue;

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/v1/chat/completions`;
    const headers = await getAuthHeaders(account, c.env.ENCRYPTION_KEY);

    const cfResp = await fetch(cfUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    if (!cfResp.ok) {
      const errorText = await cfResp.text();
      if (isNeuronLimitError(errorText)) {
        console.warn(`[AI] Account ${account.name} neuron limit hit`);
        await setQuota(c.env.DB, account.id, 'ai_neurons', 10000);
        await addAuditLog(c.env.DB, { account_id: account.id, action: 'ai_inference', target: body.model, detail: '4006 switching', status: 'error' });
        if (i + 1 < accounts.length) continue;
      }
      return c.json({ error: { message: errorText, type: 'upstream_error', code: cfResp.status } }, cfResp.status as any);
    }

    if (isStream) {
      await addAuditLog(c.env.DB, { account_id: account.id, action: 'ai_inference', target: body.model, detail: 'stream /v1', status: 'success' });
      return stream(c, async (s) => {
        const reader = cfResp.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await s.write(decoder.decode(value, { stream: true }));
        }
      });
    }

    const data = await cfResp.json() as any;
    await addAuditLog(c.env.DB, { account_id: account.id, action: 'ai_inference', target: body.model, detail: `tokens: ${data?.usage?.total_tokens || '?'}`, status: 'success' });
    return c.json(data);
  }

  return c.json({ error: { message: 'All accounts exhausted', type: 'quota_exceeded', code: 'ALL_ACCOUNTS_EXHAUSTED' } }, 429);
});

export default app;
