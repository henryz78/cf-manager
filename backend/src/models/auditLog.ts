import { getDb } from '../db';

export interface AuditLog {
  id: number;
  account_id: number | null;
  action: string;
  target: string | null;
  detail: string | null;
  status: 'success' | 'error';
  created_at: string;
}

export function createAuditLog(
  accountId: number | null,
  action: string,
  target: string | null,
  detail: string | null,
  status: 'success' | 'error'
): void {
  getDb()
    .prepare('INSERT INTO audit_log (account_id, action, target, detail, status) VALUES (?, ?, ?, ?, ?)')
    .run(accountId, action, target, detail, status);
}

export interface AuditLogWithName extends AuditLog {
  account_name: string | null;
}

export function getRecentLogs(limit: number = 20): AuditLogWithName[] {
  return getDb()
    .prepare(
      `SELECT a.*, acc.name AS account_name
       FROM audit_log a
       LEFT JOIN accounts acc ON a.account_id = acc.id
       ORDER BY a.created_at DESC LIMIT ?`
    )
    .all(limit) as AuditLogWithName[];
}
