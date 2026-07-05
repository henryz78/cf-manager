export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface CatalogTemplate {
  id: string;
  name: string;
  description?: string;
  author?: { name: string; url?: string };
  version: string;
  tags?: string[];
  icon?: string;
  homepage?: string;
  readmeUrl?: string;
  type: 'worker' | 'pages';
  source: {
    kind: 'raw' | 'release' | 'repo-archive';
    url: string;
    assetName?: string;
    subPath?: string;
    size?: number;
  };
  bindings?: CatalogBinding[];
  env?: Record<string, string>;
  routes?: string[];
}

export interface CatalogBinding {
  type: 'kv' | 'd1' | 'r2' | 'ai' | 'var';
  name: string;
  title?: string;
  action?: 'create-or-reuse' | 'prompt';
  required?: boolean;
  initSqlUrl?: string;
  initSql?: string;
}

export interface Catalog {
  version: string;
  updated?: string;
  name?: string;
  defaultLanguage?: string;
  templates: CatalogTemplate[];
}

const SLUG_RE = /^[a-z0-9-]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const VALID_TYPES = ['worker', 'pages'];
const VALID_KINDS = ['raw', 'release', 'repo-archive'];
const VALID_BINDING_TYPES = ['kv', 'd1', 'r2', 'ai', 'var'];

export function validateCatalog(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const cat = raw as Record<string, unknown>;
  if (!cat || typeof cat !== 'object') {
    return { valid: false, errors: ['Catalog is not an object'] };
  }
  if (!cat.version) errors.push('Missing top-level "version" field');
  if (!Array.isArray(cat.templates)) {
    errors.push('Missing or invalid "templates" array');
    return { valid: false, errors };
  }

  const ids = new Set<string>();
  const templates = cat.templates as unknown[];
  for (let i = 0; i < templates.length; i++) {
    const r = validateTemplate(templates[i]);
    if (!r.valid) {
      errors.push(...r.errors.map(e => `Template[${i}]: ${e}`));
    } else {
      const t = templates[i] as CatalogTemplate;
      if (ids.has(t.id)) {
        errors.push(`Template[${i}]: duplicate id "${t.id}"`);
      }
      ids.add(t.id);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateTemplate(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const t = raw as CatalogTemplate;
  if (!t || typeof t !== 'object') {
    return { valid: false, errors: ['Template is not an object'] };
  }

  // Required fields
  if (!t.id || !SLUG_RE.test(t.id)) errors.push('id must be non-empty slug (^[a-z0-9-]+$)');
  if (!t.name) errors.push('name is required');
  if (!t.version || !SEMVER_RE.test(t.version)) errors.push('version must be semver (^\\d+\\.\\d+\\.\\d+$)');
  if (!VALID_TYPES.includes(t.type)) errors.push(`type must be one of ${VALID_TYPES.join(', ')}`);

  // Source
  if (!t.source) {
    errors.push('source is required');
  } else {
    if (!VALID_KINDS.includes(t.source.kind)) errors.push(`source.kind must be one of ${VALID_KINDS.join(', ')}`);
    const isLocal = t.source.url.startsWith('http://localhost:') || t.source.url.startsWith('http://127.0.0.1:');
    if (!t.source.url || (!t.source.url.startsWith('https://') && !isLocal)) errors.push('source.url must be a valid HTTPS URL');
    // type + kind compatibility
    if (t.type === 'pages' && t.source.kind === 'raw') errors.push('pages type cannot use raw source (Pages needs zip)');
    if (t.type === 'worker' && t.source.kind === 'repo-archive') errors.push('worker type cannot use repo-archive source (single script only)');
  }

  // Bindings
  if (t.bindings) {
    const names = new Set<string>();
    for (let i = 0; i < t.bindings.length; i++) {
      const b = t.bindings[i];
      const prefix = `bindings[${i}]`;
      if (!VALID_BINDING_TYPES.includes(b.type)) errors.push(`${prefix}.type must be one of ${VALID_BINDING_TYPES.join(', ')}`);
      if (!b.name || !VAR_NAME_RE.test(b.name)) errors.push(`${prefix}.name must match ^[A-Z][A-Z0-9_]*$`);
      if (names.has(b.name)) errors.push(`${prefix}: duplicate binding name "${b.name}"`);
      names.add(b.name);
      if (b.initSqlUrl && b.type !== 'd1') errors.push(`${prefix}: initSqlUrl only valid on d1 bindings`);
      if (b.initSql && b.type !== 'd1') errors.push(`${prefix}: initSql only valid on d1 bindings`);
    }

    // env keys vs binding names
    if (t.env) {
      for (const key of Object.keys(t.env)) {
        if (names.has(key)) errors.push(`env key "${key}" conflicts with binding name`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
