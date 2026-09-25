export interface DshVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export function parseDshVersion(value: string): DshVersion | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match[0] !== value) {
    return null;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return null;
  }

  const prerelease = match[4] ?? null;
  if (prerelease?.split('.').some(identifier => /^0\d+$/.test(identifier))) {
    return null;
  }

  return {
    raw: value,
    major,
    minor,
    patch,
    prerelease
  };
}

export function knownDshFamily(value: string): '0.1.7' | null {
  const version = parseDshVersion(value);
  if (version?.major === 0 && version.minor === 1 && version.patch === 7) {
    return '0.1.7';
  }

  return null;
}
