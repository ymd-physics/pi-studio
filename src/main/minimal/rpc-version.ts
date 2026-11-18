/** The native runtime bridge requires the APIs introduced in stable Pi 1.4. */
export function usesNativeRpcBridge(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/.exec(version)
  if (!match) throw new Error(`Cannot select Pi RPC startup for invalid version: ${version}`)
  const [, major, minor, patch, prerelease] = match
  return (
    Number(major) > 1 ||
    (Number(major) === 1 &&
      (Number(minor) > 4 || (Number(minor) === 4 && (Number(patch) > 0 || !prerelease))))
  )
}
