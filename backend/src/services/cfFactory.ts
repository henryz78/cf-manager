import Cloudflare from 'cloudflare';
import { Account } from '../models/account';
import { decrypt } from './encryptionService';
import { getHttpAgent } from './proxyService';

export function getAuthHeaders(account: Account): Record<string, string> {
  if (account.auth_type === 'token') {
    if (!account.api_token) throw new Error(`Account ${account.id} is missing api_token`);
    return { 'Authorization': `Bearer ${decrypt(account.api_token)}` };
  }
  if (!account.api_key) throw new Error(`Account ${account.id} is missing api_key`);
  if (!account.email) throw new Error(`Account ${account.id} is missing email`);
  return { 'X-Auth-Email': account.email, 'X-Auth-Key': decrypt(account.api_key) };
}

export function getCfClient(account: Account): Cloudflare {
  const httpAgent = getHttpAgent();
  const opts: Record<string, any> = {};
  if (httpAgent) opts.httpAgent = httpAgent;

  if (account.auth_type === 'token') {
    if (!account.api_token) throw new Error(`Account ${account.id} is missing api_token`);
    try {
      return new Cloudflare({ apiToken: decrypt(account.api_token), ...opts });
    } catch (err) {
      throw new Error(`Failed to decrypt credentials for account ${account.id}: ${err}`);
    }
  }
  if (!account.api_key) throw new Error(`Account ${account.id} is missing api_key`);
  if (!account.email) throw new Error(`Account ${account.id} is missing email`);
  try {
    return new Cloudflare({ apiKey: decrypt(account.api_key), apiEmail: account.email, ...opts });
  } catch (err) {
    throw new Error(`Failed to decrypt credentials for account ${account.id}: ${err}`);
  }
}

export function clearClientCache(): void {
  // No-op since we're not caching anymore
}
