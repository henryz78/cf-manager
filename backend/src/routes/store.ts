import { Router, Request, Response, NextFunction } from 'express';
import {
  getCatalogSources, getEnabledCatalogSources, getCatalogSourceById,
  createCatalogSource, updateCatalogSource, deleteCatalogSource, ensureDefaultCatalogSource,
} from '../models/catalogSource';
import { validateCatalog, Catalog, CatalogTemplate } from '../services/catalogValidator';
import { deployTemplate } from '../services/catalogDeploy';
import { getAccountById } from '../models/account';
import { appLogger } from '../services/logger';

const DEFAULT_CATALOG_URL = 'https://raw.githubusercontent.com/hefeiyu/cf-manager-catalog/main/catalog.json';
const DEFAULT_CATALOG_NAME = '官方源';

const router = Router();

// In-memory catalog cache for Docker version
const catalogCache = new Map<number, Catalog>();

// ============ Source CRUD ============

router.get('/sources', (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(getCatalogSources());
  } catch (err) { next(err); }
});

router.post('/sources', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url, name } = req.body;
    if (!url || !url.startsWith('https://')) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'url must be a valid HTTPS URL' } });
      return;
    }
    if (!name) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } });
      return;
    }
    const resp = await fetch(url);
    if (!resp.ok) { res.status(400).json({ error: { code: 'FETCH_ERROR', message: `URL 不可达: ${resp.status}` } }); return; }
    const json: Catalog = await resp.json() as Catalog;
    const result = validateCatalog(json);
    if (!result.valid) {
      res.status(400).json({ error: { code: 'INVALID_CATALOG', message: `不是有效的 catalog: ${result.errors.join('; ')}` } });
      return;
    }
    const id = createCatalogSource({ url, name });
    catalogCache.set(id, json);
    const etag = resp.headers.get('etag') as string | null;
    if (etag) updateCatalogSource(id, { etag, last_synced: new Date().toISOString(), last_status: 'ok', last_error: null });
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

