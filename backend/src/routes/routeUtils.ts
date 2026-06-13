import { Request, Response } from 'express';
import { getAccountById, Account } from '../models/account';

export function getAccountOr404(req: Request, res: Response): Account | null {
  const account = getAccountById(parseInt(req.params.accountId as string, 10));
  if (!account) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } });
    return null;
  }
  return account;
}
