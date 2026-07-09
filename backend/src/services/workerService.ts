import { Account } from '../models/account';
import { getCfClient, getAuthHeaders } from './cfFactory';
import { proxyFetch, buildCurlCommand } from './proxyService';
import { getAllZones } from './accountRouter';
import path from 'path';
import { File } from 'node:buffer';
import { blake3 } from 'hash-wasm';
import { appLogger } from './logger';

// Simple MIME type lookup for common web asset types
function getContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const types: Record<string, string> = {
    html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript',
    mjs: 'application/javascript', json: 'application/json', xml: 'application/xml',
    txt: 'text/plain', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', gif: 'image/gif', ico: 'image/x-icon', webp: 'image/webp',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject', mp4: 'video/mp4', webm: 'video/webm',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', pdf: 'application/pdf',
    wasm: 'application/wasm', map: 'application/json',
  };
  return types[ext] || 'application/octet-stream';
}

// 与 wrangler 同款资产哈希（@cloudflare/deploy-helpers 的 hashFile，全链路唯一使用的算法）：
//   hash = blake3(base64(content) + extension).hex().slice(0, 32)
// Cloudflare 资产存储按此算法做内容寻址，manifest 的 hash 必须与之匹配，否则运行时按 hash 取内容失败 → 404。
async function computePageAssetHash(buffer: Buffer, filePath: string): Promise<string> {
  const base64Contents = buffer.toString('base64');
  const extension = path.extname(filePath).substring(1);
  const fullHash = await blake3(Buffer.from(base64Contents + extension, 'utf8'));
  return fullHash.slice(0, 32);
}

// Node `Buffer` is not directly assignable to the DOM `BlobPart` type under strict mode
// (its backing store is typed as `ArrayBufferLike`, which may be a `SharedArrayBuffer`).
// Copy into an ArrayBuffer-backed Uint8Array so it serializes cleanly as a binary multipart field.
function bufferToBlobPart(buf: Buffer) {
  const view = new Uint8Array(buf.byteLength);
  view.set(buf);
  return view;
}

export interface WorkerScript {
  id: string;
  name?: string;
  created_on: string;
  modified_on: string;
  etag: string;
  handlers: string[];
}

export interface DeployWorkerOptions {
  bindings?: Record<string, unknown>[];
  env?: Record<string, string>;
  compatibilityDate?: string;
  enableSubdomain?: boolean;
  createDeployment?: boolean;
  deploymentAnnotation?: Record<string, string>;
}

export interface DeployWorkerResult {
  script: any;
  subdomain?: string;
}

export interface PagesProject {
  id: string;
  name: string;
  domains: string[];
  production_branch: string;
  created_on: string;
  modified_on: string;
  deployment_count: number;
  source?: { type: string };
}

export async function listWorkers(account: Account): Promise<WorkerScript[]> {
  const accountId = account.account_id;
  if (!accountId) return [];
  const cf = getCfClient(account);
  const scripts: WorkerScript[] = [];
  for await (const script of cf.workers.scripts.list({ account_id: accountId })) {
    scripts.push(script as any);
  }
  return scripts;
}

export async function listPages(account: Account): Promise<PagesProject[]> {
  const accountId = account.account_id;
  if (!accountId) return [];
  const cf = getCfClient(account);
  const projects: PagesProject[] = [];
  for await (const project of cf.pages.projects.list({ account_id: accountId })) {
    projects.push(project as any);
  }
  return projects;
}

const CF_BASE = 'https://api.cloudflare.com/client/v4';

async function getAccountSubdomain(account: Account): Promise<string> {
  const headers = getAuthHeaders(account);
  try {
    const resp = await fetch(`${CF_BASE}/accounts/${account.account_id}/workers/subdomain`, {
      headers: { 'Content-Type': 'application/json', ...headers },
    });
    if (!resp.ok) return '';
    const json = await resp.json() as any;
    return json?.result?.subdomain || '';
  } catch {
    return '';
  }
}

