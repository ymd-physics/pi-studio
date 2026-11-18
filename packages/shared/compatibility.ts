// Known adapter reference baselines, not a guarantee for every later release.
export const PI_RECOMMENDED_VERSION = '1.4.0'
export const PLUGIN_BASELINES = {
  permissions: { package: '@gotgenes/pi-permission-system', version: '42.0.0' },
  todo: { package: '@juicesharp/rpiv-todo', version: '2.15.0' },
  subagents: { package: 'pi-subagents', version: '0.87.0' },
  'web-access': { package: 'pi-web-access', version: '0.47.0' },
} as const
export type AdaptedPlugin = keyof typeof PLUGIN_BASELINES
