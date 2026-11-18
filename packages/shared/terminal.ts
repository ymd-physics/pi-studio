export interface TerminalInfo {
  id: string
  name: string
  workspace: string
  cwd: string
  shell: string
  state: 'starting' | 'ready' | 'running' | 'exited'
  mode: 'command' | 'direct'
  reason?: string
  exitCode?: number
}

export interface TerminalOutputPacket { id: string; sequence: number; data: string }
export interface TerminalCompletion {
  buffer: string
  cursor: number
  options: Array<{ buffer: string; cursor: number; label?: string }>
}

export interface TerminalTransport {
  attach(id: string): Promise<void>
  acknowledge(id: string, sequence: number): Promise<void>
  resize(id: string, cols: number, rows: number): Promise<void>
  write(id: string, data: string): Promise<void>
  submit(id: string, buffer: string): Promise<void>
  complete(id: string, buffer: string, cursor: number): Promise<TerminalCompletion>
  setMode(id: string, mode: TerminalInfo['mode'], buffer?: string, cursor?: number): Promise<{ buffer?: string; cursor?: number }>
  interrupt(id: string): Promise<void>
  onOutput(listener: (packet: TerminalOutputPacket) => void): () => void
  copyText(text: string): Promise<void>
  pasteText(): Promise<string>
}
