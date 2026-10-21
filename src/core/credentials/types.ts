/** Where an API token is kept. `get` returns null when there is no secret for the account. */
export interface SecretStore {
  readonly kind: 'keyring' | 'file';
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  /** True when there was a secret to delete. */
  delete(account: string): Promise<boolean>;
}

export type CredentialSource = 'env' | 'keyring' | 'file';

/** What a command needs to talk to the API. The fields after `source` only exist for a stored login. */
export interface Credentials {
  token: string;
  accountId: string;
  label: string;
  source: CredentialSource;
  storage?: 'keyring' | 'file';
  tokenType?: 'user' | 'account';
  tokenExpiresOn?: string;
}

export const KEYRING_SERVICE = 'cf-pages';

/** The only profile in v1. It is the keyring account, the key in `credentials.json` and the section of `config.json`. */
export const PROFILE = 'default';

export const KEYRING_HINT =
  'Set CF_PAGES_API_TOKEN and CF_PAGES_ACCOUNT_ID, or run `cf-pages login --insecure-storage` to store the token in a 0600 file.';
