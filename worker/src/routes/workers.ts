import { Hono } from 'hono';
import type { Env } from '../types';
import { getAccountById, getActiveAccountsByFeature, addAuditLog } from '../db/models';
import { cfFetch, cfFetchRaw, cfFetchAll } from '../services/cfApi';
import { getWorkersUsageToday } from '../services/quotaTracker';

const app = new Hono<{ Bindings: Env }>();

async function requireAccount(c: any) {
  const id = parseInt(c.req.param('accountId'), 10);
  const account = await getAccountById(c.env.DB, id);
  if (!account) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  return account;
}

// ============ List all ============
app.get('/', async (c) => {
  const accounts = await getActiveAccountsByFeature(c.env.DB, 'workers');
  const results = await Promise.all(accounts.map(async (account) => {
    const items: any[] = [];
    const [workersRes, pagesRes] = await Promise.allSettled([
      cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/workers/scripts`, c.env.ENCRYPTION_KEY),
      cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/pages/projects`, c.env.ENCRYPTION_KEY),
    ]);
    if (workersRes.status === 'fulfilled') {
      items.push(...(workersRes.value.result || []).map(w => ({ ...w, type: 'worker', cfAccountId: account.id, accountName: account.name })));
    } else { console.error(`[Workers] list failed for ${account.name}: ${workersRes.reason}`); }
    if (pagesRes.status === 'fulfilled') {
      items.push(...(pagesRes.value.result || []).map(p => ({ ...p, type: 'pages', cfAccountId: account.id, accountName: account.name })));
    } else { console.error(`[Pages] list failed for ${account.name}: ${pagesRes.reason}`); }
    return items;
  }));
  return c.json(results.flat());
});

// ============ Deploy Worker ============
app.post('/:accountId/workers', async (c) => {
  const account = await requireAccount(c);
  const contentType = c.req.header('content-type') || '';

  let name: string;
  let scriptContent: string;

  if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.formData();
    name = formData.get('name') as string;
    const url = formData.get('url') as string;
    const file = formData.get('script') as File | null;
    if (!name) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Worker name is required' } }, 400);
    if (url) {
      const resp = await fetch(url);
      if (!resp.ok) return c.json({ error: { code: 'FETCH_ERROR', message: `Failed to fetch script: ${resp.status}` } }, 400);
      scriptContent = await resp.text();
    } else if (file) {
      scriptContent = await file.text();
    } else {
      return c.json({ error: { code: 'NO_FILE', message: 'Script file or URL is required' } }, 400);
    }
  } else {
    const body = await c.req.json();
    name = body.name;
    if (!name) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Worker name is required' } }, 400);
    if (body.url) {
      const resp = await fetch(body.url);
      if (!resp.ok) return c.json({ error: { code: 'FETCH_ERROR', message: `Failed to fetch script: ${resp.status}` } }, 400);
      scriptContent = await resp.text();
    } else if (body.script) {
      scriptContent = body.script;
    } else {
      return c.json({ error: { code: 'NO_FILE', message: 'Script content or URL is required' } }, 400);
    }
  }

  const metadata = JSON.stringify({ main_module: 'worker.js', compatibility_date: '2024-01-01' });
  const form = new FormData();
  form.append('metadata', new Blob([metadata], { type: 'application/json' }));
  form.append('worker.js', new Blob([scriptContent], { type: 'application/javascript+module' }), 'worker.js');

  const resp = await cfFetchRaw(account, `/accounts/${account.account_id}/workers/scripts/${name}`, c.env.ENCRYPTION_KEY, {
    method: 'PUT', body: form,
  });
  const result = await resp.json();
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'deploy_worker', target: name, status: 'success' });
  return c.json(result, 201);
});

