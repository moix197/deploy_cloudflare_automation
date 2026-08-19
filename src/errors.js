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
