import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { classifyToken, verifyToken } from '../../src/core/credentials/token.js';
import { ApiClient } from '../../src/core/http/client.js';
import { ACCT, cfUrl, fail, ok, recordRequests } from '../helpers/cf.js';
import { server } from '../setup.js';

const USER_VERIFY = cfUrl('/user/tokens/verify');
const ACCOUNT_VERIFY = cfUrl(`/accounts/${ACCT}/tokens/verify`);

function client(token = 'cfat_test_token_value_1234567890'): ApiClient {
  return new ApiClient({ token, userAgent: 'cf-pages/test', sleep: async () => {} });
}

const calls = (requests: { method: string; path: string }[]) => requests.map((r) => `${r.method} ${r.path}`);

describe('classifyToken', () => {
  it('tells user, account and global keys apart by prefix or shape', () => {
    expect(classifyToken('cfut_x')).toBe('user');
    expect(classifyToken('cfat_x')).toBe('account');
    expect(classifyToken('cfk_x')).toBe('global_key');
    expect(classifyToken('a'.repeat(37))).toBe('global_key');
    expect(classifyToken('legacy-token')).toBe('unknown');
  });

  it('only a lowercase hex string of exactly 37 characters is a legacy global key', () => {
    expect(classifyToken('a'.repeat(36))).toBe('unknown');
    expect(classifyToken('a'.repeat(38))).toBe('unknown');
    expect(classifyToken('A'.repeat(37))).toBe('unknown');
    expect(classifyToken('g'.repeat(37))).toBe('unknown');
    expect(classifyToken('0123456789abcdef0123456789abcdef01234')).toBe('global_key');
  });

  it('a prefix wins over the legacy shape', () => {
    expect(classifyToken(`cfut_${'a'.repeat(32)}`)).toBe('user');
  });
});

describe('verifyToken', () => {
  it('user → GET /user/tokens/verify only', async () => {
    const requests = recordRequests();
    server.use(
      http.get(USER_VERIFY, () => ok({ id: 't1', status: 'active', expires_on: '2027-01-01T00:00:00Z' })),
      http.get(ACCOUNT_VERIFY, () => fail(500, 1, 'must not be called')),
    );
    await expect(verifyToken(client(), ACCT, 'user')).resolves.toEqual({
      tokenType: 'user',
      status: 'active',
      expiresOn: '2027-01-01T00:00:00Z',
    });
    expect(calls(requests)).toEqual(['GET /user/tokens/verify']);
  });

  it('account → GET /accounts/{acct}/tokens/verify only', async () => {
    const requests = recordRequests();
    server.use(http.get(ACCOUNT_VERIFY, () => ok({ id: 't1', status: 'active' })));
    await expect(verifyToken(client(), ACCT, 'account')).resolves.toEqual({ tokenType: 'account', status: 'active' });
    expect(calls(requests)).toEqual([`GET /accounts/${ACCT}/tokens/verify`]);
  });

  it('reports a status other than active as it is, without failing', async () => {
    server.use(http.get(ACCOUNT_VERIFY, () => ok({ id: 't1', status: 'disabled' })));
    await expect(verifyToken(client(), ACCT, 'account')).resolves.toMatchObject({ status: 'disabled' });
  });

  it('leaves expiresOn out when the token has no expiry', async () => {
    server.use(http.get(ACCOUNT_VERIFY, () => ok({ id: 't1', status: 'active', expires_on: null })));
    const verified = await verifyToken(client(), ACCT, 'account');
    expect(verified).toEqual({ tokenType: 'account', status: 'active' });
    expect('expiresOn' in verified).toBe(false);
  });

  it('unprefixed token: user verify code 1000 → account verify', async () => {
    const requests = recordRequests();
    server.use(
      http.get(USER_VERIFY, () => fail(401, 1000, 'Invalid API Token')),
      http.get(ACCOUNT_VERIFY, () => ok({ id: 't1', status: 'active', expires_on: '2027-02-02T00:00:00Z' })),
    );
    await expect(verifyToken(client('legacy-token'), ACCT, 'unknown')).resolves.toEqual({
      tokenType: 'account',
      status: 'active',
      expiresOn: '2027-02-02T00:00:00Z',
    });
    expect(calls(requests)).toEqual(['GET /user/tokens/verify', `GET /accounts/${ACCT}/tokens/verify`]);
  });

  it('unprefixed token that the user endpoint accepts stays a user token', async () => {
    const requests = recordRequests();
    server.use(http.get(USER_VERIFY, () => ok({ id: 't1', status: 'active' })));
    await expect(verifyToken(client('legacy-token'), ACCT, 'unknown')).resolves.toEqual({
      tokenType: 'user',
      status: 'active',
    });
    expect(calls(requests)).toEqual(['GET /user/tokens/verify']);
  });

  it('unprefixed token: a user verify error other than 1000 is not retried against the account', async () => {
    const requests = recordRequests();
    server.use(
      http.get(USER_VERIFY, () => fail(403, 9109, 'Unauthorized to access requested resource')),
      http.get(ACCOUNT_VERIFY, () => ok({ id: 't1', status: 'active' })),
    );
    await expect(verifyToken(client('legacy-token'), ACCT, 'unknown')).rejects.toMatchObject({
      code: 'permission_denied',
    });
    expect(calls(requests)).toEqual(['GET /user/tokens/verify']);
  });

  it('unprefixed token that neither endpoint accepts fails with the account verify error', async () => {
    server.use(
      http.get(USER_VERIFY, () => fail(401, 1000, 'Invalid API Token')),
      http.get(ACCOUNT_VERIFY, () => fail(401, 1000, 'Invalid API Token')),
    );
    await expect(verifyToken(client('legacy-token'), ACCT, 'unknown')).rejects.toMatchObject({
      code: 'auth_invalid',
    });
  });

  it('a prefixed token is never tried against the other endpoint', async () => {
    const requests = recordRequests();
    server.use(
      http.get(USER_VERIFY, () => fail(401, 1000, 'Invalid API Token')),
      http.get(ACCOUNT_VERIFY, () => ok({ id: 't1', status: 'active' })),
    );
    await expect(verifyToken(client('cfut_abc'), ACCT, 'user')).rejects.toMatchObject({ code: 'auth_invalid' });
    expect(calls(requests)).toEqual(['GET /user/tokens/verify']);
  });
});
