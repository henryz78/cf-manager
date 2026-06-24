import { Router, Request, Response, NextFunction } from 'express';
import Cloudflare from 'cloudflare';
import { getAllAccounts, createAccount, deleteAccount, getAccountById, updateAccountStatus, updateAccountId, updateAccountFeatures, updateAccount, AccountInput } from '../models/account';
import { encrypt, decrypt } from '../services/encryptionService';
import { getCfClient } from '../services/cfFactory';
import { getQuotaSummary } from '../services/quotaTracker';
import { clearCache } from '../services/accountRouter';
import { appLogger } from '../services/logger';
import { createAuditLog } from '../models/auditLog';
import { config } from '../config';
import { getHttpAgent } from '../services/proxyService';

const router = Router();

function isDemoAccount(id: number): boolean {
  if (!config.demoAccountIds) return false;
  return config.demoAccountIds.split(',').map(s => parseInt(s.trim(), 10)).includes(id);
}

router.get('/', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const accounts = getAllAccounts().map(a => {
      let api_token = null;
      let api_key = null;
      try {
        if (a.api_token) {
          api_token = decrypt(a.api_token);
        }
        if (a.api_key) {
          api_key = decrypt(a.api_key);
        }
      } catch (e) {
        appLogger.error(`[Account] Decrypt failed for account ${a.name || a.id}: ${e}`);
      }
      return {
        ...a,
        api_token,
        api_key,
        is_demo: isDemoAccount(a.id),
      };
    });
    const quota = getQuotaSummary();
    res.json({ accounts, quota });
  } catch (err) { next(err); }
});

