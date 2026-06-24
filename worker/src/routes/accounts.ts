import { Hono } from 'hono';
import type { Env } from '../types';
import { getAllAccounts, getAccountById, createAccount, updateAccount, deleteAccount, addAuditLog } from '../db/models';
import { encrypt, decrypt } from '../services/encryption';
import { cfFetch } from '../services/cfApi';
import { getQuotaSummary } from '../services/quotaTracker';

const app = new Hono<{ Bindings: Env }>();

function isDemoAccount(id: number, demoIds: string | undefined): boolean {
  if (!demoIds) return false;
  return demoIds.split(',').map(s => parseInt(s.trim(), 10)).includes(id);
}

app.get('/', async (c) => {
  const db = c.env.DB;
  const demoIds = c.env.DEMO_ACCOUNT_IDS;
  const rawAccounts = await getAllAccounts(db);
  const accounts = [];
  for (const a of rawAccounts) {
    let api_token = null;
    let api_key = null;
    try {
      if (a.api_token) {
        api_token = await decrypt(a.api_token, c.env.ENCRYPTION_KEY);
      }
      if (a.api_key) {
        api_key = await decrypt(a.api_key, c.env.ENCRYPTION_KEY);
      }
    } catch (e) {
      console.error(`[Account] Decrypt failed for account ${a.name || a.id}: ${e}`);
    }
    accounts.push({
      ...a,
      api_token,
      api_key,
      is_demo: isDemoAccount(a.id, demoIds),
    });
  }
  const quota = await getQuotaSummary(db, c.env.ENCRYPTION_KEY);
  return c.json({ accounts, quota });
});

async function verifyCloudflareCredentials(auth_type: string, credentials: { api_token?: string; api_key?: string; email?: string }): Promise<void> {
  const CF_BASE = 'https://api.cloudflare.com/client/v4';
  let headers: Record<string, string>;
  let verifyUrl: string;

  if (auth_type === 'token') {
    headers = { Authorization: `Bearer ${credentials.api_token}` };
    verifyUrl = `${CF_BASE}/user/tokens/verify`;
  } else {
    headers = { 'X-Auth-Email': credentials.email || '', 'X-Auth-Key': credentials.api_key || '' };
    verifyUrl = `${CF_BASE}/user`;
  }

  const verifyRes = await fetch(verifyUrl, { headers });
  if (!verifyRes.ok) {
    const body = await verifyRes.text();
    throw new Error(`Cloudflare API 凭证验证失败 (${verifyRes.status}): ${body}`);
  }
}

app.post('/', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json();
  const { name, auth_type, api_token, api_key, email, enabled_features } = body;

  if (!name || !auth_type) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name and auth_type are required' } }, 400);
  if (auth_type !== 'token' && auth_type !== 'global_key') return c.json({ error: { code: 'VALIDATION_ERROR', message: 'auth_type must be "token" or "global_key"' } }, 400);
  if (auth_type === 'token' && !api_token) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'api_token is required for token auth' } }, 400);
  if (auth_type === 'global_key' && (!api_key || !email)) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'api_key and email are required for global_key auth' } }, 400);

  // Verify credentials before saving
  try {
    await verifyCloudflareCredentials(auth_type, { api_token, api_key, email });
  } catch (e: any) {
    return c.json({ error: { code: 'CREDENTIAL_INVALID', message: e.message || e } }, 400);
  }

  const input: any = { name, auth_type, account_id: null, enabled_features };
  if (auth_type === 'token') {
    input.api_token = await encrypt(api_token, c.env.ENCRYPTION_KEY);
  } else {
    input.api_key = await encrypt(api_key, c.env.ENCRYPTION_KEY);
    input.email = email;
  }

  const id = await createAccount(db, input);

  // Auto-fetch account ID
  try {
    const saved = await getAccountById(db, id);
    if (saved) {
      const data = await cfFetch<{ result: any[] }>(saved, '/accounts?page=1&per_page=10', c.env.ENCRYPTION_KEY);
      if (data.result?.length > 0) {
        await updateAccount(db, id, { account_id: data.result[0].id });
        input.account_id = data.result[0].id;
        console.log(`[Account] Auto-fetched account_id=${data.result[0].id} for "${name}"`);
      }
      await updateAccount(db, id, { is_active: 1 });
    }
  } catch (e) {
    console.warn(`[Account] Failed to auto-fetch account_id for "${name}": ${e}`);
  }

  await addAuditLog(db, { account_id: id, action: 'create_account', target: name, detail: `auth_type=${auth_type}`, status: 'success' });
  return c.json({ id, ...input, api_token: '***', api_key: '***' }, 201);
});

