import { Hono } from 'hono';
import type { Env } from '../types';
import {
  getCatalogSources, getEnabledCatalogSources, getCatalogSourceById,
  createCatalogSource, updateCatalogSource, deleteCatalogSource,
  ensureDefaultCatalogSource, getDefaultCatalogSource,
} from '../db/models';
import { validateCatalog, type Catalog, type CatalogTemplate } from '../services/catalogValidator';
import { deployTemplate } from '../services/catalogDeploy';
import { getAccountById } from '../db/models';

const app = new Hono<{ Bindings: Env }>();

const DEFAULT_CATALOG_URL = 'https://raw.githubusercontent.com/hefeiyu/cf-manager-catalog/main/catalog.json';
const DEFAULT_CATALOG_NAME = '官方源';

// ============ Source CRUD ============

app.get('/sources', async (c) => {
  const sources = await getCatalogSources(c.env.DB);
  return c.json(sources);
});

app.post('/sources', async (c) => {
  const { url, name } = await c.req.json();
  if (!url || !url.startsWith('https://')) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'url must be a valid HTTPS URL' } }, 400);
  }
  if (!name) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } }, 400);
  }

  // Fetch and validate before saving
  try {
    const resp = await fetch(url);
    if (!resp.ok) return c.json({ error: { code: 'FETCH_ERROR', message: `URL 不可达: ${resp.status}` } }, 400);
    const json = await resp.json();
    const result = validateCatalog(json);
    if (!result.valid) {
      return c.json({ error: { code: 'INVALID_CATALOG', message: `不是有效的 catalog: ${result.errors.join('; ')}` } }, 400);
    }
    const id = await createCatalogSource(c.env.DB, { url, name });
    // Cache the catalog in KV
    if (c.env.KV) {
      await c.env.KV.put(`catalog:${id}`, JSON.stringify(json));
    }
    const etag = resp.headers.get('etag');
    if (etag) await updateCatalogSource(c.env.DB, id, { etag, last_synced: new Date().toISOString(), last_status: 'ok', last_error: null });
    return c.json({ id }, 201);
  } catch (e: any) {
    return c.json({ error: { code: 'FETCH_ERROR', message: `拉取校验失败: ${e.message}` } }, 400);
  }
});

app.put('/sources/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const source = await getCatalogSourceById(c.env.DB, id);
  if (!source) return c.json({ error: { code: 'NOT_FOUND', message: 'Source not found' } }, 404);

  const body = await c.req.json();
  if (source.is_default && body.url && body.url !== source.url) {
    return c.json({ error: { code: 'FORBIDDEN', message: '默认源的 URL 不可修改' } }, 403);
  }

  // If URL changed, re-fetch and validate
  if (body.url && body.url !== source.url) {
    try {
      const resp = await fetch(body.url);
      if (!resp.ok) return c.json({ error: { code: 'FETCH_ERROR', message: `URL 不可达: ${resp.status}` } }, 400);
      const json = await resp.json();
      const result = validateCatalog(json);
      if (!result.valid) {
        return c.json({ error: { code: 'INVALID_CATALOG', message: `不是有效的 catalog: ${result.errors.join('; ')}` } }, 400);
      }
      if (c.env.KV) await c.env.KV.put(`catalog:${id}`, JSON.stringify(json));
      const etag = resp.headers.get('etag');
      await updateCatalogSource(c.env.DB, id, {
        ...body, etag: etag || null, last_synced: new Date().toISOString(), last_status: 'ok', last_error: null,
      });
    } catch (e: any) {
      return c.json({ error: { code: 'FETCH_ERROR', message: `拉取校验失败: ${e.message}` } }, 400);
    }
  } else {
    await updateCatalogSource(c.env.DB, id, body);
  }
  return c.json({ success: true });
});

app.delete('/sources/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await deleteCatalogSource(c.env.DB, id);
  if (c.env.KV) await c.env.KV.delete(`catalog:${id}`);
  return c.json({ success: true });
});

// ============ Catalog Fetch ============

