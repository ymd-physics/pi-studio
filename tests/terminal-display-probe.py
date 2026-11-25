#!/usr/bin/env python3
"""Offline native zsh display checks; isolated HOME, no real shell configuration."""
import importlib.util
import re
import tempfile
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location('terminal_probe', Path(__file__).with_name('terminal-zsh-probe.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def drain(shell):
    for _ in range(3):
        shell.poll(.04)
    data, shell.terminal = shell.terminal, b''
    return data


def submit(shell, command):
    drain(shell)
    ident = shell.request('s', command)
    ack = shell.until(ident + f';loaded;{shell.generation}'.encode())
    assert shell.forward_enter(ident, shell.generation, ack)
    shell.wait_init('start', 'fixed')
    return drain(shell)


def plain(data):
    return re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', data).decode()


with tempfile.TemporaryDirectory(prefix='terminal-display-') as tmp:
    home = Path(tmp)
    (home / '.zshrc').write_text('''
PROMPT='ORIGINAL> '
HISTFILE=$HOME/history
SAVEHIST=0
autoload -Uz add-zsh-hook
_before_prompt() { return 0; }
add-zsh-hook precmd _before_prompt
source "''' + str(probe.ROOT / 'resources/terminal/zsh-integration.zsh') + '''"
''')
    shell = probe.Shell(home)
    try:
        data = submit(shell, 'printf hello')
        text = plain(data)
        assert text.count('❯ printf hello') == 1, text
        assert '\x1b[1m' in data.decode(), data
        assert text.index('hello', text.index('printf hello') + 12) < text.index('Completed ·'), text
        assert text.count('Completed ·') == 1 and '───' in text, text
        data = submit(shell, 'false')
        assert 'Exit 1 ·' in plain(data) and 'Completed ·' not in plain(data), data
        data = submit(shell, 'export DISPLAY_PROBE=1')
        assert plain(data).count('Completed ·') == 1, data
        data = submit(shell, "printf '%s\\n' '你好'\nprintf '%s\\n' 'second line'")
        assert '你好' in plain(data) and plain(data).count('Completed ·') == 1, data
        # Simulate old start timestamps, not clock changes or real multi-day waits.
        for seconds, expected in [(61, '1 m 01 s'), (3661, '1 h 01 m 01 s'), (90061, '1 d 01 h 01 m 01 s')]:
            data = submit(shell, f'_terminal_proof_started=$(( EPOCHREALTIME - {seconds} ))')
            assert 'Completed · ' + expected in plain(data), data
        data = submit(shell, '_terminal_proof_started=$(( EPOCHREALTIME - 3661 )); false')
        assert 'Exit 1 · 1 h 01 m 01 s' in plain(data), data
        # Alternate screen is untouched; the footer is emitted after native restoration.
        data = submit(shell, "printf '\\033[?1049hFULLSCREEN\\033[?1049l'")
        assert data.index(b'\x1b[?1049l') < data.index(b'Completed'), data
        # A load/ACK is not execution: cancellation must produce no completion footer.
        drain(shell)
        ident = shell.request('s', 'touch MUST_NOT_EXIST')
        shell.until(ident + f';loaded;{shell.generation}'.encode())
        cancel = shell.request('x', ident.decode())
        shell.until(cancel + f';cancelled;{shell.generation}'.encode())
        assert 'Completed ·' not in plain(drain(shell))
        assert not (home / 'MUST_NOT_EXIST').exists()
        # Native direct input keeps its actual prompt, not the temporary shelf prefix.
        ident = shell.request('d')
        shell.until(ident + f';direct;{shell.generation}'.encode())
        data = drain(shell)
        assert 'ORIGINAL> ' in plain(data), data
        shell.send_tty(b'false\n')
        shell.wait_init('start', 'fixed')
        assert 'Exit 1 ·' in plain(drain(shell))
        # Foreground Ctrl+C is a nonzero completion, not a successful one.
        ident = shell.request('s', "/bin/sh -c 'printf PROGRAM_READY; exec sleep 5'")
        ack = shell.until(ident + f';loaded;{shell.generation}'.encode())
        shell.forward_enter(ident, shell.generation, ack)
        shell.until(f'0;running;{shell.generation}'.encode())
        # preexec precedes process spawn. Wait for the foreground child itself,
        # not just the command's echoed text, before testing native interruption.
        deadline = time.monotonic() + 4
        while b'\x1b[0mPROGRAM_READY' not in shell.terminal:
            assert time.monotonic() < deadline, shell.terminal
            shell.poll(.02)
        shell.send_tty(b'\x03')
        shell.wait_init('start', 'fixed')
        data = drain(shell)
        assert 'Exit 130 ·' in plain(data) and 'Completed ·' not in plain(data), data
        print('PASS native command echo, footer/status, no-output, Unicode/multiline, alternate screen, cancellation, direct mode, Ctrl+C')
    finally:
        shell.close()