router.put('/sources/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const source = getCatalogSourceById(id);
    if (!source) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Source not found' } }); return; }
    const body = req.body;
    if (source.is_default && body.url && body.url !== source.url) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: '默认源的 URL 不可修改' } });
      return;
    }
    if (body.url && body.url !== source.url) {
      const resp = await fetch(body.url);
      if (!resp.ok) { res.status(400).json({ error: { code: 'FETCH_ERROR', message: `URL 不可达: ${resp.status}` } }); return; }
      const json: Catalog = await resp.json() as Catalog;
      const result = validateCatalog(json);
      if (!result.valid) {
        res.status(400).json({ error: { code: 'INVALID_CATALOG', message: `不是有效的 catalog: ${result.errors.join('; ')}` } });
        return;
      }
      catalogCache.set(id, json);
      const etag = resp.headers.get('etag') as string | null;
      updateCatalogSource(id, { ...body, etag: etag || null, last_synced: new Date().toISOString(), last_status: 'ok', last_error: null });
    } else {
      updateCatalogSource(id, body);
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete('/sources/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    deleteCatalogSource(id);
    catalogCache.delete(id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============ Catalog Fetch ============

async function fetchSourceCatalog(source: any): Promise<Catalog | null> {
  // Check cache
  const cached = catalogCache.get(source.id);
  if (cached) {
    // Try refresh in background
    refreshSourceInBackground(source).catch(e => appLogger.error(`[Store] refresh ${source.id}: ${e}`));
    return cached;
  }
  return refreshSource(source);
}

async function refreshSource(source: any): Promise<Catalog | null> {
  try {
    const headers: Record<string, string> = {};
    if (source.etag) headers['If-None-Match'] = source.etag;
    const resp = await fetch(source.url, { headers });
    if (resp.status === 304) {
      updateCatalogSource(source.id, { last_synced: new Date().toISOString(), last_status: 'ok', last_error: null });
      return catalogCache.get(source.id) || null;
    }
    if (!resp.ok) {
      updateCatalogSource(source.id, { last_status: 'error', last_error: `HTTP ${resp.status}` });
      return catalogCache.get(source.id) || null;
    }
    const json: Catalog = await resp.json() as Catalog;
    const result = validateCatalog(json);
    if (!result.valid) {
      updateCatalogSource(source.id, { last_status: 'error', last_error: `Schema invalid: ${result.errors.slice(0, 3).join('; ')}` });
      return catalogCache.get(source.id) || null;
    }
    catalogCache.set(source.id, json);
    const etag = resp.headers.get('etag') as string | null;
    updateCatalogSource(source.id, { etag: etag || null, last_synced: new Date().toISOString(), last_status: 'ok', last_error: null });
    return json;
  } catch (e: any) {
    updateCatalogSource(source.id, { last_status: 'error', last_error: e.message });
    return catalogCache.get(source.id) || null;
  }
}

async function refreshSourceInBackground(source: any): Promise<void> {
  // Only refresh if last sync was > 5 minutes ago
  if (source.last_synced) {
    const age = Date.now() - new Date(source.last_synced).getTime();
    if (age < 5 * 60 * 1000) return;
  }
  await refreshSource(source);
}

// ============ Template List ============

router.get('/templates', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const sources = getEnabledCatalogSources();
    const results = await Promise.all(sources.map(s => fetchSourceCatalog(s)));

    const seen = new Map<string, { template: CatalogTemplate; sourceId: number; sourceName: string; sourceCount: number }>();
    const idSources = new Map<string, number>();

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      const catalog = results[i];
      if (!catalog?.templates) continue;
      for (const template of catalog.templates) {
        const count = idSources.get(template.id) || 0;
        idSources.set(template.id, count + 1);
        if (!seen.has(template.id)) {
          seen.set(template.id, { template, sourceId: source.id, sourceName: source.name, sourceCount: 0 });
        }
      }
    }
    for (const entry of seen.values()) {
      entry.sourceCount = idSources.get(entry.template.id) || 1;
    }
    res.json({ templates: Array.from(seen.values()), sources });
  } catch (err) { next(err); }
});

// ============ Refresh ============

router.post('/refresh', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const sources = getEnabledCatalogSources();
    const results = await Promise.all(sources.map(async (s) => {
      if (s.etag) updateCatalogSource(s.id, { etag: null });
      const cat = await refreshSource(s);
      return { id: s.id, name: s.name, success: !!cat };
    }));
    res.json(results);
  } catch (err) { next(err); }
});

// ============ Init ============

router.get('/init', (_req: Request, res: Response) => {
  ensureDefaultCatalogSource(DEFAULT_CATALOG_URL, DEFAULT_CATALOG_NAME);
  res.json({ success: true });
});

// ============ Deploy ============

router.post('/deploy', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, templateId, name, bindingSelections, secretValues } = req.body;
    if (!accountId || !templateId || !name) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'accountId, templateId, name are required' } });
      return;
    }
    const account = getAccountById(parseInt(accountId, 10));
    if (!account) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }); return; }

    const sources = getEnabledCatalogSources();
    let template: CatalogTemplate | null = null;
    for (const source of sources) {
      const catalog = await fetchSourceCatalog(source);
      if (catalog?.templates) {
        template = catalog.templates.find(t => t.id === templateId) || null;
        if (template) break;
      }
    }
    if (!template) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Template not found' } }); return; }

    const result = await deployTemplate({
      account, template, name,
      bindingSelections: bindingSelections || {},
      secretValues: secretValues || {},
    });
    res.status(result.success ? 200 : 500).json(result);
  } catch (err) { next(err); }
});

export default router;
export { refreshSource as refreshCatalogSource, DEFAULT_CATALOG_URL, DEFAULT_CATALOG_NAME };
