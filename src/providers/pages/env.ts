import { CliError } from '../../core/errors.js';
import { describeMasked, SECRET_PLACEHOLDER } from '../../core/mask.js';
import type { EnvVar, EnvVarPatch, EnvVars, PagesEnv, Project } from './types.js';

export type EnvVarType = 'plain_text' | 'secret_text';

export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Extracts current environment variables for an environment, handling null or missing configs. */
export function currentEnvVars(p: Project, env: PagesEnv): EnvVars {
  const vars = p.deployment_configs[env]?.env_vars;
  if (!vars) return {};
  const clean: EnvVars = {};
  for (const [key, val] of Object.entries(vars)) {
    if (val !== null && val !== undefined) {
      clean[key] = val;
    }
  }
  return clean;
}

export function newKeys(current: EnvVars, keys: string[]): string[] {
  return keys.filter((k) => !(k in current));
}

export type PlanItem =
  | { key: string; action: 'create'; type: EnvVarType; value: string }
  | {
      key: string;
      action: 'update';
      fromType: EnvVarType;
      type: EnvVarType;
      oldValue?: string;
      value: string;
      becomesReadable: boolean;
      overwritesSecret: boolean;
    }
  | { key: string; action: 'unchanged'; type: 'plain_text' }
  | { key: string; action: 'delete'; type: EnvVarType; oldValue?: string };

export interface EnvPlan {
  env: PagesEnv;
  items: PlanItem[];
}

export interface PlanSetOptions {
  env: PagesEnv;
  type?: EnvVarType;
}

export function planSet(current: EnvVars, entries: { key: string; value: string }[], opts: PlanSetOptions): EnvPlan {
  const seen = new Set<string>();
  const items: PlanItem[] = [];

  for (const { key, value } of entries) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new CliError('usage', `Invalid environment variable name '${key}'. Names must match ${ENV_KEY_PATTERN}.`);
    }
    if (seen.has(key)) {
      throw new CliError('usage', `Duplicate key in input: '${key}'.`);
    }
    seen.add(key);

    const existing = current[key];

    if (!existing) {
      if (!opts.type) {
        throw new CliError('usage', `New variable(s) ${key} need a type: pass --plain or --secret.`);
      }
      items.push({
        key,
        action: 'create',
        type: opts.type,
        value,
      });
      continue;
    }

    const targetType: EnvVarType = opts.type ?? existing.type;
    const becomesReadable = existing.type === 'secret_text' && targetType === 'plain_text';
    const overwritesSecret = existing.type === 'secret_text';

    if (existing.type === 'plain_text' && targetType === 'plain_text' && existing.value === value) {
      items.push({
        key,
        action: 'unchanged',
        type: 'plain_text',
      });
      continue;
    }

    items.push({
      key,
      action: 'update',
      fromType: existing.type,
      type: targetType,
      oldValue: existing.value,
      value,
      becomesReadable,
      overwritesSecret,
    });
  }

  return { env: opts.env, items };
}

export function planUnset(current: EnvVars, keys: string[], env: PagesEnv): EnvPlan {
  const missing: string[] = [];
  const items: PlanItem[] = [];

  for (const key of keys) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new CliError('usage', `Invalid environment variable name '${key}'. Names must match ${ENV_KEY_PATTERN}.`);
    }
    const existing = current[key];
    if (!existing) {
      missing.push(key);
      continue;
    }
    items.push({
      key,
      action: 'delete',
      type: existing.type,
      oldValue: existing.value,
    });
  }

  if (missing.length > 0) {
    throw new CliError('not_found', `Environment variable(s) not found: ${missing.join(', ')}.`);
  }

  return { env, items };
}

export function hasChanges(plan: EnvPlan): boolean {
  return plan.items.some((item) => item.action !== 'unchanged');
}

export function buildEnvPatch(plan: EnvPlan): EnvVarPatch {
  const patch: EnvVarPatch = {};
  for (const item of plan.items) {
    if (item.action === 'create' || item.action === 'update') {
      patch[item.key] = { type: item.type, value: item.value };
    } else if (item.action === 'delete') {
      patch[item.key] = null;
    }
  }
  return patch;
}

export function verifyApplied(before: EnvVars, plan: EnvPlan, after: EnvVars): string[] {
  const mismatches: string[] = [];

  for (const item of plan.items) {
    if (item.action === 'create' || item.action === 'update') {
      const actual = after[item.key];
      if (!actual) {
        mismatches.push(item.key);
      } else if (actual.type !== item.type) {
        mismatches.push(item.key);
      } else if (item.type === 'plain_text' && actual.value !== item.value) {
        mismatches.push(item.key);
      }
    } else if (item.action === 'delete') {
      if (item.key in after) {
        mismatches.push(item.key);
      }
    }
  }

  // Ensure untouched keys that existed in before are still in after
  const plannedKeys = new Set(plan.items.map((i) => i.key));
  for (const [key] of Object.entries(before)) {
    if (!plannedKeys.has(key) && !(key in after)) {
      mismatches.push(key);
    }
  }

  return mismatches;
}

export interface EnvVarView {
  key: string;
  type: EnvVarType;
  readable: boolean;
  masked: string | null;
  length: number | null;
  value?: string;
}

export function envVarView(key: string, v: EnvVar, reveal = false): EnvVarView {
  if (v.type === 'plain_text') {
    const val = v.value ?? '';
    return {
      key,
      type: 'plain_text',
      readable: true,
      masked: describeMasked(val),
      length: [...val].length,
      ...(reveal ? { value: val } : {}),
    };
  }

  return {
    key,
    type: 'secret_text',
    readable: false,
    masked: null,
    length: null,
  };
}

export interface PlanItemView {
  key: string;
  action: 'create' | 'update' | 'delete' | 'unchanged';
  type: EnvVarType;
  fromType?: EnvVarType;
  becomesReadable?: boolean;
  overwritesSecret?: boolean;
}

export function planItemView(item: PlanItem): PlanItemView {
  return {
    key: item.key,
    action: item.action,
    type: item.type,
    ...(item.action === 'update'
      ? {
          fromType: item.fromType,
          becomesReadable: item.becomesReadable,
          overwritesSecret: item.overwritesSecret,
        }
      : {}),
  };
}

export function renderPlan(plan: EnvPlan, project: string): string {
  const lines: string[] = [`Environment variable changes for ${project} (${plan.env}):`];

  for (const item of plan.items) {
    if (item.action === 'create') {
      const valDesc = item.type === 'secret_text' ? SECRET_PLACEHOLDER : describeMasked(item.value);
      lines.push(`+ ${item.key}  ${item.type}  ${valDesc}`);
    } else if (item.action === 'update') {
      if (item.becomesReadable) {
        lines.push(`! ${item.key}  secret_text → plain_text  value will become readable`);
      } else if (item.overwritesSecret) {
        lines.push(`~ ${item.key}  secret_text  ${SECRET_PLACEHOLDER} → will be overwritten`);
      } else {
        const oldDesc = item.oldValue !== undefined ? describeMasked(item.oldValue) : SECRET_PLACEHOLDER;
        const newDesc = item.type === 'plain_text' ? describeMasked(item.value) : SECRET_PLACEHOLDER;
        lines.push(`~ ${item.key}  ${item.type}  ${oldDesc} → ${newDesc}`);
      }
    } else if (item.action === 'delete') {
      lines.push(`- ${item.key}  ${item.type}`);
    } else if (item.action === 'unchanged') {
      lines.push(`= ${item.key}  unchanged`);
    }
  }

  return lines.join('\n');
}
