import type { Account } from '../db/models';
import { blake3 } from 'hash-wasm';
import { cfFetch, cfFetchRaw } from './cfApi';

// 演示/特殊文件：不进 manifest，单独作为 multipart 字段上传
const SPECIAL_FILES = new Set([
  '_worker.js', '_worker.bundle', '_headers', '_redirects',
  '_routes.json', 'functions-filepath-routing-config.json',
]);

// ============ ZIP 解包（纯 Web API，兼容 workerd，无需外部 zip 库）============
export async function extractZipFiles(zipData: Uint8Array): Promise<Array<{ path: string; buffer: Uint8Array }>> {
  const files: Array<{ path: string; buffer: Uint8Array }> = [];
  const view = new DataView(zipData.buffer, zipData.byteOffset, zipData.byteLength);

  let eocdOffset = -1;
  for (let i = zipData.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) return files;

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const cdEntries = view.getUint16(eocdOffset + 10, true);
  let pos = cdOffset;

  for (let i = 0; i < cdEntries; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const compression = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const uncompSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(zipData.slice(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;

    let fileData: Uint8Array;
    if (compression === 0) {
      fileData = zipData.slice(dataStart, dataStart + uncompSize);
    } else if (compression === 8) {
      const compressed = zipData.slice(dataStart, dataStart + compSize);
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(compressed);
      writer.close();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total = chunks.reduce((s, c) => s + c.length, 0);
      fileData = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { fileData.set(chunk, offset); offset += chunk.length; }
    } else {
      continue;
    }

    const cleanPath = name.replace(/\\/g, '/').replace(/^\/+/, '');
    files.push({ path: cleanPath, buffer: fileData });
  }
  return files;
}

// ============ BLAKE3 资产哈希（与 backend workerService.computePageAssetHash / wrangler 同款）============
//   hash = blake3(base64(content) + extension).hex().slice(0, 32)
// Cloudflare 资产存储按此算法内容寻址，必须与 backend 保持一致，否则运行时按 hash 取内容失败 → 404。
function pageAssetExtname(p: string): string {
  const base = p.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

export async function computePageAssetHash(buffer: Uint8Array, filePath: string): Promise<string> {
  const base64Contents = uint8ToBase64(buffer);
  const extension = pageAssetExtname(filePath).substring(1);
  const fullHash = await blake3(base64Contents + extension);
  return fullHash.slice(0, 32);
}

// ============ 统一 Pages 部署入口 ============
// 所有 Pages 部署（手动 / 批量 / Store）都走这里，避免多份不一致的实现。
// 与 backend services/workerService.deployPages 行为一致：
//   - 普通资源路径加前导斜杠（"/index.html"）
//   - manifest key 与 multipart 字段名同步且一致
//   - 哈希用 BLAKE3
export interface DeployPageFile { path: string; buffer: Uint8Array; }

export interface DeployPagesOptions {
  skipCreateProject?: boolean;
  productionBranch?: string;
  branch?: string;
  commitMessage?: string;
}

export async function deployPages(
  account: Account,
  encryptionKey: string,
  name: string,
  files: DeployPageFile[],
  opts: DeployPagesOptions = {},
): Promise<any> {
  if (!opts.skipCreateProject) {
    try {
      await cfFetch(account, `/accounts/${account.account_id}/pages/projects`, encryptionKey, {
        method: 'POST',
        body: JSON.stringify({ name, production_branch: opts.productionBranch || 'main' }),
      });
    } catch (e: any) {
      if (!e.body?.includes('already exists') && e.status !== 409) throw e;
    }
  }

  if (files.length === 0) return null;

  const manifest: Record<string, string> = {};
  const deployForm = new FormData();
  const specialFiles: Array<{ name: string; buffer: Uint8Array }> = [];

  for (const f of files) {
    const basename = f.path.split('/').pop() || f.path;
    if (SPECIAL_FILES.has(basename) && !f.path.includes('/')) {
      specialFiles.push({ name: basename, buffer: f.buffer });
    } else {
      // 普通资源路径加前导斜杠，与 wrangler / backend deployPages 约定一致（"/index.html"）；
      // manifest key 与 multipart 字段名必须同步且一致，哈希用 BLAKE3（与 backend 同款）。
      const assetPath = '/' + f.path;
      const hash = await computePageAssetHash(f.buffer, assetPath);
      manifest[assetPath] = hash;
      deployForm.append(assetPath, new Blob([f.buffer], { type: 'application/octet-stream' }), assetPath);
    }
  }

  deployForm.append('manifest', JSON.stringify(manifest));
  deployForm.append('branch', opts.branch || 'main');
  deployForm.append('commit_message', opts.commitMessage || 'Deploy via CF Manager');

  for (const sf of specialFiles) {
    deployForm.append(sf.name, new Blob([sf.buffer], { type: 'application/octet-stream' }), sf.name);
  }

  const resp = await cfFetchRaw(
    account,
    `/accounts/${account.account_id}/pages/projects/${name}/deployments`,
    encryptionKey,
    { method: 'POST', body: deployForm },
  );
  const result = await resp.json();
  if (!resp.ok) throw new Error(`Pages deploy failed: ${JSON.stringify(result)}`);
  return result;
}