// ============ Delete Worker/Pages ============
app.delete('/:accountId/workers/:name', async (c) => {
  const account = await requireAccount(c);
  const name = c.req.param('name');
  await cfFetch(account, `/accounts/${account.account_id}/workers/scripts/${name}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'delete_worker', target: name, status: 'success' });
  return c.json({ success: true });
});

app.delete('/:accountId/pages/:name', async (c) => {
  const account = await requireAccount(c);
  const name = c.req.param('name');
  await cfFetch(account, `/accounts/${account.account_id}/pages/projects/${name}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'delete_pages', target: name, status: 'success' });
  return c.json({ success: true });
});

// ============ Secrets ============
app.get('/:accountId/workers/:name/secrets', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/secrets`, c.env.ENCRYPTION_KEY);
  return c.json(data.result || []);
});

app.put('/:accountId/workers/:name/secrets', async (c) => {
  const account = await requireAccount(c);
  const body = await c.req.json();
  if (!body.name || !body.type) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name and type are required' } }, 400);
  const result = await cfFetch(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/secrets`, c.env.ENCRYPTION_KEY, {
    method: 'PUT', body: JSON.stringify(body),
  });
  return c.json(result);
});

app.delete('/:accountId/workers/:name/secrets/:secretName', async (c) => {
  const account = await requireAccount(c);
  await cfFetch(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/secrets/${c.req.param('secretName')}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  return c.json({ success: true });
});

// ============ Schedules ============
app.get('/:accountId/workers/:name/schedules', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<any>(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/schedules`, c.env.ENCRYPTION_KEY);
  return c.json(data.result ?? data);
});

app.put('/:accountId/workers/:name/schedules', async (c) => {
  const account = await requireAccount(c);
  const body = await c.req.json();
  if (!Array.isArray(body.crons)) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'crons must be an array' } }, 400);
  const result = await cfFetch(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/schedules`, c.env.ENCRYPTION_KEY, {
    method: 'PUT', body: JSON.stringify(body.crons.map((cron: string) => ({ cron }))),
  });
  return c.json(result);
});

// ============ Custom Domains ============
app.get('/:accountId/workers/:name/domains', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/workers/domains?service=${c.req.param('name')}`, c.env.ENCRYPTION_KEY);
  return c.json(data.result || []);
});

app.post('/:accountId/workers/:name/domains', async (c) => {
  const account = await requireAccount(c);
  const body = await c.req.json();
  if (!body.hostname) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'hostname is required' } }, 400);
  const result = await cfFetch(account, `/accounts/${account.account_id}/workers/domains`, c.env.ENCRYPTION_KEY, {
    method: 'PUT', body: JSON.stringify({ hostname: body.hostname, service: c.req.param('name'), environment: body.environment || 'production' }),
  });
  return c.json(result);
});

app.delete('/:accountId/workers/:name/domains/:domainId', async (c) => {
  const account = await requireAccount(c);
  await cfFetch(account, `/accounts/${account.account_id}/workers/domains/${c.req.param('domainId')}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  return c.json({ success: true });
});

// ============ Subdomain ============
app.get('/:accountId/workers/:name/subdomain', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<any>(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/subdomain`, c.env.ENCRYPTION_KEY);
  return c.json(data.result ?? data);
});

app.put('/:accountId/workers/:name/subdomain', async (c) => {
  const account = await requireAccount(c);
  const body = await c.req.json();
  if (typeof body.enabled !== 'boolean') return c.json({ error: { code: 'VALIDATION_ERROR', message: 'enabled must be boolean' } }, 400);
  const result = await cfFetch(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/subdomain`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify({ enabled: body.enabled }),
  });
  return c.json(result);
});

// ============ Script Settings ============
app.get('/:accountId/workers/:name/settings', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<any>(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/settings`, c.env.ENCRYPTION_KEY);
  return c.json(data.result ?? data);
});

app.patch('/:accountId/workers/:name/settings', async (c) => {
  const account = await requireAccount(c);
  const body = await c.req.json();
  const result = await cfFetch(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/settings`, c.env.ENCRYPTION_KEY, {
    method: 'PATCH', body: JSON.stringify(body),
  });
  return c.json(result);
});

