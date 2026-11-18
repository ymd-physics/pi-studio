export const projectUrl = 'https://github.com/ymd-physics/pi-studio'
export type UpdateInfo = { status: 'current' } | {
  status: 'available'; version: string; notes: string; dmg: boolean
}
