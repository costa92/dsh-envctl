export interface DshCapabilities {
  discovery: boolean;
  mutations: boolean;
  operationsExport: string | null;
}

export function capabilitiesFor(version: string): DshCapabilities {
  if (version === '0.1.7-rc.2' || version.startsWith('0.1.7')) {
    return {
      discovery: true,
      mutations: false,
      operationsExport: '@deepseek-ai/dsh-plugin-manager/operations'
    };
  }

  return {
    discovery: false,
    mutations: false,
    operationsExport: null
  };
}