async function fetchSourceCatalog(c: any, source: any): Promise<Catalog | null> {
  // Try KV cache first
  if (c.env.KV) {
    const cached = await c.env.KV.get(`catalog:${source.id}`);
    if (cached) {
      try { return JSON.parse(cached); } catch {}
    }
  }

  // Fetch from remote
  try {
    const headers: Record<string, string> = {};
    if (source.etag) headers['If-None-Match'] = source.etag;
    const resp = await fetch(source.url, { headers });

    if (resp.status === 304) {
      await updateCatalogSource(c.env.DB, source.id, {
        last_synced: new Date().toISOString(), last_status: 'ok', last_error: null,
      });
      // Return cached
      if (c.env.KV) {
        const cached = await c.env.KV.get(`catalog:${source.id}`);
        if (cached) return JSON.parse(cached);
      }
      return null;
    }

    if (!resp.ok) {
      await updateCatalogSource(c.env.DB, source.id, {
        last_status: 'error', last_error: `HTTP ${resp.status}`,
      });
      return null;
    }

    const json = await resp.json();
    const result = validateCatalog(json);
    if (!result.valid) {
      await updateCatalogSource(c.env.DB, source.id, {
        last_status: 'error', last_error: `Schema invalid: ${result.errors.slice(0, 3).join('; ')}`,
      });
      return null;
    }

    // Cache + update metadata
    if (c.env.KV) await c.env.KV.put(`catalog:${source.id}`, JSON.stringify(json));
    const etag = resp.headers.get('etag');
    await updateCatalogSource(c.env.DB, source.id, {
      etag: etag || null, last_synced: new Date().toISOString(),
      last_status: 'ok', last_error: null,
    });

    return json as Catalog;
  } catch (e: any) {
    await updateCatalogSource(c.env.DB, source.id, {
      last_status: 'error', last_error: e.message,
    });
    return null;
  }
}

// ============ Template List (merged + dedup) ============

app.get('/templates', async (c) => {
  const sources = await getEnabledCatalogSources(c.env.DB);

  // Fetch all source catalogs in parallel
  const results = await Promise.all(sources.map(s => fetchSourceCatalog(c, s)));

  // Dedup by id, priority: default source first, then by id ASC
  const seen = new Map<string, { template: CatalogTemplate; sourceId: number; sourceName: string; sourceCount: number }>();
  const idSources = new Map<string, number>();

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const catalog = results[i];
    if (!catalog || !catalog.templates) continue;

    for (const template of catalog.templates) {
      const existing = idSources.get(template.id) || 0;
      idSources.set(template.id, existing + 1);

      if (!seen.has(template.id)) {
        seen.set(template.id, {
          template, sourceId: source.id, sourceName: source.name, sourceCount: 0,
        });
      }
    }
  }

  // Update source counts
  for (const entry of seen.values()) {
    entry.sourceCount = idSources.get(entry.template.id) || 1;
  }

  const templates = Array.from(seen.values());
  return c.json({ templates, sources });
});

// ============ Force Refresh ============

app.post('/refresh', async (c) => {
  const sources = await getEnabledCatalogSources(c.env.DB);
  const results = await Promise.all(sources.map(async (s) => {
    // Force refresh: clear etag temporarily
    if (s.etag) await updateCatalogSource(c.env.DB, s.id, { etag: null });
    const cat = await fetchSourceCatalog(c, s);
    return { id: s.id, name: s.name, success: !!cat };
  }));
  return c.json(results);
});

// ============ Init default source ============

app.get('/init', async (c) => {
  await ensureDefaultCatalogSource(c.env.DB, DEFAULT_CATALOG_URL, DEFAULT_CATALOG_NAME);
  return c.json({ success: true });
});

// ============ Deploy ============

app.post('/deploy', async (c) => {
  const body = await c.req.json();
  const { accountId, templateId, name, bindingSelections, secretValues } = body;

  if (!accountId || !templateId || !name) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'accountId, templateId, name are required' } }, 400);
  }

  const account = await getAccountById(c.env.DB, accountId);
  if (!account) return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);

  // Find template from enabled sources
  const sources = await getEnabledCatalogSources(c.env.DB);
  let template: CatalogTemplate | null = null;
  for (const source of sources) {
    const catalog = await fetchSourceCatalog(c, source);
    if (catalog?.templates) {
      template = catalog.templates.find(t => t.id === templateId) || null;
      if (template) break;
    }
  }
  if (!template) return c.json({ error: { code: 'NOT_FOUND', message: 'Template not found' } }, 404);

  const result = await deployTemplate({
    account, encryptionKey: c.env.ENCRYPTION_KEY, template, name,
    bindingSelections: bindingSelections || {}, secretValues: secretValues || {},
    db: c.env.DB,
  });

  return c.json(result, result.success ? 200 : 500);
});

export default app;
export { fetchSourceCatalog, DEFAULT_CATALOG_URL, DEFAULT_CATALOG_NAME };
