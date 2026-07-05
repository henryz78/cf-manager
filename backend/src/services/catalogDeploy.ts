import { Account } from '../models/account';
import { getCfClient, getAuthHeaders } from './cfFactory';
import { proxyFetch } from './proxyService';
import { createAuditLog } from '../models/auditLog';
import type { CatalogTemplate, CatalogBinding } from './catalogValidator';
import { appLogger } from './logger';

export interface DeployOptions {
  account: Account;
  template: CatalogTemplate;
  name: string;
  bindingSelections: Record<string, { mode: 'auto' | 'existing'; existingId?: string; runInitSql?: boolean }>;
  secretValues: Record<string, string>;
}

interface ResolvedBinding {
  type: string;
  name: string;
  cfBinding: Record<string, unknown>;
  created: boolean;
  resourceType?: 'kv' | 'd1' | 'r2';
  resourceId?: string;
}

interface DeployResult {
  success: boolean;
  error?: string;
  warnings: string[];
  bindings: ResolvedBinding[];
  url?: string;
  rolledBack?: boolean;
  rollbackErrors?: string[];
}

const MAX_DOWNLOAD = 50 * 1024 * 1024;
const CF_BASE = 'https://api.cloudflare.com/client/v4';

async function downloadArtifact(url: string, type: 'worker' | 'pages'): Promise<Buffer> {
  const resp = await proxyFetch(url, {}, 30000);
  if (!resp.ok) throw new Error(`产物下载失败: ${resp.status}`);

  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD) throw new Error('产物超过 50MB 限制');

  if (type === 'worker') {
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) throw new Error('Worker 产物应是 JS 文本，但下载内容是 zip');
  } else {
    if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) throw new Error('Pages 产物应是 zip，但下载内容不是 zip');
  }

  return buffer;
}

