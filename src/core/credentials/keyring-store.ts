import { CliError } from '../errors.js';
import { KEYRING_HINT, KEYRING_SERVICE, PROFILE, type SecretStore } from './types.js';

function unavailable(cause: unknown): CliError {
  return new CliError('keyring_unavailable', 'No secure credential store is available on this system.', {
    hint: KEYRING_HINT,
    cause,
  });
}

async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw unavailable(cause);
  }
}

/**
 * Opens the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) through
 * `@napi-rs/keyring`, an optional dependency imported only here and only when needed.
 *
 * It fails loudly with `keyring_unavailable` instead of falling back to a file: when the native binding is
 * missing or the store cannot be read (checked with a `get` of the default profile), and on any later failure.
 * On Linux the entry is pinned to the Secret Service, because the other store (keyutils) is lost on reboot.
 */
export async function openKeyringStore(): Promise<SecretStore> {
  const keyring = await guard(() => import('@napi-rs/keyring'));
  const entry = (account: string) =>
    new keyring.AsyncEntry(KEYRING_SERVICE, account, { linux: { store: 'secret-service' } });

  const store: SecretStore = {
    kind: 'keyring',
    get: (account) => guard(async () => entry(account).getPassword()),
    set: (account, secret) => guard(async () => entry(account).setPassword(secret)),
    delete: (account) => guard(async () => entry(account).deleteCredential()),
  };
  await store.get(PROFILE);
  return store;
}