export async function deployWorker(
  account: Account,
  name: string,
  scriptContent: string | Buffer,
  options?: DeployWorkerOptions,
): Promise<DeployWorkerResult> {
  const accountId = account.account_id;
  if (!accountId) throw new Error('Account ID is required');
  const cf = getCfClient(account);
  const authHeaders = getAuthHeaders(account);

  // Build metadata with optional bindings and env vars
  const metadata: any = {
    main_module: 'worker.js',
    compatibility_date: options?.compatibilityDate || '2024-01-01',
  };

  if (options?.bindings?.length) {
    metadata.bindings = options.bindings;
  }

  if (options?.env) {
    metadata.bindings = [
      ...(metadata.bindings || []),
      ...Object.entries(options.env).map(([k, v]) => ({ type: 'plain_text', name: k, text: v })),
    ];
  }

  // Convert content to Uint8Array for Blob (handles both string and Buffer)
  const contentBytes = typeof scriptContent === 'string'
    ? new TextEncoder().encode(scriptContent)
    : new Uint8Array(scriptContent);

  // Use raw fetch + FormData (same as Cloudflare wrangler does)
  // The SDK's scripts.update can mangle the multipart form in some versions
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('worker.js', new Blob([contentBytes], { type: 'application/javascript+module' }), 'worker.js');

  const resp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}`, {
    method: 'PUT',
    headers: authHeaders,
    body: form,
  });
  const respJson = await resp.json() as any;
  if (!resp.ok || !respJson.success) {
    throw new Error(`${resp.status} ${JSON.stringify(respJson)}`);
  }

  // Enable workers.dev subdomain so the Worker is accessible immediately
  let subdomain: string | undefined;
  const shouldEnableSubdomain = options?.enableSubdomain !== false; // default true
  if (shouldEnableSubdomain) {
    try {
      await cf.workers.scripts.subdomain.create(name, { account_id: accountId, enabled: true, previews_enabled: true } as any);
    } catch (_) {
      // Soft fail: user can still enable manually from settings drawer
    }

    // Get account-level subdomain for URL construction
    subdomain = await getAccountSubdomain(account);
  }

  // Create deployment (for version tracking)
  if (options?.createDeployment) {
    try {
      await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/deployments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ annotations: options.deploymentAnnotation || {} }),
      });
    } catch (e: any) {
      appLogger.warn(`[Worker Deploy] Deployment creation warning for ${name}: ${e.message}`);
    }
  }

  return { script: respJson.result, subdomain };
}

// Deploy worker from URL: fetch JS from remote URL then upload
export async function deployWorkerFromUrl(
  account: Account, name: string, url: string, options?: DeployWorkerOptions,
): Promise<DeployWorkerResult> {
  const resp = await proxyFetch(url);
  if (!resp.ok) {
    const err = new Error(`Failed to fetch JS from URL: ${resp.status} ${resp.statusText}`);
    (err as any).statusCode = resp.status;
    throw err;
  }
  const scriptContent = await resp.text();
  return deployWorker(account, name, scriptContent, options);
}

export async function deleteWorker(account: Account, name: string): Promise<void> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  await cf.workers.scripts.delete(name, { account_id: accountId! } as any);
}

export async function deletePagesProject(account: Account, name: string): Promise<void> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  await cf.pages.projects.delete(name, { account_id: accountId! } as any);
}

export async function getWorkerLogs(account: Account, name: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const result = await cf.workers.scripts.tail.get(name, { account_id: accountId! } as any);
  return result;
}

// ============ Worker Settings ============

// --- Secrets ---
export async function listSecrets(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const secrets: any[] = [];
  for await (const s of cf.workers.scripts.secrets.list(scriptName, { account_id: accountId! })) {
    secrets.push(s);
  }
  return secrets;
}

export async function updateSecret(account: Account, scriptName: string, secretName: string, type: string, text?: string, keyBase64?: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const params: any = { account_id: accountId!, name: secretName, type };
  if (type === 'secret_text') params.text = text;
  if (type === 'secret_key') params.key_base64 = keyBase64;
  return await cf.workers.scripts.secrets.update(scriptName, params);
}

export async function deleteSecret(account: Account, scriptName: string, secretName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.secrets.delete(scriptName, secretName, { account_id: accountId! });
}

// --- Cron Schedules ---
export async function getSchedules(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.schedules.get(scriptName, { account_id: accountId! });
}

export async function updateSchedules(account: Account, scriptName: string, crons: string[]): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.schedules.update(scriptName, {
    account_id: accountId!,
    body: crons.map(c => ({ cron: c })),
  });
}

// --- Custom Domains ---
export async function listDomains(account: Account, serviceName?: string): Promise<any[]> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const domains: any[] = [];
  const params: any = { account_id: accountId! };
  if (serviceName) params.service = serviceName;
  for await (const d of cf.workers.domains.list(params)) {
    domains.push(d);
  }
  return domains;
}

export async function createDomain(account: Account, hostname: string, service: string, environment?: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const params: any = { account_id: accountId!, hostname, service };
  if (environment) params.environment = environment;
  return await cf.workers.domains.update(params);
}

export async function deleteDomain(account: Account, domainId: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.domains.delete(domainId, { account_id: accountId! });
}

// --- Subdomain (workers.dev) ---
export async function getSubdomain(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.subdomain.get(scriptName, { account_id: accountId! });
}

export async function setSubdomain(account: Account, scriptName: string, enabled: boolean): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.subdomain.create(scriptName, { account_id: accountId!, enabled });
}

// --- Script Settings ---
export async function getScriptSettings(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.settings.get(scriptName, { account_id: accountId! });
}

export async function updateScriptSettings(account: Account, scriptName: string, settings: any): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.settings.edit(scriptName, { account_id: accountId!, ...settings });
}

// --- Routes ---
export async function listRoutes(account: Account, zoneId: string): Promise<any[]> {
  const cf = getCfClient(account);
  const routes: any[] = [];
  for await (const r of cf.workers.routes.list({ zone_id: zoneId })) {
    routes.push(r);
  }
  return routes;
}

export async function createRoute(account: Account, zoneId: string, pattern: string, script?: string): Promise<any> {
  const cf = getCfClient(account);
  return await cf.workers.routes.create({ zone_id: zoneId, pattern, script });
}

export async function deleteRoute(account: Account, zoneId: string, routeId: string): Promise<any> {
  const cf = getCfClient(account);
  return await cf.workers.routes.delete(routeId, { zone_id: zoneId });
}

// --- Script Content ---
export async function getScriptContent(account: Account, scriptName: string): Promise<string> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.get(scriptName, { account_id: accountId! }) as any;
}

// --- Deployments ---
export async function listDeployments(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.deployments.list(scriptName, { account_id: accountId! });
}

// ============ Pages Settings ============

export async function getPagesProject(account: Account, projectName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.pages.projects.get(projectName, { account_id: accountId! });
}

export async function editPagesProject(account: Account, projectName: string, params: any): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.pages.projects.edit(projectName, { account_id: accountId!, ...params });
}

export async function listPagesDomains(account: Account, projectName: string): Promise<any[]> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const domains: any[] = [];
  for await (const d of cf.pages.projects.domains.list(projectName, { account_id: accountId! })) {
    domains.push(d);
  }
  return domains;
}

export async function addPagesDomain(account: Account, projectName: string, hostname: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);

  // 1. Get Pages project info to find the real subdomain
  let pagesSubdomain: string;
  try {
    const projectInfo = await cf.pages.projects.get(projectName, { account_id: accountId! }) as any;
    // Real subdomain format: {projectName}.{accountSubdomain}.pages.dev
    pagesSubdomain = projectInfo.subdomain || `${projectName}.pages.dev`;
    appLogger.info(`[Pages Domain] Real subdomain: ${pagesSubdomain}`);
  } catch (e) {
    // Fallback to old format if API fails
    pagesSubdomain = `${projectName}.pages.dev`;
    appLogger.warn(`[Pages Domain] Failed to get project info, using fallback: ${pagesSubdomain}`);
  }

  // 2. Create the Pages domain association
  const result = await cf.pages.projects.domains.create(projectName, { account_id: accountId!, name: hostname });

  // 3. Automatically create CNAME DNS record if zone is in the same account
  try {
    const allZones = await getAllZones();
    const accountZones = allZones.filter(z => z.cfAccountId === account.id);
    const matchingZone = accountZones.find((z: any) => hostname.endsWith('.' + z.name) || hostname === z.name);

    if (matchingZone) {
      const existing: any[] = [];
      for await (const r of cf.dns.records.list({ zone_id: matchingZone.id, type: 'CNAME', name: { exact: hostname } })) {
        existing.push(r);
      }

      if (existing.length === 0) {
        await cf.dns.records.create({
          zone_id: matchingZone.id,
          type: 'CNAME',
          name: hostname,
          content: pagesSubdomain,
          proxied: true,
          ttl: 1,
        } as any);
        appLogger.info(`[Pages Domain] Created CNAME: ${hostname} → ${pagesSubdomain} (proxied)`);
      } else {
        appLogger.info(`[Pages Domain] CNAME already exists for ${hostname}, skipping`);
      }
    } else {
      appLogger.warn(`[Pages Domain] No matching zone found for ${hostname}, DNS record not created`);
    }
  } catch (dnsErr) {
    appLogger.error(`[Pages Domain] Failed to create DNS record: ${dnsErr}`);
  }

  return result;
}

export async function removePagesDomain(account: Account, projectName: string, hostname: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);

  // 1. Remove the Pages domain association
  const result = await cf.pages.projects.domains.delete(projectName, hostname, { account_id: accountId! });

  // 2. Clean up CNAME DNS record
  try {
    const allZones = await getAllZones();
    const accountZones = allZones.filter(z => z.cfAccountId === account.id);
    const matchingZone = accountZones.find((z: any) => hostname.endsWith('.' + z.name) || hostname === z.name);
    if (matchingZone) {
      const records: any[] = [];
      for await (const r of cf.dns.records.list({ zone_id: matchingZone.id, type: 'CNAME', name: { exact: hostname } })) {
        records.push(r);
      }
      for (const r of records) {
        if (r.content?.endsWith('.pages.dev')) {
          await cf.dns.records.delete(r.id, { zone_id: matchingZone.id });
          appLogger.info(`[Pages Domain] Deleted CNAME: ${hostname} → ${r.content}`);
        }
      }
    }
  } catch (dnsErr) {
    appLogger.error(`[Pages Domain] Failed to delete DNS record: ${dnsErr}`);
  }

  return result;
}

export async function listPagesDeployments(account: Account, projectName: string): Promise<any[]> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const deps: any[] = [];
  for await (const d of cf.pages.projects.deployments.list(projectName, { account_id: accountId! })) {
    deps.push(d);
  }
  return deps;
}

// ============ Cloudflare Resources (for Pages bindings) ============
export async function listKvNamespaces(account: Account): Promise<any[]> {
  const cf = getCfClient(account);
  const items: any[] = [];
  for await (const ns of cf.kv.namespaces.list({ account_id: account.account_id! })) {
    items.push(ns);
  }
  return items;
}

export async function listD1Databases(account: Account): Promise<any[]> {
  const cf = getCfClient(account);
  const items: any[] = [];
  for await (const db of cf.d1.database.list({ account_id: account.account_id! })) {
    items.push(db);
  }
  return items;
}

export async function listR2Buckets(account: Account): Promise<any[]> {
  const cf = getCfClient(account);
  const resp: any = await cf.r2.buckets.list({ account_id: account.account_id! });
  return resp?.buckets || [];
}

// Update Pages project bindings via deployment_configs
export async function updatePagesBindings(account: Account, projectName: string, deploymentConfigs: any): Promise<any> {
  return await editPagesProject(account, projectName, { deployment_configs: deploymentConfigs });
}

// ============ Workers Usage (GraphQL) ============
export interface WorkersUsage {
  requests: number;
  errors: number;
  subrequests: number;
  cpuTimeMs: number;
}

function getTodayMidnightUTC(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export async function getWorkersUsageToday(account: Account): Promise<WorkersUsage> {
  const accountId = account.account_id;
  if (!accountId) return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };

  const now = new Date();
  const todayDate = now.toISOString().substring(0, 10);
  const datetimeStart = getTodayMidnightUTC();
  const datetimeEnd = now.toISOString();

  const query = `
    query CfWorkersUsage($accountTag: string!, $datetimeStart: Time!, $datetimeEnd: Time!, $todayDate: Date!) {
      viewer {
        accounts(filter: {accountTag: $accountTag}) {
          workers: workersInvocationsAdaptive(
            filter: {
              datetime_geq: $datetimeStart,
              datetime_leq: $datetimeEnd
            }
            limit: 10000
          ) {
            sum {
              requests
              errors
              subrequests
              cpuTimeUs
            }
          }
          pages: pagesFunctionsInvocationsAdaptiveGroups(
            filter: {
              date: $todayDate
            }
            limit: 1
          ) {
            sum {
              requests
              errors
            }
          }
        }
      }
    }
  `;

  const headers = getAuthHeaders(account);
  const fetchUrl = 'https://api.cloudflare.com/client/v4/graphql';
  const fetchInit = {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: { accountTag: accountId, datetimeStart, datetimeEnd, todayDate },
    }),
  };
  let resp;
  try {
    resp = await proxyFetch(fetchUrl, fetchInit);
  } catch (e) {
    appLogger.error(`[Workers Usage] Fetch failed for ${account.name}: ${e}\n[DEBUG curl] ${buildCurlCommand(fetchUrl, fetchInit)}`);
    return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
  }

  if (!resp.ok) {
    const text = await resp.text();
    appLogger.error(`[GraphQL] Workers usage query failed: ${resp.status} ${text}\n[DEBUG curl] ${buildCurlCommand(fetchUrl, fetchInit)}`);
    return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
  }

  const json = await resp.json() as any;
  if (json.errors) {
    appLogger.error(`[GraphQL] Errors: ${JSON.stringify(json.errors)}`);
    return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
  }

  const acct = json?.data?.viewer?.accounts?.[0];
  const workerRecords = acct?.workers || [];
  const pagesRecords = acct?.pages || [];

  let totalRequests = 0, totalErrors = 0, totalSubrequests = 0, totalCpuUs = 0;
  for (const rec of workerRecords) {
    const s = rec.sum || {};
    totalRequests += s.requests || 0;
    totalErrors += s.errors || 0;
    totalSubrequests += s.subrequests || 0;
    totalCpuUs += s.cpuTimeUs || 0;
  }
  for (const rec of pagesRecords) {
    const s = rec.sum || {};
    totalRequests += s.requests || 0;
    totalErrors += s.errors || 0;
  }

  return {
    requests: totalRequests,
    errors: totalErrors,
    subrequests: totalSubrequests,
    cpuTimeMs: Math.round(totalCpuUs / 1000),
  };
}

// Pages deployment via the documented Direct Upload contract, entirely through the official SDK.
//
// `client.pages.projects.deployments.create` sends a `multipart/form-data` request. The SDK's
// `createForm` serializes every body field: strings become text fields, and any `Uploadable`
// (File/Blob/Buffer/ReadStream) becomes a binary file field — exactly matching the curl form
// `-F "index.html=@dist/index.html"`. So we inline ALL files (regular assets + special files) as
// `File` fields in the same call that carries the `manifest`, and the SDK handles the multipart
// serialization for us. No non-public endpoints involved.
export async function deployPages(
  account: Account,
  projectName: string,
  files: Array<{ path: string; buffer: Buffer }>,
  skipCreateProject = false
): Promise<any> {
  const accountId = account.account_id;
  if (!accountId) throw new Error('Account ID is required');

  const cf = getCfClient(account);

  // 1. Create project if not exists (skip if skipCreateProject is true)
  if (!skipCreateProject) {
    try {
      await cf.pages.projects.create({ account_id: accountId, name: projectName, production_branch: 'main' } as any);
    } catch (e: any) {
      if (e?.status !== 409) throw e;  // 409 = already exists, ignore
    }
  }

  // 2. If no files, just create/return the (empty) project
  if (!files || files.length === 0) {
    appLogger.info(`[Pages Deploy] Created empty project: ${projectName}`);
    return await cf.pages.projects.get(projectName, { account_id: accountId! });
  }

  // 3. Normalize paths and separate special files from regular assets.
  //    Special files are uploaded under their fixed field name (e.g. `_worker.js`); they are NOT
  //    placed in the manifest. Regular assets are uploaded under their absolute path (leading
  //    slash, e.g. `/index.html`) and listed in the manifest (path -> content hash), matching
  //    wrangler's convention where the manifest key is `/${relativePath}`.
  const SPECIAL_FILES = new Set([
    '_worker.js', '_worker.bundle', '_headers', '_redirects', '_routes.json',
    'functions-filepath-routing-config.json',
  ]);

  const normalizedFiles = files.map(f => ({
    ...f,
    path: f.path.replace(/\\/g, '/').replace(/^\/+/, ''),
  }));

  const specialFiles: Array<{ path: string; buffer: Buffer }> = [];
  const assetFiles: Array<{ path: string; buffer: Buffer }> = [];

  for (const f of normalizedFiles) {
    const basename = f.path.split('/').pop() || f.path;
    if (!f.path.includes('/') && SPECIAL_FILES.has(basename)) {
      specialFiles.push(f);
    } else {
      // 普通资源路径加前导斜杠，与 wrangler 的 manifest key 约定一致（"/index.html"）。
      // 注意：manifest key 与 multipart 字段名都用同一个 f.path，必须保持同步。
      f.path = '/' + f.path;
      assetFiles.push(f);
    }
  }

  appLogger.info(`[Pages Deploy] Total: ${files.length} files | Assets: ${assetFiles.length} | Special: ${specialFiles.length}`);

  // 4. Build the manifest (relative path -> BLAKE3 content-addressing hash) for regular assets.
  //    This hash is the key into Pages' asset store, so it must match wrangler's BLAKE3 scheme.
  const manifest: Record<string, string> = {};
  for (const f of assetFiles) {
    manifest[f.path] = await computePageAssetHash(f.buffer, f.path);
  }
  appLogger.info(`[Pages Deploy] Manifest: ${JSON.stringify(manifest)}`);

  // 5. Build the SDK body. `DeploymentCreateParams` only types the special files + `manifest`, so we
  //    use a loose Record and cast at the call site; at runtime `createForm` forwards every field —
  //    strings as text, `File` values as binary multipart fields (identical to `-F "path=@file"`).
  const body: Record<string, unknown> = {
    account_id: accountId,
    manifest: JSON.stringify(manifest),
    branch: 'main',
    commit_hash: 'direct-upload',
    commit_message: 'Deploy via CF Manager (SDK)',
    commit_dirty: 'false',
  };

  // Regular assets: field name = relative path, value = binary File
  for (const f of assetFiles) {
    body[f.path] = new File([bufferToBlobPart(f.buffer)], f.path, { type: getContentType(f.path) });
  }

  // Special files: field name = fixed basename (mutually exclusive where required)
  for (const f of specialFiles) {
    const basename = f.path.split('/').pop() || f.path;
    body[basename] = new File([bufferToBlobPart(f.buffer)], basename, { type: getContentType(f.path) });
    appLogger.info(`[Pages Deploy] Special file: ${basename} (${f.buffer.length} bytes)`);
  }

  // 6. One call: inline all bytes + manifest → deployment. No intermediate asset upload needed.
  appLogger.info(`[Pages Deploy] Creating deployment via SDK | manifest entries: ${assetFiles.length} | special files: ${specialFiles.length}`);
  const depResult: any = await cf.pages.projects.deployments.create(projectName, body as any);

  appLogger.info(`[Pages Deploy] Deployment created: ${depResult?.url || '(no url)'}`);
  appLogger.info(`[Pages Deploy] Deployment env: ${depResult?.environment} | id: ${depResult?.id}`);
  appLogger.info(`[Pages Deploy] Deployment env_vars: ${JSON.stringify(depResult?.env_vars || {})}`);
  appLogger.info(`[Pages Deploy] Deployment kv_namespaces: ${JSON.stringify(depResult?.kv_namespaces || 'none')}`);
  return depResult;
}