async function cfRest(account: Account, path: string, init?: RequestInit): Promise<any> {
  const headers = getAuthHeaders(account);
  const resp = await fetch(`${CF_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...headers, ...(init?.headers as any || {}) },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw Object.assign(new Error(`CF API ${resp.status}: ${body}`), { status: resp.status, body });
  }
  return resp.json();
}

async function resolveBinding(
  account: Account,
  binding: CatalogBinding,
  selection: { mode: 'auto' | 'existing'; existingId?: string; runInitSql?: boolean } | undefined,
  templateId: string,
): Promise<ResolvedBinding> {
  const title = binding.title || `${templateId}-${binding.name.toLowerCase()}`;
  const sel = selection || { mode: 'auto' };
  const cf = getCfClient(account);
  const accountId = account.account_id!;

  if (binding.type === 'ai') {
    return { type: 'ai', name: binding.name, cfBinding: { type: 'ai', name: binding.name }, created: false };
  }

  if (binding.type === 'var') {
    return { type: 'var', name: binding.name, cfBinding: { type: 'secret_text', name: binding.name, text: '' }, created: false };
  }

  if (binding.type === 'kv') {
    if (sel.mode === 'existing' && sel.existingId) {
      return { type: 'kv', name: binding.name, cfBinding: { type: 'kv_namespace', name: binding.name, namespace_id: sel.existingId }, created: false, resourceType: 'kv', resourceId: sel.existingId };
    }
    const items: any[] = [];
    for await (const ns of cf.kv.namespaces.list({ account_id: accountId })) items.push(ns);
    const found = items.find(ns => ns.title === title);
    if (found) {
      return { type: 'kv', name: binding.name, cfBinding: { type: 'kv_namespace', name: binding.name, namespace_id: found.id }, created: false, resourceType: 'kv', resourceId: found.id };
    }
    const created = await cf.kv.namespaces.create({ account_id: accountId, title });
    return { type: 'kv', name: binding.name, cfBinding: { type: 'kv_namespace', name: binding.name, namespace_id: created.id }, created: true, resourceType: 'kv', resourceId: created.id };
  }

  if (binding.type === 'd1') {
    if (sel.mode === 'existing' && sel.existingId) {
      if (sel.runInitSql && (binding.initSqlUrl || binding.initSql)) {
        await executeInitSql(account, sel.existingId, binding);
      }
      return { type: 'd1', name: binding.name, cfBinding: { type: 'd1', name: binding.name, id: sel.existingId }, created: false, resourceType: 'd1', resourceId: sel.existingId };
    }
    const items: any[] = [];
    for await (const db of cf.d1.database.list({ account_id: accountId })) items.push(db);
    const found = items.find(db => db.name === title);
    if (found) {
      if (sel.runInitSql && (binding.initSqlUrl || binding.initSql)) {
        await executeInitSql(account, found.uuid, binding);
      }
      return { type: 'd1', name: binding.name, cfBinding: { type: 'd1', name: binding.name, id: found.uuid }, created: false, resourceType: 'd1', resourceId: found.uuid };
    }
    const created = await cf.d1.database.create({ account_id: accountId, name: title });
    if (sel.runInitSql !== false && (binding.initSqlUrl || binding.initSql)) {
      await executeInitSql(account, created.uuid!, binding);
    }
    return { type: 'd1', name: binding.name, cfBinding: { type: 'd1', name: binding.name, id: created.uuid }, created: true, resourceType: 'd1', resourceId: created.uuid };
  }

  if (binding.type === 'r2') {
    if (sel.mode === 'existing' && sel.existingId) {
      return { type: 'r2', name: binding.name, cfBinding: { type: 'r2_bucket', name: binding.name, bucket_name: sel.existingId }, created: false, resourceType: 'r2', resourceId: sel.existingId };
    }
    let buckets: any[] = [];
    try {
      const resp: any = await cf.r2.buckets.list({ account_id: accountId });
      buckets = resp?.buckets || [];
    } catch {}
    const found = buckets.find(b => b.name === title);
    if (found) {
      return { type: 'r2', name: binding.name, cfBinding: { type: 'r2_bucket', name: binding.name, bucket_name: found.name }, created: false, resourceType: 'r2', resourceId: found.name };
    }
    await cf.r2.buckets.create({ account_id: accountId, name: title });
    return { type: 'r2', name: binding.name, cfBinding: { type: 'r2_bucket', name: binding.name, bucket_name: title }, created: true, resourceType: 'r2', resourceId: title };
  }

  throw new Error(`Unknown binding type: ${binding.type}`);
}

async function executeInitSql(account: Account, dbId: string, binding: CatalogBinding): Promise<void> {
  let sql = binding.initSql;
  if (!sql && binding.initSqlUrl) {
    const resp = await proxyFetch(binding.initSqlUrl, {}, 30000);
    if (!resp.ok) throw new Error(`initSqlUrl 下载失败: ${resp.status}`);
    sql = await resp.text();
  }
  if (!sql) return;
  const cf = getCfClient(account);
  await cf.d1.database.query(dbId, { account_id: account.account_id!, sql });
}

async function rollback(account: Account, bindings: ResolvedBinding[], workerName?: string): Promise<string[]> {
  const errors: string[] = [];
  const cf = getCfClient(account);
  const accountId = account.account_id!;
  for (const b of [...bindings].reverse()) {
    if (!b.created || !b.resourceType || !b.resourceId) continue;
    try {
      if (b.resourceType === 'kv') await cf.kv.namespaces.delete(b.resourceId, { account_id: accountId });
      else if (b.resourceType === 'd1') await cf.d1.database.delete(b.resourceId, { account_id: accountId });
      else if (b.resourceType === 'r2') await cf.r2.buckets.delete(b.resourceId, { account_id: accountId });
    } catch (e: any) {
      errors.push(`${b.resourceType}:${b.resourceId} - ${e.message}`);
    }
  }
  if (workerName) {
    try { await cf.workers.scripts.delete(workerName, { account_id: accountId }); } catch {}
  }
  return errors;
}

export async function deployTemplate(opts: DeployOptions): Promise<DeployResult> {
  const { account, template, name, bindingSelections, secretValues } = opts;
  const warnings: string[] = [];
  const resolvedBindings: ResolvedBinding[] = [];

  try {
    // Step 1: Download
    const content = await downloadArtifact(template.source.url, template.type);

    // Step 2: Resolve bindings
    for (const binding of (template.bindings || [])) {
      const selection = bindingSelections[binding.name];
      const resolved = await resolveBinding(account, binding, selection, template.id);
      if (binding.type === 'var' && binding.action === 'prompt') {
        const val = secretValues[binding.name];
        if (binding.required && !val) throw new Error(`必填密钥 ${binding.name} 未填写`);
        resolved.cfBinding.text = val || '';
      }
      resolvedBindings.push(resolved);
    }

    // Step 3: Deploy
    const cf = getCfClient(account);
    const accountId = account.account_id!;

    if (template.type === 'worker') {
      const metadata: any = {
        main_module: 'worker.js',
        compatibility_date: '2024-01-01',
        bindings: resolvedBindings.map(b => b.cfBinding),
      };
      if (template.env) {
        metadata.bindings = [
          ...metadata.bindings,
          ...Object.entries(template.env).map(([k, v]) => ({ type: 'plain_text', name: k, text: v })),
        ];
      }
      // Use raw multipart upload to ensure ES Module is recognized
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('worker.js', new Blob([new Uint8Array(content)], { type: 'application/javascript+module' }), 'worker.js');
      const headers = getAuthHeaders(account);
      const resp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}`, {
        method: 'PUT',
        headers,
        body: form,
      });
      const respJson = await resp.json() as any;
      if (!resp.ok || !respJson.success) {
        throw new Error(`${resp.status} ${JSON.stringify(respJson)}`);
      }
    } else {
      // Pages
      try {
        await cf.pages.projects.create({ account_id: accountId, name, production_branch: 'main' } as any);
      } catch (e: any) {
        if (e?.status !== 409) throw e;
      }

      // Deploy via API (SDK doesn't support direct file upload well)
      const headers = getAuthHeaders(account);
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(content)], { type: 'application/zip' }), 'dist.zip');
      const resp = await fetch(`${CF_BASE}/accounts/${accountId}/pages/projects/${name}/deployments`, {
        method: 'POST', headers, body: form,
      });
      if (!resp.ok) throw new Error(`Pages deploy failed: ${await resp.text()}`);

      // Set env + bindings
      if (template.env || template.bindings) {
        const deploymentConfigs: any = { production: { env_vars: {}, kv_namespaces: [], d1_databases: [], r2_buckets: [] } };
        if (template.env) {
          for (const [k, v] of Object.entries(template.env)) {
            deploymentConfigs.production.env_vars[k] = { value: v };
          }
        }
        for (const rb of resolvedBindings) {
          if (rb.type === 'kv') deploymentConfigs.production.kv_namespaces.push(rb.cfBinding);
          if (rb.type === 'd1') deploymentConfigs.production.d1_databases.push(rb.cfBinding);
          if (rb.type === 'r2') deploymentConfigs.production.r2_buckets.push(rb.cfBinding);
        }
        await cf.pages.projects.edit(name, { account_id: accountId, deployment_configs: deploymentConfigs } as any);
      }
    }

    // Step 4: Routes (soft failure)
    if (template.routes && template.routes.length > 0) {
      for (const pattern of template.routes) {
        try {
          const hostname = pattern.split('/')[0];
          const zones: any[] = [];
          for await (const z of (cf.zones.list as any)({ account_id: accountId })) zones.push(z);
          const zone = zones.find(z => z.name === hostname || hostname.endsWith('.' + z.name));
          if (!zone) { warnings.push(`路由 ${pattern} 创建失败: 未找到 zone`); continue; }
          await cf.workers.routes.create({ zone_id: zone.id, pattern, script: name });
        } catch (e: any) {
          warnings.push(`路由 ${pattern} 创建失败: ${e.message}`);
        }
      }
    }

    createAuditLog(account.id!, 'store_deploy', name, `template: ${template.id}`, 'success');
    const url = (template.type === 'worker')
      ? `https://${name}.workers.dev`
      : `https://${name}.pages.dev`;
    return { success: true, warnings, bindings: resolvedBindings, url };

  } catch (e: any) {
    const rollbackErrors = await rollback(account, resolvedBindings, name);
    createAuditLog(account.id!, 'store_deploy', name, `error: ${e.message}`, 'error');
    return {
      success: false, error: e.message, warnings, bindings: resolvedBindings,
      rolledBack: true, rollbackErrors: rollbackErrors.length > 0 ? rollbackErrors : undefined,
    };
  }
}
