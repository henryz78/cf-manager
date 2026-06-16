import { Account } from '../models/account';
import { getCfClient } from './cfFactory';

const acctId = (a: Account) => a.account_id!;

// ============ KV ============

export async function createKvNamespace(account: Account, title: string): Promise<any> {
  const cf = getCfClient(account);
  return cf.kv.namespaces.create({ account_id: acctId(account), title });
}

export async function deleteKvNamespace(account: Account, namespaceId: string): Promise<void> {
  const cf = getCfClient(account);
  await cf.kv.namespaces.delete(namespaceId, { account_id: acctId(account) });
}

export async function listKvKeys(
  account: Account, namespaceId: string,
  options?: { prefix?: string; cursor?: string; limit?: number }
): Promise<{ keys: any[]; cursor?: string }> {
  const cf = getCfClient(account);
  const page = await cf.kv.namespaces.keys.list(namespaceId, {
    account_id: acctId(account),
    prefix: options?.prefix,
    limit: options?.limit,
    cursor: options?.cursor,
  });
  return {
    keys: page.result ?? [],
    cursor: page.result_info?.cursor || undefined,
  };
}

export async function getKvValue(account: Account, namespaceId: string, key: string): Promise<{ value: string; metadata: any }> {
  const cf = getCfClient(account);
  const [valueResp, metaResult] = await Promise.all([
    cf.kv.namespaces.values.get(namespaceId, key, { account_id: acctId(account) }),
    cf.kv.namespaces.metadata.get(namespaceId, key, { account_id: acctId(account) }).catch(() => null),
  ]);
  const value = await valueResp.text();
  return { value, metadata: metaResult };
}

export async function putKvValue(
  account: Account, namespaceId: string, key: string, value: string,
  options?: { expiration?: number; expiration_ttl?: number; metadata?: any }
): Promise<void> {
  const cf = getCfClient(account);
  await cf.kv.namespaces.values.update(namespaceId, key, {
    account_id: acctId(account),
    value,
    expiration: options?.expiration,
    expiration_ttl: options?.expiration_ttl,
    metadata: options?.metadata,
  });
}

export async function deleteKvKey(account: Account, namespaceId: string, key: string): Promise<void> {
  const cf = getCfClient(account);
  await cf.kv.namespaces.values.delete(namespaceId, key, { account_id: acctId(account) });
}

export async function bulkDeleteKvKeys(account: Account, namespaceId: string, keys: string[]): Promise<void> {
  const cf = getCfClient(account);
  await cf.kv.namespaces.bulkDelete(namespaceId, { account_id: acctId(account), body: keys });
}

// ============ D1 ============

async function d1Query(account: Account, databaseId: string, sql: string): Promise<any> {
  const cf = getCfClient(account);
  const page = await cf.d1.database.query(databaseId, { account_id: acctId(account), sql });
  const items = page.getPaginatedItems();
  return items[0] ?? { results: [], meta: {} };
}

export async function listD1Tables(account: Account, databaseId: string): Promise<any[]> {
  const qr = await d1Query(account, databaseId,
    "SELECT name, type FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
  );
  return qr.results ?? [];
}

export async function getD1TableSchema(account: Account, databaseId: string, tableName: string): Promise<any[]> {
  const safeName = tableName.replace(/[^a-zA-Z0-9_]/g, '');
  const qr = await d1Query(account, databaseId, `PRAGMA table_info(${safeName})`);
  return qr.results ?? [];
}

export async function executeD1Query(account: Account, databaseId: string, sql: string): Promise<any> {
  return d1Query(account, databaseId, sql);
}

export async function createD1Database(account: Account, name: string): Promise<any> {
  const cf = getCfClient(account);
  return cf.d1.database.create({ account_id: acctId(account), name });
}

export async function deleteD1Database(account: Account, databaseId: string): Promise<void> {
  const cf = getCfClient(account);
  await cf.d1.database.delete(databaseId, { account_id: acctId(account) });
}

// ============ R2 ============

export async function createR2Bucket(account: Account, name: string): Promise<any> {
  const cf = getCfClient(account);
  return cf.r2.buckets.create({ account_id: acctId(account), name });
}

export async function deleteR2Bucket(account: Account, name: string): Promise<void> {
  const cf = getCfClient(account);
  await cf.r2.buckets.delete(name, { account_id: acctId(account) });
}

export async function listR2Objects(
  account: Account, bucketName: string,
  options?: { prefix?: string; delimiter?: string; cursor?: string; limit?: number }
): Promise<{ objects: any[]; delimited_prefixes: string[]; cursor?: string }> {
  const cf = getCfClient(account);
  const page = await cf.r2.buckets.objects.list(bucketName, {
    account_id: acctId(account),
    prefix: options?.prefix,
    delimiter: options?.delimiter,
    cursor: options?.cursor,
    per_page: options?.limit,
  });
  const info = page.result_info as any;
  return {
    objects: page.result ?? [],
    delimited_prefixes: info?.delimited ?? [],
    cursor: info?.cursor || undefined,
  };
}

export async function getR2Object(account: Account, bucketName: string, key: string): Promise<Response> {
  const cf = getCfClient(account);
  return cf.r2.buckets.objects.get(bucketName, key, { account_id: acctId(account) }) as unknown as Response;
}

export async function putR2Object(account: Account, bucketName: string, key: string, body: Buffer, contentType?: string): Promise<void> {
  const cf = getCfClient(account);
  await cf.r2.buckets.objects.upload(bucketName, key, body, { account_id: acctId(account) });
}

export async function deleteR2Object(account: Account, bucketName: string, key: string): Promise<void> {
  const cf = getCfClient(account);
  await cf.r2.buckets.objects.delete(bucketName, key, { account_id: acctId(account) });
}

export async function bulkDeleteR2Objects(account: Account, bucketName: string, keys: string[]): Promise<void> {
  const BATCH_SIZE = 10;
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(key => deleteR2Object(account, bucketName, key)));
  }
}
