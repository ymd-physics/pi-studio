import { join } from 'node:path'

// The shipped 0.9.x package.json name is pi-desktop (no productName field).
// Electron used that lowercase name for userData, even in Pi Desktop.app.
export function studioProfilePath(appData: string, override?: string): string {
  return override || join(appData, 'pi-desktop')
}
