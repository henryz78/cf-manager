import { getActiveAccounts, hasFeature, getAllQuotaToday, setQuota, incrementQuota, getQuotaByAccount, type Account, type AccountFeature } from '../db/models';
import { cfGraphQL } from './cfApi';

export type ResourceType = 'workers_requests' | 'ai_neurons' | 'browser_render_seconds';

const LIMITS: Record<string, number> = {
  workers_requests: 100000,
  ai_neurons: 10000,
  browser_render_seconds: 600,
};

const RESOURCE_FEATURE: Record<ResourceType, AccountFeature> = {
  workers_requests: 'workers',
  ai_neurons: 'ai',
  browser_render_seconds: 'browser_render',
};

export async function trackUsage(db: D1Database, accountId: number, resource: ResourceType, amount = 1): Promise<void> {
  await incrementQuota(db, accountId, resource, amount);
}

export async function syncUsageFromCloudflare(db: D1Database, encryptionKey: string): Promise<void> {
  const accounts = await getActiveAccounts(db);

  await Promise.all(accounts.map(async (account) => {
    if (hasFeature(account, 'ai')) {
      try {
        const usage = await getAiUsageToday(account, encryptionKey);
        await setQuota(db, account.id, 'ai_neurons', Math.round(usage.totalNeurons));
      } catch (e) {
        console.error(`[Sync] AI usage failed for ${account.name}: ${e}`);
      }
    }
    if (hasFeature(account, 'workers')) {
      try {
        const usage = await getWorkersUsageToday(account, encryptionKey);
        await setQuota(db, account.id, 'workers_requests', usage.requests);
      } catch (e) {
        console.error(`[Sync] Workers usage failed for ${account.name}: ${e}`);
      }
    }
  }));
}

export async function getQuotaSummary(db: D1Database, encryptionKey: string) {
  const accounts = await getActiveAccounts(db);
  const usage = await getAllQuotaToday(db);
  const resourceTypes = Object.keys(LIMITS) as ResourceType[];

  return accounts.map(account => {
    const resources = resourceTypes
      .filter(r => hasFeature(account, RESOURCE_FEATURE[r]))
      .map(resource => {
        const row = usage.find(u => u.account_id === account.id && u.resource === resource);
        const count = row?.count || 0;
        const limit = LIMITS[resource];
        return { resource, count, limit, remaining: Math.max(0, limit - count) };
      });
    return { accountId: account.id, accountName: account.name, resources };
  });
}

export async function getAccountQuota(db: D1Database, accountId: number, resource: ResourceType): Promise<{ used: number; remaining: number }> {
  const usage = await getQuotaByAccount(db, accountId, resource);
  const used = usage?.count || 0;
  const limit = LIMITS[resource] || 0;
  return { used, remaining: Math.max(0, limit - used) };
}

export async function selectBestAccount(db: D1Database, encryptionKey: string, resource: ResourceType): Promise<Account | null> {
  const featureMap: Record<ResourceType, AccountFeature> = { workers_requests: 'workers', ai_neurons: 'ai', browser_render_seconds: 'browser_render' };
  const accounts = (await getActiveAccounts(db)).filter(a => hasFeature(a, featureMap[resource]));
  if (accounts.length === 0) return null;

  if (resource === 'ai_neurons') {
    const results = await Promise.all(accounts.map(async (account) => {
      try {
        const usage = await getAiUsageToday(account, encryptionKey);
        return { account, remaining: LIMITS.ai_neurons - usage.totalNeurons };
      } catch {
        return { account, remaining: 0 };
      }
    }));
    results.sort((a, b) => b.remaining - a.remaining);
    return results[0]?.account || null;
  }

  let best: Account | null = null;
  let bestRemaining = -1;
  for (const account of accounts) {
    const { remaining } = await getAccountQuota(db, account.id, resource);
    if (remaining > bestRemaining) { bestRemaining = remaining; best = account; }
  }
  return best;
}

interface AiUsage { totalNeurons: number; models: { modelId: string; neurons: number; requests: number }[] }

async function getAiUsageToday(account: Account, encryptionKey: string): Promise<AiUsage> {
  if (!account.account_id) return { totalNeurons: 0, models: [] };
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const end = now.toISOString();

  const query = `query($accountTag:string!,$start:Time!,$end:Time!){viewer{accounts(filter:{accountTag:$accountTag}){total:aiInferenceAdaptiveGroups(filter:{datetime_geq:$start,datetime_leq:$end},limit:1){sum{totalNeurons}}byModel:aiInferenceAdaptiveGroups(filter:{datetime_geq:$start,datetime_leq:$end},limit:100,orderBy:[sum_totalNeurons_DESC]){count,sum{totalNeurons},dimensions{modelId}}}}}`;

  try {
    const json = await cfGraphQL(account, query, { accountTag: account.account_id, start, end }, encryptionKey);
    const acct = json?.data?.viewer?.accounts?.[0];
    const totalNeurons = acct?.total?.[0]?.sum?.totalNeurons || 0;
    const models = (acct?.byModel || [])
      .filter((r: any) => r.dimensions?.modelId)
      .map((r: any) => ({ modelId: r.dimensions.modelId, neurons: r.sum?.totalNeurons || 0, requests: r.count || 0 }));
    return { totalNeurons: Math.round(totalNeurons), models };
  } catch (e) {
    console.error(`[AI Usage] Failed for ${account.name}: ${e}`);
    return { totalNeurons: 0, models: [] };
  }
}

interface WorkersUsage { requests: number; errors: number; subrequests: number; cpuTimeMs: number }

async function getWorkersUsageToday(account: Account, encryptionKey: string): Promise<WorkersUsage> {
  if (!account.account_id) return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
  const now = new Date();
  const todayDate = now.toISOString().substring(0, 10);
  const datetimeStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const datetimeEnd = now.toISOString();

  const query = `query($accountTag:string!,$datetimeStart:Time!,$datetimeEnd:Time!,$todayDate:Date!){viewer{accounts(filter:{accountTag:$accountTag}){workers:workersInvocationsAdaptive(filter:{datetime_geq:$datetimeStart,datetime_leq:$datetimeEnd},limit:10000){sum{requests,errors,subrequests,cpuTimeUs}}pages:pagesFunctionsInvocationsAdaptiveGroups(filter:{date:$todayDate},limit:1){sum{requests,errors}}}}}`;

  try {
    const json = await cfGraphQL(account, query, { accountTag: account.account_id, datetimeStart, datetimeEnd, todayDate }, encryptionKey);
    const acct = json?.data?.viewer?.accounts?.[0];
    const workerRecs = acct?.workers || [];
    const pagesRecs = acct?.pages || [];
    let requests = 0, errors = 0, subrequests = 0, cpuTimeUs = 0;
    for (const r of workerRecs) { requests += r.sum?.requests || 0; errors += r.sum?.errors || 0; subrequests += r.sum?.subrequests || 0; cpuTimeUs += r.sum?.cpuTimeUs || 0; }
    for (const r of pagesRecs) { requests += r.sum?.requests || 0; errors += r.sum?.errors || 0; }
    return { requests, errors, subrequests, cpuTimeMs: Math.round(cpuTimeUs / 1000) };
  } catch (e) {
    console.error(`[Workers Usage] Failed for ${account.name}: ${e}`);
    return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
  }
}

export { getAiUsageToday, getWorkersUsageToday };
