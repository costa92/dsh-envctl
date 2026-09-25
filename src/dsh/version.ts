export interface DshVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export function parseDshVersion(value: string): DshVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(value);
  if (!match) {
    return null;
  }

  return {
    raw: value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null
  };
}

export function knownDshFamily(value: string): '0.1.7' | null {
  const version = parseDshVersion(value);
  if (version?.major === 0 && version.minor === 1 && version.patch === 7) {
    return '0.1.7';
  }

  return null;
}
