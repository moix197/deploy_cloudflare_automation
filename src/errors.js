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