// ============ Routes ============
app.get('/:accountId/workers/:name/routes', async (c) => {
  const account = await requireAccount(c);
  const zoneId = c.req.query('zone_id');
  if (!zoneId) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'zone_id is required' } }, 400);
  const data = await cfFetch<{ result: any[] }>(account, `/zones/${zoneId}/workers/routes`, c.env.ENCRYPTION_KEY);
  return c.json(data.result || []);
});

app.post('/:accountId/workers/:name/routes', async (c) => {
  const account = await requireAccount(c);
  const body = await c.req.json();
  if (!body.zone_id || !body.pattern) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'zone_id and pattern are required' } }, 400);
  const result = await cfFetch(account, `/zones/${body.zone_id}/workers/routes`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify({ pattern: body.pattern, script: body.script || c.req.param('name') }),
  });
  return c.json(result);
});

app.delete('/:accountId/workers/:name/routes/:routeId', async (c) => {
  const account = await requireAccount(c);
  const zoneId = c.req.query('zone_id');
  if (!zoneId) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'zone_id is required' } }, 400);
  await cfFetch(account, `/zones/${zoneId}/workers/routes/${c.req.param('routeId')}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  return c.json({ success: true });
});

// ============ Script Content ============
app.get('/:accountId/workers/:name/content', async (c) => {
  const account = await requireAccount(c);
  const resp = await cfFetchRaw(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}`, c.env.ENCRYPTION_KEY);
  const text = await resp.text();
  return c.text(text);
});

// ============ Deployments ============
app.get('/:accountId/workers/:name/deployments', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<any>(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/deployments`, c.env.ENCRYPTION_KEY);
  return c.json(data.result ?? data);
});

// ============ Pages Settings ============
app.get('/:accountId/pages/:name/project', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch(account, `/accounts/${account.account_id}/pages/projects/${c.req.param('name')}`, c.env.ENCRYPTION_KEY);
  return c.json(data.result || data);
});

app.patch('/:accountId/pages/:name/project', async (c) => {
  const account = await requireAccount(c);
  const body = await c.req.json();
  const result = await cfFetch(account, `/accounts/${account.account_id}/pages/projects/${c.req.param('name')}`, c.env.ENCRYPTION_KEY, {
    method: 'PATCH', body: JSON.stringify(body),
  });
  return c.json(result);
});

app.get('/:accountId/pages/:name/domains', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/pages/projects/${c.req.param('name')}/domains`, c.env.ENCRYPTION_KEY);
  return c.json(data.result || []);
});

app.post('/:accountId/pages/:name/domains', async (c) => {
  const account = await requireAccount(c);
  const body = await c.req.json();
  if (!body.hostname) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'hostname is required' } }, 400);
  const result = await cfFetch(account, `/accounts/${account.account_id}/pages/projects/${c.req.param('name')}/domains`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify({ name: body.hostname }),
  });
  return c.json(result);
});

app.delete('/:accountId/pages/:name/domains/:hostname', async (c) => {
  const account = await requireAccount(c);
  await cfFetch(account, `/accounts/${account.account_id}/pages/projects/${c.req.param('name')}/domains/${c.req.param('hostname')}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  return c.json({ success: true });
});

app.get('/:accountId/pages/:name/deployments', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<any>(account, `/accounts/${account.account_id}/pages/projects/${c.req.param('name')}/deployments`, c.env.ENCRYPTION_KEY);
  return c.json(data.result ?? data);
});

// ============ Resources ============
app.get('/:accountId/resources/kv', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/storage/kv/namespaces`, c.env.ENCRYPTION_KEY);
  return c.json(data.result || []);
});

