export class CliError extends Error {
  constructor(message, code) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class MissingCredentialError extends CliError {
  constructor(varName) {
    super(`Missing required environment variable: ${varName}`, 'MISSING_CREDENTIAL');
    this.varName = varName;
  }
}

export class InvalidCredentialError extends CliError {
  constructor(message, cause) {
    super(message, 'INVALID_CREDENTIAL');
    this.cause = cause;
  }
}

export class InvalidSlugError extends CliError {
  constructor(slug) {
    super(
      `Invalid slug "${slug}": must be 1-58 chars, lowercase letters/digits/dashes only, and cannot start or end with a dash`,
      'INVALID_SLUG',
    );
    this.slug = slug;
  }
}

export class DirectoryNotFoundError extends CliError {
  constructor(dir) {
    super(`Directory not found: ${dir}`, 'DIRECTORY_NOT_FOUND');
    this.dir = dir;
  }
}

export class EmptyDirectoryError extends CliError {
  constructor(dir) {
    super(`Directory is empty: ${dir}`, 'EMPTY_DIRECTORY');
    this.dir = dir;
  }
}

export class WranglerExecutionError extends CliError {
  constructor(stderr, exitCode) {
    super(`wrangler exited with code ${exitCode}: ${stderr.trim()}`, 'WRANGLER_EXECUTION_ERROR');
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class MissingWranglerEntrypointError extends CliError {
  constructor(binPath) {
    super(`wrangler entrypoint not found at resolved path: ${binPath}`, 'MISSING_WRANGLER_ENTRYPOINT');
    this.binPath = binPath;
  }
}

export class RateLimitError extends CliError {
  constructor(stderr) {
    super('Cloudflare rate-limited the upload (HTTP 429). Wait a bit and retry.', 'RATE_LIMIT');
    this.stderr = stderr;
  }
}

export class SlugTakenError extends CliError {
  constructor(slug, cause) {
    super(`Slug "${slug}" is already taken on pages.dev — choose a different slug`, 'SLUG_TAKEN');
    this.slug = slug;
    this.cause = cause;
  }
}

export class MissingSubdomainError extends CliError {
  constructor(slug) {
    super(`Cloudflare returned no subdomain for project "${slug}" — cannot build a live URL`, 'MISSING_SUBDOMAIN');
    this.slug = slug;
  }
}

export class ProjectCreateError extends CliError {
  constructor(cause) {
    super(`Failed to create Cloudflare Pages project: ${cause.message}`, 'PROJECT_CREATE_ERROR');
    this.cloudflareErrorCode = cause.cloudflareErrorCode;
    this.cause = cause;
  }
}

export class ProjectNotFoundError extends CliError {
  constructor(slug) {
    super(`Cloudflare Pages project "${slug}" was not found`, 'PROJECT_NOT_FOUND');
    this.slug = slug;
  }
}

/**
 * Shared normalization for Cloudflare's `errors` array so every error type
 * exposes the same public shape: `.errors` always an array, and the first
 * error's code available for callers to branch on (e.g. code 8000003
 * meaning "slug already taken").
 */
function normalizeCloudflareErrors(errors) {
  const normalized = errors ?? [];
  const [first] = normalized;
  return { errors: normalized, cloudflareErrorCode: first?.code };
}

export class CloudflareHttpError extends CliError {
  constructor(status, statusText, errors) {
    const { errors: normalizedErrors, cloudflareErrorCode } = normalizeCloudflareErrors(errors);
    const [first] = normalizedErrors;
    const message = first
      ? `Cloudflare API HTTP error: ${status} ${statusText} (Cloudflare error ${first.code}: ${first.message})`
      : `Cloudflare API HTTP error: ${status} ${statusText}`;
    super(message, 'CLOUDFLARE_HTTP_ERROR');
    this.status = status;
    this.errors = normalizedErrors;
    this.cloudflareErrorCode = cloudflareErrorCode;
  }
}

export class CloudflareApiError extends CliError {
  constructor(errors) {
    const { errors: normalizedErrors, cloudflareErrorCode } = normalizeCloudflareErrors(errors);
    const [first] = normalizedErrors;
    const message = first
      ? `Cloudflare API error ${first.code}: ${first.message}`
      : 'Cloudflare API returned an unsuccessful response';
    super(message, 'CLOUDFLARE_API_ERROR');
    this.errors = normalizedErrors;
    this.cloudflareErrorCode = cloudflareErrorCode;
  }
}

/**
 * Distinct from `CloudflareApiError`: this means the response body could not
 * be parsed at all (a 2xx with an empty/non-JSON body), not that Cloudflare
 * understood the request and rejected it. Callers like `checkAuth` must not
 * treat this as a rejected credential.
 */
export class CloudflareResponseParseError extends CliError {
  constructor(status, statusText) {
    super(`Cloudflare API returned an unparseable response body: ${status} ${statusText}`, 'CLOUDFLARE_PARSE_ERROR');
    this.status = status;
  }
}
