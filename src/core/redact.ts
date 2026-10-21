const REDACTED = '[redacted]';
const MIN_SECRET_LENGTH = 4;
const BEARER_PATTERN = /Bearer\s+\S+/g;
const CF_TOKEN_PATTERN = /\bcf(?:ut|at|k)_[A-Za-z0-9_-]+/g;

export interface Redactor {
  /** Registers a secret to be scrubbed from any text passed to `apply`. Secrets shorter than 4 chars are ignored. */
  add(secret: string): void;
  /** Replaces registered secrets, bearer credentials and Cloudflare token shapes with `[redacted]`. */
  apply(text: string): string;
}

export function createRedactor(): Redactor {
  const secrets = new Set<string>();
  return {
    add(secret) {
      if (secret.length >= MIN_SECRET_LENGTH) secrets.add(secret);
    },
    apply(text) {
      let out = text;
      // Longest first, so a secret that contains another one is not left half-visible.
      for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
        out = out.replaceAll(secret, REDACTED);
      }
      return out.replace(BEARER_PATTERN, `Bearer ${REDACTED}`).replace(CF_TOKEN_PATTERN, REDACTED);
    },
  };
}
