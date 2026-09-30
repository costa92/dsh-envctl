export class DshError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'DshError';
    this.exitCode = exitCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends DshError {
  constructor(message: string) {
    super(message, 3);
    this.name = 'ValidationError';
  }
}

export class CapabilityError extends DshError {
  constructor(message: string) {
    super(message, 4);
    this.name = 'CapabilityError';
  }
}

export class DegradedError extends DshError {
  constructor(message: string) {
    super(message, 5);
    this.name = 'DegradedError';
  }
}

export class FileExistsError extends DshError {
  constructor(path: string) {
    super(`Target file already exists: ${path}`, 3);
    this.name = 'FileExistsError';
  }
}

export const START_HINT =
  'run dshenv init to start one, or dshenv capture -o candidate.yaml then dshenv adopt candidate.yaml to manage the DSH setup you have';

// Every command that needs the manifest says how to get one, since a missing manifest usually means a first run.
export function missingManifestError(manifestFile: string): ValidationError {
  return new ValidationError(`Manifest file not found: ${manifestFile}. No dshenv environment here yet: ${START_HINT}`);
}
