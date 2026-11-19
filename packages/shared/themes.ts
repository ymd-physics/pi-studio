export const themes = { light: 'Light', paper: 'Paper', celadon: 'Celadon', dark: 'Dark', ocean: 'Moss Ink', dusk: 'Smoked Bronze' } as const
export type Theme = keyof typeof themes
export const isTheme = (value: unknown): value is Theme => typeof value === 'string' && Object.hasOwn(themes, value)
export const themeKeys = Object.keys(themes) as Theme[]
export function resolveTheme(theme: Theme | 'system' = 'system', night: boolean, dayTheme: Theme = 'light', nightTheme: Theme = 'dark'): Theme {
  return theme === 'system' ? (night ? nightTheme : dayTheme) : theme
}