async function verifyCloudflareCredentials(auth_type: string, credentials: { api_token?: string; api_key?: string; email?: string }): Promise<void> {
  const fetch = require('node-fetch');
  const httpAgent = getHttpAgent();
  const fetchOpts: any = {
    headers: {}
  };
  if (httpAgent) fetchOpts.agent = httpAgent;

  if (auth_type === 'token') {
    fetchOpts.headers['Authorization'] = `Bearer ${credentials.api_token}`;
    const verifyRes = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', fetchOpts);
    if (!verifyRes.ok) {
      const body = await verifyRes.text();
      throw new Error(`Cloudflare API Token 验证失败 (${verifyRes.status}): ${body}`);
    }
  } else {
    fetchOpts.headers['X-Auth-Email'] = credentials.email;
    fetchOpts.headers['X-Auth-Key'] = credentials.api_key;
    const verifyRes = await fetch('https://api.cloudflare.com/client/v4/user', fetchOpts);
    if (!verifyRes.ok) {
      const body = await verifyRes.text();
      throw new Error(`Cloudflare API Key 验证失败 (${verifyRes.status}): ${body}`);
    }
  }
}

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, auth_type, api_token, api_key, email } = req.body;
    if (!name || !auth_type) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name and auth_type are required' } });
      return;
    }
    if (auth_type !== 'token' && auth_type !== 'global_key') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'auth_type must be "token" or "global_key"' } });
      return;
    }
    if (auth_type === 'token' && !api_token) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'api_token is required for token auth' } });
      return;
    }
    if (auth_type === 'global_key' && (!api_key || !email)) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'api_key and email are required for global_key auth' } });
      return;
    }

    // Verify credentials before saving
    try {
      await verifyCloudflareCredentials(auth_type, { api_token, api_key, email });
    } catch (e: any) {
      res.status(400).json({ error: { code: 'CREDENTIAL_INVALID', message: e.message || e } });
      return;
    }

    const input: AccountInput = { name, auth_type, account_id: null, enabled_features: req.body.enabled_features };
    if (auth_type === 'token') {
      input.api_token = encrypt(api_token);
    } else {
      input.api_key = encrypt(api_key);
      input.email = email;
    }
    const id = createAccount(input);

    // Auto-fetch account ID
    try {
      const saved = getAccountById(id);
      if (saved) {
        const cf = getCfClient(saved);
        const accts: any[] = [];
        for await (const acct of cf.accounts.list()) {
          accts.push(acct as any);
        }
        if (accts.length > 0) {
          updateAccountId(id, accts[0].id);
          input.account_id = accts[0].id;
          appLogger.info(`[Account] Auto-fetched account_id=${accts[0].id} for "${name}"`);
        }
        updateAccountStatus(id, true);
      }
    } catch (e) {
      appLogger.warn(`[Account] Failed to auto-fetch account_id for "${name}": ${e}`);
    }

    createAuditLog(id, 'create_account', name, `auth_type=${auth_type}`, 'success');
    res.status(201).json({ id, ...input, api_token: '***', api_key: '***' });
  } catch (err) { next(err); }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isDemoAccount(id)) {
      res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可修改' } });
      return;
    }
    const account = getAccountById(id);
    if (!account) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } });
      return;
    }

    const { name, auth_type, api_token, api_key, email } = req.body;
    if (!name || !auth_type) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name and auth_type are required' } });
      return;
    }
    if (auth_type !== 'token' && auth_type !== 'global_key') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'auth_type must be "token" or "global_key"' } });
      return;
    }
    if (auth_type === 'token' && !api_token) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'api_token is required' } });
      return;
    }
    if (auth_type === 'global_key' && (!api_key || !email)) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'api_key and email are required' } });
      return;
    }

    // Verify credentials
    try {
      await verifyCloudflareCredentials(auth_type, { api_token, api_key, email });
    } catch (e: any) {
      res.status(400).json({ error: { code: 'CREDENTIAL_INVALID', message: e.message || e } });
      return;
    }

    const input: Partial<AccountInput> = { name, auth_type };
    if (auth_type === 'token') {
      input.api_token = encrypt(api_token);
      input.api_key = null;
      input.email = null;
    } else {
      input.api_key = encrypt(api_key);
      input.email = email;
      input.api_token = null;
    }

    // Auto-fetch account_id on update
    let fetchedAccountId: string | null = null;
    try {
      const cf = getCfClient({ ...account, ...input } as any);
      const accts: any[] = [];
      for await (const acct of cf.accounts.list()) {
        accts.push(acct as any);
      }
      if (accts.length > 0) {
        fetchedAccountId = accts[0].id;
        appLogger.info(`[Account] Auto-fetched account_id=${accts[0].id} for "${name}" during update`);
      }
    } catch (e) {
      appLogger.warn(`[Account] Failed to auto-fetch account_id during update: ${e}`);
    }

    input.account_id = fetchedAccountId || account.account_id || null;

    updateAccount(id, input);
    clearCache();
    createAuditLog(id, 'update_account', name, `auth_type=${auth_type}`, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.patch('/:id/features', (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isDemoAccount(id)) {
      res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可修改' } });
      return;
    }
    const account = getAccountById(id);
    if (!account) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }); return; }
    const { enabled_features } = req.body;
    if (typeof enabled_features !== 'string') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'enabled_features is required' } });
      return;
    }
    updateAccountFeatures(id, enabled_features);
    clearCache();
    createAuditLog(id, 'update_features', account.name, enabled_features, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isDemoAccount(id)) {
      res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可删除' } });
      return;
    }
    const account = getAccountById(id);
    if (!account) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }); return; }
    createAuditLog(id, 'delete_account', account.name, null, 'success');
    deleteAccount(id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post('/:id/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accountId = parseInt(req.params.id as string, 10);
    const account = getAccountById(accountId);
    if (!account) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }); return; }
    const cf = getCfClient(account);
    const user = await cf.user.get();

    // 自动获取并存储 Cloudflare Account ID
    if (!account.account_id) {
      try {
        const accounts: any[] = [];
        for await (const acct of cf.accounts.list()) {
          accounts.push(acct as any);
        }
        if (accounts.length > 0) {
          updateAccountId(accountId, accounts[0].id);
        }
      } catch (e) {
        // 获取账号列表失败不是致命错误，继续返回测试结果
        appLogger.warn(`Failed to fetch account list: ${e}`);
      }
    }

    // 测试成功，更新状态为活跃
    updateAccountStatus(accountId, true);
    res.json({ success: true, user });
  } catch (err) { next(err); }
});

export default router;