app.put('/:id', async (c) => {
  const db = c.env.DB;
  const id = parseInt(c.req.param('id'), 10);
  if (isDemoAccount(id, c.env.DEMO_ACCOUNT_IDS)) {
    return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可修改' } }, 403);
  }
  const account = await getAccountById(db, id);
  if (!account) return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);

  const body = await c.req.json();
  const { name, auth_type, api_token, api_key, email } = body;

  if (!name || !auth_type) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name and auth_type are required' } }, 400);
  if (auth_type !== 'token' && auth_type !== 'global_key') return c.json({ error: { code: 'VALIDATION_ERROR', message: 'auth_type must be "token" or "global_key"' } }, 400);
  if (auth_type === 'token' && !api_token) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'api_token is required' } }, 400);
  if (auth_type === 'global_key' && (!api_key || !email)) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'api_key and email are required' } }, 400);

  // Verify credentials
  try {
    await verifyCloudflareCredentials(auth_type, { api_token, api_key, email });
  } catch (e: any) {
    return c.json({ error: { code: 'CREDENTIAL_INVALID', message: e.message || e } }, 400);
  }

  const input: any = { name, auth_type };
  if (auth_type === 'token') {
    input.api_token = await encrypt(api_token, c.env.ENCRYPTION_KEY);
    input.api_key = null;
    input.email = null;
  } else {
    input.api_key = await encrypt(api_key, c.env.ENCRYPTION_KEY);
    input.email = email;
    input.api_token = null;
  }

  // Auto-fetch account_id on update
  let fetchedAccountId: string | null = null;
  try {
    const tempAccount = { ...account, ...input };
    const data = await cfFetch<{ result: any[] }>(tempAccount, '/accounts?page=1&per_page=10', c.env.ENCRYPTION_KEY);
    if (data.result?.length > 0) {
      fetchedAccountId = data.result[0].id;
      console.log(`[Account] Auto-fetched account_id=${data.result[0].id} for "${name}" during update`);
    }
  } catch (e) {
    console.warn(`[Account] Failed to auto-fetch account_id during update: ${e}`);
  }

  input.account_id = fetchedAccountId || account.account_id || null;

  await updateAccount(db, id, input);
  await addAuditLog(db, { account_id: id, action: 'update_account', target: name, detail: `auth_type=${auth_type}`, status: 'success' });
  return c.json({ success: true });
});

app.patch('/:id/features', async (c) => {
  const db = c.env.DB;
  const id = parseInt(c.req.param('id'), 10);
  if (isDemoAccount(id, c.env.DEMO_ACCOUNT_IDS)) {
    return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可修改' } }, 403);
  }
  const account = await getAccountById(db, id);
  if (!account) return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);

  const { enabled_features } = await c.req.json();
  if (typeof enabled_features !== 'string') return c.json({ error: { code: 'VALIDATION_ERROR', message: 'enabled_features is required' } }, 400);

  await updateAccount(db, id, { enabled_features });
  await addAuditLog(db, { account_id: id, action: 'update_features', target: account.name, detail: enabled_features, status: 'success' });
  return c.json({ success: true });
});

app.delete('/:id', async (c) => {
  const db = c.env.DB;
  const id = parseInt(c.req.param('id'), 10);
  if (isDemoAccount(id, c.env.DEMO_ACCOUNT_IDS)) {
    return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可删除' } }, 403);
  }
  const account = await getAccountById(db, id);
  if (!account) return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);

  await addAuditLog(db, { account_id: id, action: 'delete_account', target: account.name, status: 'success' });
  await deleteAccount(db, id);
  return c.json({ success: true });
});

app.post('/:id/test', async (c) => {
  const db = c.env.DB;
  const id = parseInt(c.req.param('id'), 10);
  const account = await getAccountById(db, id);
  if (!account) return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);

  const user = await cfFetch(account, '/user', c.env.ENCRYPTION_KEY);

  if (!account.account_id) {
    try {
      const data = await cfFetch<{ result: any[] }>(account, '/accounts?page=1&per_page=10', c.env.ENCRYPTION_KEY);
      if (data.result?.length > 0) {
        await updateAccount(db, id, { account_id: data.result[0].id });
      }
    } catch (e) {
      console.warn(`[Account] Failed to fetch account list: ${e}`);
    }
  }

  await updateAccount(db, id, { is_active: 1 });
  return c.json({ user });
});

export default app;
