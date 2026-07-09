import { getDb } from '../db';

export interface CatalogSource {
  id: number;
  url: string;
  name: string;
  is_default: number;
  enabled: number;
  last_synced: string | null;
  last_status: string;
  last_error: string | null;
  etag: string | null;
  created_at: string;
}

export function getCatalogSources(): CatalogSource[] {
  return getDb().prepare('SELECT * FROM catalog_sources ORDER BY is_default DESC, id ASC').all() as CatalogSource[];
}

export function getEnabledCatalogSources(): CatalogSource[] {
  return getDb().prepare('SELECT * FROM catalog_sources WHERE enabled = 1 ORDER BY is_default DESC, id ASC').all() as CatalogSource[];
}

export function getCatalogSourceById(id: number): CatalogSource | undefined {
  return getDb().prepare('SELECT * FROM catalog_sources WHERE id = ?').get(id) as CatalogSource | undefined;
}

export function getDefaultCatalogSource(): CatalogSource | undefined {
  return getDb().prepare('SELECT * FROM catalog_sources WHERE is_default = 1').get() as CatalogSource | undefined;
}

export function createCatalogSource(data: { url: string; name: string; is_default?: number }): number {
  const result = getDb().prepare(
    'INSERT INTO catalog_sources (url, name, is_default) VALUES (?, ?, ?)'
  ).run(data.url, data.name, data.is_default || 0);
  return Number(result.lastInsertRowid);
}

export function updateCatalogSource(id: number, data: Partial<CatalogSource>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined && key !== 'id' && key !== 'created_at') {
      sets.push(`${key} = ?`);
      vals.push(val);
    }
  }
  if (sets.length === 0) return;
  vals.push(id);
  getDb().prepare(`UPDATE catalog_sources SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function deleteCatalogSource(id: number): void {
  getDb().prepare('DELETE FROM catalog_sources WHERE id = ? AND is_default = 0').run(id);
}

export function ensureDefaultCatalogSource(url: string, name: string): void {
  const existing = getDefaultCatalogSource();
  if (!existing) {
    getDb().prepare('INSERT INTO catalog_sources (url, name, is_default) VALUES (?, ?, 1)').run(url, name);
  } else if (existing.url !== url || existing.name !== name) {
    // 代码常量已变更（如迁移到新仓库），同步修正已存在的默认源地址
    updateCatalogSource(existing.id, { url, name });
  }
}
