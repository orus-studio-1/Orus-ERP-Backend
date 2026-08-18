export const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'billing',
  'cdn',
  'dashboard',
  'dev',
  'help',
  'login',
  'mail',
  'marketing',
  'portal',
  'register',
  'root',
  'sales',
  'staging',
  'static',
  'status',
  'support',
  'test',
  'webhook',
  'workspace',
  'www',
]);

/**
 * Converts a company name or string into a URL-safe subdomain slug.
 */
export function slugify(input: string): string {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Validates whether a slug is structurally valid and not reserved.
 */
export function validateSlug(slug: string): { valid: boolean; error?: string; slug: string } {
  const normalized = slugify(slug);

  if (!normalized) {
    return { valid: false, error: 'Workspace URL cannot be empty', slug: normalized };
  }

  if (normalized.length < 3) {
    return { valid: false, error: 'Workspace URL must be at least 3 characters', slug: normalized };
  }

  if (normalized.length > 32) {
    return { valid: false, error: 'Workspace URL cannot exceed 32 characters', slug: normalized };
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    return {
      valid: false,
      error: 'Workspace URL can only contain lowercase letters, numbers, and hyphens',
      slug: normalized,
    };
  }

  if (RESERVED_SLUGS.has(normalized)) {
    return { valid: false, error: `"${normalized}" is a reserved system URL and cannot be claimed`, slug: normalized };
  }

  return { valid: true, slug: normalized };
}
