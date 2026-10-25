import type { Evidence, StepType, Zone } from '@tracenaut/protocol';
import { config } from '../api.js';

/**
 * TraceNaut's icon family and official-logo tiles (packages/assets). Icons are served by the
 * local TraceNaut service and loaded only when shown; the versioned URL lets the browser cache
 * each one permanently. Icons always accompany text; `label` is only for icons that stand alone.
 */
export function assetUrl(name: string) {
  const base = config?.daemon ?? '';
  return `${base}/assets/icons/${name}.svg${config?.assets ? `?v=${config.assets}` : ''}`;
}

export function Icon3D({ name, size = 24, label }: { name: string; size?: number; label?: string }) {
  return (
    <img
      class="i3d"
      src={assetUrl(name)}
      width={size}
      height={size}
      alt={label ?? ''}
      aria-hidden={label ? undefined : 'true'}
      draggable={false}
      decoding="async"
      onError={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')}
    />
  );
}

export const STEP_ICON: Record<StepType, string> = {
  interaction: 'interaction',
  'ui-logic': 'code-browser',
  'client-logic': 'code-browser',
  request: 'request',
  'server-entry': 'server',
  'server-logic': 'code-server',
  database: 'database',
  response: 'response',
  'ui-update': 'update',
  navigation: 'route',
  unknown: 'unknown',
};

export const ZONE_ICON: Record<Zone, string> = {
  browser: 'browser',
  network: 'network',
  server: 'server',
  database: 'database',
};

export const EVIDENCE_ICON: Record<Evidence, string> = {
  runtime: 'ok',
  static: 'static',
  inferred: 'likely',
  unresolved: 'unknown',
};

export const KIND_ICON: Record<string, string> = {
  language: 'language',
  library: 'library',
  framework: 'framework',
  runtime: 'runtime',
  protocol: 'protocol',
  'data-format': 'data',
  database: 'database',
  'browser-api': 'api',
  tool: 'tool',
  platform: 'cloud',
  service: 'server',
  idea: 'component',
  syntax: 'code',
};
