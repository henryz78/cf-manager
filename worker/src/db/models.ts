export interface Account {
  id: number;
  name: string;
  auth_type: 'token' | 'global_key';
  api_token: string | null;
  api_key: string | null;
  email: string | null;
  account_id: string | null;
  is_active: number;
  enabled_features: string;
  created_at: string;
  updated_at: string;
}

export type AccountFeature = 'ai' | 'workers' | 'browser_render' | 'dns' | 'storage';

export function hasFeature(account: Account, feature: AccountFeature): boolean {
  return (account.enabled_features || '').split(',').map(f => f.trim()).includes(feature);
}

export interface QuotaUsage {
  id: number;
  account_id: number;
  resource: string;
  date: string;
  count: number;
}

export interface AuditLogRow {
  id: number;
  account_id: number | null;
  action: string;
  target: string | null;
  detail: string | null;
  status: string;
  created_at: string;
  account_name?: string;
}

// ============ Account queries ============

export async function getActiveAccounts(db: D1Database): Promise<Account[]> {
  const { results } = await db.prepare('SELECT * FROM accounts WHERE is_active = 1 ORDER BY name').all<Account>();
  return results;
}

export async function getActiveAccountsByFeature(db: D1Database, feature: AccountFeature): Promise<Account[]> {
  const all = await getActiveAccounts(db);
  return all.filter(a => hasFeature(a, feature));
}

export async function getAllAccounts(db: D1Database): Promise<Account[]> {
  const { results } = await db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all<Account>();
  return results;
}

export async function getAccountById(db: D1Database, id: number): Promise<Account | null> {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<Account>();
}

export async function createAccount(db: D1Database, data: {
  name: string; auth_type: string; api_token?: string; api_key?: string;
  email?: string; account_id?: string; enabled_features?: string;
}): Promise<number> {
  const res = await db.prepare(
    'INSERT INTO accounts (name, auth_type, api_token, api_key, email, account_id, enabled_features) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(data.name, data.auth_type, data.api_token || null, data.api_key || null,
    data.email || null, data.account_id || null, data.enabled_features || 'ai,workers,browser_render,dns,storage').run();
  return res.meta.last_row_id;
}

export async function updateAccount(db: D1Database, id: number, data: Partial<Account>): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined && !['id', 'created_at'].includes(key)) {
      sets.push(`${key} = ?`);
      vals.push(val);
    }
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  await db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
}

export async function deleteAccount(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
}

// ============ Quota queries ============

export async function getAllQuotaToday(db: D1Database): Promise<QuotaUsage[]> {
  const today = new Date().toISOString().split('T')[0];
  const { results } = await db.prepare('SELECT * FROM quota_usage WHERE date = ?').bind(today).all<QuotaUsage>();
  return results;
}

export async function setQuota(db: D1Database, accountId: number, resource: string, count: number): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  await db.prepare(
    `INSERT INTO quota_usage (account_id, resource, date, count) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, resource, date) DO UPDATE SET count = ?`
  ).bind(accountId, resource, today, count, count).run();
}

export async function incrementQuota(db: D1Database, accountId: number, resource: string, amount: number): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  await db.prepare(
    `INSERT INTO quota_usage (account_id, resource, date, count) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, resource, date) DO UPDATE SET count = count + ?`
  ).bind(accountId, resource, today, amount, amount).run();
}

export async function getQuotaByAccount(db: D1Database, accountId: number, resource: string): Promise<QuotaUsage | null> {
  const today = new Date().toISOString().split('T')[0];
  return db.prepare('SELECT * FROM quota_usage WHERE account_id = ? AND resource = ? AND date = ?')
    .bind(accountId, resource, today).first<QuotaUsage>();
}

// ============ Audit log ============

export async function addAuditLog(db: D1Database, data: {
  account_id?: number; action: string; target?: string; detail?: string; status: string;
}): Promise<void> {
  await db.prepare(
    'INSERT INTO audit_log (account_id, action, target, detail, status) VALUES (?, ?, ?, ?, ?)'
  ).bind(data.account_id || null, data.action, data.target || null, data.detail || null, data.status).run();
}

export async function getRecentLogs(db: D1Database, limit = 20): Promise<AuditLogRow[]> {
  const { results } = await db.prepare(
    `SELECT l.*, a.name as account_name FROM audit_log l
     LEFT JOIN accounts a ON l.account_id = a.id
     ORDER BY l.created_at DESC LIMIT ?`
  ).bind(limit).all<AuditLogRow>();
  return results;
}

// ============ Settings ============

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').bind(key, value).run();
}
