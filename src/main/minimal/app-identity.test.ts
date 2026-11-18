import { expect, it } from 'vitest'
import { join } from 'node:path'
import { studioProfilePath } from './app-identity'

it('keeps the legacy package-name profile rather than either human-facing app name', () => {
  expect(studioProfilePath('/application-support')).toBe(join('/application-support', 'pi-desktop'))
  expect(studioProfilePath('/application-support')).not.toContain('Pi Studio')
  expect(studioProfilePath('/application-support')).not.toContain('Pi Desktop')
})
it('preserves the existing explicit data directory override', () => {
  expect(studioProfilePath('/application-support', '/isolated-test-data')).toBe('/isolated-test-data')
})
