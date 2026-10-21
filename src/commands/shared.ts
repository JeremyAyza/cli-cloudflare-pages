import type { Session } from '../core/session.js';
import { PagesApi } from '../providers/pages/api.js';

/** The Pages API client of this session and the account it works on. Rejects like `session.credentials()` without a login. */
export async function pagesApi(s: Session): Promise<{ api: PagesApi; accountId: string }> {
  const creds = await s.credentials();
  return { api: new PagesApi(await s.client(), creds.accountId), accountId: creds.accountId };
}
