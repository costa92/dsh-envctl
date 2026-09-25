export type SourceType = 'npm' | 'git' | 'local-link' | 'local-file' | 'in-box' | 'unknown';

export interface NpmSource {
  type: 'npm';
  version: string;
  registry?: string;
}

export interface GitSource {
  type: 'git';
  url: string;
  ref?: string;
  commit?: string;
}

export interface LocalLinkSource {
  type: 'local-link';
  path: string;
}

export interface LocalFileSource {
  type: 'local-file';
  path: string;
}

export interface InBoxSource {
  type: 'in-box';
}

export type PluginSource = NpmSource | GitSource | LocalLinkSource | LocalFileSource | InBoxSource;

export interface PatchEntry {
  id: string;
  config: Record<string, unknown>;
  enabled?: boolean;
}

export interface PluginManifestEntry {
  package: string;
  enabled?: boolean;
  source: PluginSource;
  patches?: PatchEntry[];
}

export interface EnvironmentManifest {
  apiVersion: 'dshenv/v1';
  environment?: {
    sourceRoot?: string;
    harness?: {
      sourceDir?: string;
    };
  };
  profiles: Record<
    string,
    {
      plugins: Record<string, PluginManifestEntry>;
    }
  >;
}

export type NpmLockSource = {
  type: 'npm';
  resolvedVersion: string;
  integrity?: string;
  resolvedFrom?: string;
};

export type GitLockSource = {
  type: 'git';
  url: string;
  commit: string;
};

export type LocalLinkLockSource = {
  type: 'local-link';
  path: string;
  digest?: string;
};

export type LocalFileLockSource = {
  type: 'local-file';
  path: string;
  digest?: string;
};

export type InBoxLockSource = {
  type: 'in-box';
};

export type PluginLockSource =
  | NpmLockSource
  | GitLockSource
  | LocalLinkLockSource
  | LocalFileLockSource
  | InBoxLockSource;

export interface PluginLockEntry {
  package: string;
  source: PluginLockSource;
}

export interface EnvironmentLock {
  apiVersion: 'dshenv-lock/v1';
  profiles: Record<
    string,
    {
      plugins: Record<string, PluginLockEntry>;
    }
  >;
}

export interface PluginStateEntry {
  package: string;
  status: string;
  installedVersion?: string;
  lastVerified?: string;
}

export interface EnvironmentState {
  apiVersion: 'dshenv-state/v1';
  lastApplied: string;
  appliedLockHash: string;
  profiles: Record<
    string,
    {
      plugins: Record<string, PluginStateEntry>;
    }
  >;
}

export interface CaptureDocument {
  apiVersion: 'dshenv-capture/v1';
  manifest: EnvironmentManifest;
  lock: EnvironmentLock;
  warnings: string[];
}
