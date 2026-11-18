// Prove the distributed node-pty addon + helper in the actual Electron runtime.
// Uses only a disposable HOME and zsh -f; never loads user shell/Pi configuration.
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const executable = require('electron')
const ptyModule = require.resolve('node-pty')
const root = await mkdtemp(join(tmpdir(), 'pi-terminal-native-'))
try {
  await mkdir(join(root, 'home'))
  const main = join(root, 'smoke.cjs')
  await writeFile(main, `const {app}=require('electron');
    const pty=require(${JSON.stringify(ptyModule)});
    app.setPath('userData',${JSON.stringify(join(root, 'data'))});
    process.on('uncaughtException',error=>{process.stderr.write(String(error.stack));app.exit(1)});
    app.whenReady().then(()=>{
      const p=pty.spawn('/bin/zsh',['-f','-c','printf native-pty-ok'],{
        cwd:${JSON.stringify(root)},cols:80,rows:24,name:'xterm-256color',
        env:{HOME:${JSON.stringify(join(root, 'home'))},PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TERM:'xterm-256color',LANG:'en_US.UTF-8'}});
      let output='';p.onData(data=>output+=data);
      p.onExit(({exitCode})=>process.stdout.write(JSON.stringify({output,exitCode,electron:process.versions.electron,napi:process.versions.napi})+'\\n',()=>app.exit(exitCode)));
    }).catch(error=>{process.stderr.write(String(error.stack));app.exit(1)});`)
  const env = { ...process.env, HOME: join(root, 'home') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  const { stdout } = await promisify(execFile)(executable, [main], { env, timeout: 15_000, maxBuffer: 1024 * 1024 })
  const result = JSON.parse(stdout.trim().split('\n').at(-1))
  assert.equal(result.output, 'native-pty-ok')
  assert.equal(result.exitCode, 0)
  console.log(`PASS: node-pty prebuild + spawn-helper under Electron ${result.electron}, N-API ${result.napi}; isolated shell exited cleanly.`)
} finally {
  await rm(root, { recursive: true, force: true })
}