app.get('/:accountId/resources/d1', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/d1/database`, c.env.ENCRYPTION_KEY);
  return c.json(data.result || []);
});

app.get('/:accountId/resources/r2', async (c) => {
  const account = await requireAccount(c);
  try {
    const data = await cfFetch<{ result: any }>(account, `/accounts/${account.account_id}/r2/buckets`, c.env.ENCRYPTION_KEY);
    return c.json(data.result?.buckets || []);
  } catch (e: any) {
    if (e.body?.includes('10042') || e.body?.includes('enable R2')) {
      return c.json({ r2_not_enabled: true, buckets: [] });
    }
    throw e;
  }
});

app.get('/:accountId/resources/zones', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetchAll<any>(account, '/zones', c.env.ENCRYPTION_KEY, 100);
  return c.json(data.filter(z => z.account?.id === account.account_id));
});

app.put('/:accountId/pages/:name/bindings', async (c) => {
  const account = await requireAccount(c);
  const body = await c.req.json();
  const result = await cfFetch(account, `/accounts/${account.account_id}/pages/projects/${c.req.param('name')}`, c.env.ENCRYPTION_KEY, {
    method: 'PATCH', body: JSON.stringify({ deployment_configs: body.deployment_configs }),
  });
  return c.json(result);
});

// ============ Usage ============
app.get('/usage', async (c) => {
  const accounts = await getActiveAccountsByFeature(c.env.DB, 'workers');
  const results = await Promise.all(accounts.map(async (account) => {
    try {
      const usage = await getWorkersUsageToday(account, c.env.ENCRYPTION_KEY);
      return { accountId: account.id, accountName: account.name, ...usage };
    } catch (err) {
      console.error(`[Usage] Failed for ${account.name}: ${err}`);
      return { accountId: account.id, accountName: account.name, requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
    }
  }));
  return c.json(results);
});

// ============ Batch Deploy ============
app.post('/batch-deploy', async (c) => {
  const contentType = c.req.header('content-type') || '';
  let targets: any[];
  let scriptContent: string | null = null;
  let scriptUrl: string | null = null;

  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    targets = JSON.parse(form.get('targets') as string);
    scriptUrl = form.get('url') as string | null;
    const file = form.get('script') as File | null;
    if (file) scriptContent = await file.text();
  } else {
    const body = await c.req.json();
    targets = body.targets;
    scriptUrl = body.url;
    scriptContent = body.script;
  }

  if (!Array.isArray(targets) || targets.length === 0) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'targets must be a non-empty array' } }, 400);
  if (!scriptContent && !scriptUrl) return c.json({ error: { code: 'NO_FILE', message: 'Script or URL required' } }, 400);

  if (scriptUrl && !scriptContent) {
    const resp = await fetch(scriptUrl);
    if (!resp.ok) return c.json({ error: { code: 'FETCH_ERROR', message: `Failed: ${resp.status}` } }, 400);
    scriptContent = await resp.text();
  }

  const results = await Promise.all(targets.map(async (t: { accountId: number; workerName: string }) => {
    try {
      const account = await getAccountById(c.env.DB, t.accountId);
      if (!account) return { ...t, success: false, error: 'Account not found' };
      const metadata = JSON.stringify({ main_module: 'worker.js', compatibility_date: '2024-01-01' });
      const form = new FormData();
      form.append('metadata', new Blob([metadata], { type: 'application/json' }));
      form.append('worker.js', new Blob([scriptContent!], { type: 'application/javascript+module' }), 'worker.js');
      await cfFetchRaw(account, `/accounts/${account.account_id}/workers/scripts/${t.workerName}`, c.env.ENCRYPTION_KEY, { method: 'PUT', body: form });
      await addAuditLog(c.env.DB, { account_id: account.id, action: 'batch_deploy', target: t.workerName, status: 'success' });
      return { ...t, success: true };
    } catch (err: any) {
      return { ...t, success: false, error: err.message };
    }
  }));
  return c.json(results);
});

export default app;
