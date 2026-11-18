#!/usr/bin/env python3
"""Offline zsh socket/ZLE proof. Never uses the operator's HOME or zshrc."""
import os
import pty
import select
import signal
import socket
import secrets
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class Shell:
    def __init__(self, home):
        self.home = home
        path = home / 'socket'
        token = secrets.token_hex(32)
        self.dispatch = f'\x1b[6973;{secrets.randbelow(1000000000):09d}~'.encode()
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(path))
        os.chmod(path, 0o600)
        server.listen(1)
        server.settimeout(8)
        self.pid, self.pty_fd = pty.fork()
        if self.pid == 0:
            os.chdir(home)
            os.execve('/bin/zsh', ['/bin/zsh', '-i'], {
                'HOME': str(home), 'ZDOTDIR': str(home), 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
                'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8', 'LC_ALL': 'en_US.UTF-8',
                'PI_DESKTOP_TERMINAL_SOCKET': str(path), 'PI_DESKTOP_TERMINAL_TOKEN': token,
                'PI_DESKTOP_TERMINAL_DISPATCH': self.dispatch.decode(),
                'TERMINAL_PROOF_MENU_SELECT': os.environ.get('TERMINAL_PROOF_MENU_SELECT', '0'),
            })
        self.sock, _ = server.accept()
        server.close()
        self.sock.setblocking(False)
        self.events = b''
        self.terminal = b''
        self.seq = 0
        self.generation = 0
        self.until(f'0;hello;1;{token};{self.pid}'.encode())
        assert token.encode() not in self.terminal
        self.wait_init('start', 'fixed')

    def poll(self, timeout=.1):
        readable, _, _ = select.select([self.sock, self.pty_fd], [], [], timeout)
        for fd in readable:
            try:
                data = fd.recv(65536) if fd is self.sock else os.read(fd, 65536)
            except BlockingIOError:
                continue
            if fd is self.sock:
                self.events += data
            else:
                self.terminal += data

    def until(self, event, timeout=8):
        needle = event + b'\n'
        deadline = time.monotonic() + timeout
        while needle not in self.events:
            assert time.monotonic() < deadline, (event, self.events, self.terminal)
            self.poll()
        end = self.events.index(needle) + len(needle)
        out, self.events = self.events[:end], self.events[end:]
        return out

    def wait_init(self, context, mode, timeout=8):
        prefix = f'0;init;{context};{mode};'.encode()
        deadline = time.monotonic() + timeout
        while True:
            for line in self.events.splitlines(keepends=True):
                if line.startswith(prefix) and line.endswith(b'\n'):
                    self.until(line.rstrip(b'\n'))
                    fields = line.rstrip(b'\n').split(b';')
                    self.generation = int(fields[-2])
                    assert Path(bytes.fromhex(fields[-1].decode()).decode()).resolve() == self.home.resolve()
                    return
            assert time.monotonic() < deadline, (prefix, self.events, self.terminal)
            self.poll()

    def request(self, action, text='', cursor=None, index=None):
        self.seq += 1
        if cursor is None:
            cursor = len(text)
        if index is None:
            index = self.generation
        frame = f'{self.seq}:{action}:{cursor}:{index}:{text.encode().hex()}\n'.encode()
        self.send_frame(frame)
        return str(self.seq).encode()

    def send_frame(self, frame):
        self.send_parts([frame])

    def send_parts(self, parts):
        pending = memoryview(b''.join(parts))
        # Initiate the first write, then send exactly one dispatch before draining.
        first_limit = len(parts[0])
        try:
            sent = self.sock.send(pending[:first_limit])
        except BlockingIOError:
            sent = 0
        pending = pending[sent:]
        self.send_tty(self.dispatch)
        deadline = time.monotonic() + 8
        while pending:
            assert time.monotonic() < deadline
            # Like the app's PTY pump, keep draining redraw output while sending
            # a large frame; otherwise a full PTY can block ZLE from reading it.
            self.poll(0)
            if select.select([], [self.sock], [], .1)[1]:
                try:
                    pending = pending[self.sock.send(pending):]
                except BlockingIOError:
                    pass

    def complete(self, text, cursor=None):
        ident = self.request('c', text, cursor)
        events = self.until(ident + f';done;{self.generation}'.encode()).splitlines()
        self.last_completion_events = events
        result = next(e.split(b';', 3) for e in events if e.startswith(ident + b';result;'))
        options = [e.split(b';', 4) for e in events if e.startswith(ident + b';option;')]
        assert [int(x[2]) for x in options] == list(range(1, len(options) + 1)) and len(options) <= 64
        return (bytes.fromhex(result[3].decode()).decode(), int(result[2]),
                [(int(x[2]), int(x[3]), bytes.fromhex(x[4].decode()).decode()) for x in options])

    def forward_enter(self, ident, generation, acknowledgement, active=True):
        expected = ident + f';loaded;{generation}\n'.encode()
        if not active or generation != self.generation or expected not in acknowledgement.splitlines(keepends=True):
            return False
        self.send_tty(b'\n')
        return True

    def send_tty(self, data):
        os.write(self.pty_fd, data)

    def close(self):
        self.sock.close()
        os.close(self.pty_fd)
        try:
            os.kill(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(self.pid, 0)


def main():
    with tempfile.TemporaryDirectory(prefix='zsh-socket-proof-') as tmp:
        home = Path(tmp)
        (home / '.zshrc').write_text('''\nHISTFILE=$HOME/history\nHISTSIZE=100\nSAVEHIST=100\nPS1="ORIGINAL-PROMPT> "\nRPROMPT="RIGHT-PROMPT"\nPS2="CONTINUATION> "\nsetopt INTERACTIVE_COMMENTS\nunsetopt AUTO_MENU\nautoload -Uz compinit\ncompinit -d "$HOME/zcompdump"\n[[ $TERMINAL_PROOF_MENU_SELECT == 1 ]] && zstyle ':completion:*' menu select\n_proof_complete() { print -r -- called >> "$HOME/completion-calls"; compadd -- alpha alpine beta }\ncompdef _proof_complete proofcmd\n_state_complete() { local count=0; [[ -f $HOME/state-count ]] && read -r count < "$HOME/state-count"; (( ++count )); print -r -- $count > "$HOME/state-count"; compadd -- "alpha$count" "alpine$count" }\ncompdef _state_complete statecmd\n_many_complete() { local -a vals; local i; for (( i=1; i<=80; i++ )); do vals+=("item${(l:3::0:)i}"); done; compadd -- $vals }\ncompdef _many_complete manycmd\n_huge_complete() { local v; printf -v v '%*s' 4100 ''; v=${v// /x}; compadd -- "$v" }\ncompdef _huge_complete hugecmd\n_redraw_probe() { print -rn -- "REDRAW-HOOK:$BUFFER"; }\nzle -N zle-line-pre-redraw _redraw_probe\nsource "''' + str(ROOT / 'resources/terminal/zsh-integration.zsh') + '''"\n''')
        (home / 'space file.txt').touch()
        (home / 'space folder').mkdir()
        (home / 'éclair.txt').touch()
        shell = Shell(home)
        failures = []
        try:
            for _ in range(3): shell.poll(.05)
            shell.terminal = b''
            _, _, first_options = shell.complete('cat space')
            assert [x[2] for x in first_options] == ['cat space\\ file.txt ', 'cat space\\ folder/'], first_options
            print('PASS first native path completion', first_options, flush=True)
            for _ in range(3): shell.poll(.05)
            shell.terminal = b''
            actual, cursor, options = shell.complete('proofcmd al')
            print('COMPLETION', repr(actual), cursor, options, flush=True)
            assert (actual, cursor) == ('proofcmd alp', 12)
            if [x[2] for x in options] != ['proofcmd alpha ', 'proofcmd alpine ']:
                failures.append(f'second request loses menu options: {options!r}')
                print('FAIL', failures[-1], flush=True)
            for _ in range(3): shell.poll(.05)
            print('PTY DURING COMPLETION', repr(shell.terminal), flush=True)
            assert b'proofcmd' not in shell.terminal, shell.terminal
            assert b'REDRAW-HOOK:proofcmd' not in shell.terminal, shell.terminal
            assert options[0][2] == 'proofcmd alpha '
            print('PASS captured native option snapshot', flush=True)
            actual, cursor, options = shell.complete('cat space')
            assert (actual, cursor) == ('cat space\\ f', 12), (actual, cursor)
            print('SUBSEQUENT PATH OPTIONS', options, flush=True)
            actual, cursor, opts = shell.complete('echo é; proofcmd bet')
            assert (actual, cursor) == ('echo é; proofcmd beta ', 22), (actual, cursor)
            assert [o[2] for o in opts] == ['echo é; proofcmd beta '], opts
            for count in (1, 2):
                _, _, opts = shell.complete('statecmd al')
                assert (home / 'state-count').read_text().strip() == str(count)
                assert [o[2] for o in opts] == [f'statecmd alpha{count} ', f'statecmd alpine{count} '], opts
            for text, position, expected in [
                ('cat "space', None, ['cat "space file.txt" ', 'cat "space folder/']),
                ('cat space END', 9, ['cat space\\ file.txt  END', 'cat space\\ folder/ END']),
                ('echo ok\ncat space', None, ['echo ok\ncat space\\ file.txt ', 'echo ok\ncat space\\ folder/']),
            ]:
                actual, pos, opts = shell.complete(text, position)
                print('NATIVE EDGE', repr(text), actual, pos, opts, flush=True)
                assert [o[2] for o in opts] == expected, (text, opts)
            actual, _, opts = shell.complete('cat écl')
            assert actual == 'cat éclair.txt ' and [o[2] for o in opts] == [actual], (actual, opts)
            _, _, many = shell.complete('manycmd it')
            assert len(many) == 64, len(many)
            assert any(e.endswith(b';truncated;80') for e in shell.last_completion_events), shell.last_completion_events
            ident = shell.request('c', 'hugecmd x')
            shell.until(ident + b';error;too-many-bytes')
            maximum = shell.request('s', 'x' * 4096)
            shell.until(maximum + f';loaded;{shell.generation}'.encode())
            cancel = shell.request('x', maximum.decode())
            shell.until(cancel + f';cancelled;{shell.generation}'.encode())
            oversized = shell.request('s', 'x' * 4097)
            shell.until(oversized + b';error;invalid-frame')
            shell.send_frame(b'x' * 16385 + b'\n')
            shell.until(b'0;error;invalid-frame')
            print('PASS 64 option truncation and frame/input caps', flush=True)
            print('PASS Unicode, unique candidate and one stateful generator call per transaction', flush=True)
            ident = shell.request('d', "(sleep 1; printf 'BACKGROUND-OUTPUT\\n') &")
            shell.until(ident + f';direct;{shell.generation}'.encode())
            shell.send_tty(b'\n')
            shell.wait_init('start', 'fixed')
            for _ in range(3): shell.poll(.05)
            shell.terminal = b''
            shelf = 'echo PRIVATE-SHELF-LINE; proofcmd al'
            actual, _, _ = shell.complete(shelf)
            assert actual.startswith('echo PRIVATE-SHELF-LINE; proofcmd alp'), actual
            deadline = time.monotonic() + 4
            while b'BACKGROUND-OUTPUT' not in shell.terminal:
                assert time.monotonic() < deadline, shell.terminal
                shell.poll()
            assert b'PRIVATE-SHELF-LINE' not in shell.terminal, shell.terminal
            print('PASS background output while ready and no shelf-line leak', flush=True)
            shell.send_parts([b'incomplete', b'\n'])
            shell.until(b'0;error;invalid-frame')
            for frame, error in [(f'900:c:0:{shell.generation}:gg\n'.encode(), b'900;error;invalid-frame'),
                                 (f'901:c:9:{shell.generation}:61\n'.encode(), b'901;error;invalid-buffer'),
                                 (f'902:c:0:{shell.generation}:00\n'.encode(), b'902;error;invalid-buffer'),
                                 (f'903:c:0:{shell.generation}:ff\n'.encode(), b'903;error;invalid-buffer')]:
                shell.send_frame(frame)
                shell.until(error)
            actual, _, _ = shell.complete('proofcmd bet')
            assert actual == 'proofcmd beta ', actual
            shell.send_parts([b'904:g:0:', f'{shell.generation}:\n'.encode()])
            shell.until(b'904;error;not-ready')
            shell.send_frame(f'905:g:0:{shell.generation}:\n'.encode())
            shell.until(b'905;error;not-ready')
            print('PASS malformed and fragmented socket frames with one wake each', flush=True)
            ident = shell.request('d', 'echo é', cursor=0)
            shell.until(ident + f';direct;{shell.generation}'.encode())
            ident = shell.request('g')
            shell.until(ident + b';snapshot;0;' + 'echo é'.encode().hex().encode() + f';{shell.generation}'.encode())
            assert b'ORIGINAL-PROMPT>' in shell.terminal, shell.terminal
            print('PASS direct prompt and initial Unicode cursor handoff', flush=True)
            shell.terminal = b''
            ident = shell.request('d', 'echo DIRECT-MUST-NOT-RUN')
            shell.until(ident + f';direct;{shell.generation}'.encode())
            shell.send_tty(b'\x03')
            shell.wait_init('start', 'fixed')
            for _ in range(3): shell.poll(.05)
            assert b'\r\nDIRECT-MUST-NOT-RUN\r\n' not in shell.terminal, shell.terminal
            print('PASS immediate direct-ACK/raw Ctrl-C without k', flush=True)
            ident = shell.request('d', 'if true; then')
            shell.until(ident + f';direct;{shell.generation}'.encode())
            shell.send_tty(b'\n')
            shell.wait_init('cont', 'direct')
            assert b'REDRAW-HOOK' in shell.terminal, shell.terminal
            # Real terminal Ctrl-C in the direct continuation editor.
            for _ in range(3): shell.poll(.05)
            shell.send_tty(b'\x03')
            shell.wait_init('start', 'fixed')
            print('PASS direct continuation and terminal Ctrl-C', flush=True)
            shell.terminal = b''
            ident = shell.request('d', "/bin/sh -c 'printf \"FG-READY\\n\"; exec sleep 30'; printf 'FG-SURVIVED\\n'")
            shell.until(ident + f';direct;{shell.generation}'.encode())
            shell.send_tty(b'\n')
            shell.until(f'0;running;{shell.generation}'.encode())
            deadline = time.monotonic() + 6
            while b'\r\nFG-READY\r\n' not in shell.terminal:
                assert time.monotonic() < deadline, shell.terminal
                shell.poll()
            assert os.tcgetpgrp(shell.pty_fd) != os.getpgid(shell.pid)
            shell.send_tty(b'\x03')
            shell.wait_init('start', 'fixed')
            for _ in range(3): shell.poll(.05)
            assert b'\r\nFG-SURVIVED\r\n' not in shell.terminal, shell.terminal
            print('PASS running foreground raw Ctrl-C without k', flush=True)
            stale_generation = shell.generation - 1
            for action in 'csxdgk':
                ident = shell.request(action, 'printf bad > "$HOME/stale-ran"', index=stale_generation)
                shell.until(ident + b';error;stale-generation')
            ident = shell.request('s', 'printf bad > "$HOME/cancel-ran"', index=shell.generation)
            cancelled_ack = shell.until(ident + f';loaded;{shell.generation}'.encode())
            shell.send_tty(b'\x0c')  # Force ZLE redisplay while the acknowledgement is pending.
            for _ in range(5): shell.poll(.1)
            assert not shell.forward_enter(ident, shell.generation, cancelled_ack, active=False)
            cancel = shell.request('x', ident.decode(), index=shell.generation)
            shell.until(cancel + f';cancelled;{shell.generation}'.encode())
            prior_generation = shell.generation
            replacement = shell.request('s', 'printf ok > "$HOME/after-cancel"')
            replacement_ack = shell.until(replacement + f';loaded;{prior_generation}'.encode())
            assert shell.generation == prior_generation and not (home / 'cancel-ran').exists()
            assert shell.forward_enter(replacement, prior_generation, replacement_ack)
            shell.wait_init('start', 'fixed')
            assert (home / 'after-cancel').read_text() == 'ok'
            assert not shell.forward_enter(ident, prior_generation, cancelled_ack)
            print('PASS cancel then replacement load in same generation without intervening Enter/Ctrl-C', flush=True)
            delayed = shell.request('s', 'printf bad > "$HOME/delayed-ran"', index=prior_generation)
            shell.until(delayed + b';error;stale-generation')
            shell.send_tty(b'\n')
            shell.wait_init('start', 'fixed')
            for _ in range(3): shell.poll(.05)
            assert not any((home / name).exists() for name in ('delayed-ran', 'stale-ran', 'cancel-ran'))
            print('OBSERVATION committed load redisplayed after Ctrl-L:', b'cancel-ran' in shell.terminal, flush=True)
            print('PASS stale generation rejected and cancelled load does not execute', flush=True)
            ident = shell.request('d', "(sleep 1; printf 'LOAD-BACKGROUND\\n') &")
            shell.until(ident + f';direct;{shell.generation}'.encode())
            shell.send_tty(b'\n')
            shell.wait_init('start', 'fixed')
            for _ in range(3): shell.poll(.05)
            shell.terminal = b''
            loaded = shell.request('s', 'echo COMMITTED-COMMAND', index=shell.generation)
            shell.until(loaded + f';loaded;{shell.generation}'.encode())
            deadline = time.monotonic() + 4
            while b'LOAD-BACKGROUND' not in shell.terminal:
                assert time.monotonic() < deadline, shell.terminal
                shell.poll()
            print('OBSERVATION committed load redisplayed with background output:', b'COMMITTED-COMMAND' in shell.terminal, flush=True)
            cancel = shell.request('x', loaded.decode(), index=shell.generation)
            shell.until(cancel + f';cancelled;{shell.generation}'.encode())
            print('PASS background output during loaded acknowledgement window', flush=True)
            ident = shell.request('s', "printf 'SUBMIT-OUTPUT\\n'", index=shell.generation)
            submit_generation = shell.generation
            submit_ack = shell.until(ident + f';loaded;{submit_generation}'.encode())
            for _ in range(5): shell.poll(.1)
            assert f'0;running;{shell.generation}\n'.encode() not in shell.events, shell.events
            assert b'SUBMIT-OUTPUT\r\n' not in shell.terminal, shell.terminal
            # Controller forwards the user's explicit Enter only after the matching acknowledgement.
            assert shell.forward_enter(ident, submit_generation, submit_ack)
            shell.until(f'0;running;{submit_generation}'.encode())
            shell.wait_init('start', 'fixed')
            for _ in range(3): shell.poll(.05)
            assert b'SUBMIT-OUTPUT\r\n' in shell.terminal, shell.terminal
            print('PASS explicit Enter after matching load acknowledgement', flush=True)
            for iteration in range(50):
                ident = shell.request('s', 'printf . >> "$HOME/submission-count"')
                ack = shell.until(ident + f';loaded;{shell.generation}'.encode())
                assert shell.forward_enter(ident, shell.generation, ack)
                shell.wait_init('start', 'fixed')
            assert (home / 'submission-count').read_text() == '.' * 50
            print('PASS 50 immediate s-ACK/explicit-Enter submissions exactly once', flush=True)
            if os.environ.get('TERMINAL_PROOF_K_DIAGNOSTIC') == '1':
                missed = 0
                for _ in range(50):
                    ident = shell.request('k')
                    shell.until(ident + f';interrupt;{shell.generation}'.encode())
                    shell.send_tty(b'\x03')
                    try:
                        shell.wait_init('start', 'fixed', timeout=.3)
                    except AssertionError:
                        missed += 1
                        shell.send_tty(b'\n')
                        shell.wait_init('start', 'fixed')
                print(f'UNSUPPORTED diagnostic k-ACK/Ctrl-C missed next init: {missed}/50', flush=True)
            loaded = shell.request('s', 'echo DISCONNECT-MUST-NOT-RUN')
            shell.until(loaded + f';loaded;{shell.generation}'.encode())
            shell.terminal = b''
            shell.sock.close()
            shell.send_tty(shell.dispatch)  # With no FD watcher, the next dispatch observes EOF.
            deadline = time.monotonic() + 4
            while b'ORIGINAL-PROMPT>' not in shell.terminal:
                assert time.monotonic() < deadline, shell.terminal
                readable, _, _ = select.select([shell.pty_fd], [], [], .1)
                if readable: shell.terminal += os.read(shell.pty_fd, 65536)
            shell.send_tty(b'\n')
            time.sleep(.2)
            if select.select([shell.pty_fd], [], [], .2)[0]:
                shell.terminal += os.read(shell.pty_fd, 65536)
            assert b'\r\nDISCONNECT-MUST-NOT-RUN\r\n' not in shell.terminal, shell.terminal
            print('PASS socket disconnect clears loaded line and restores direct prompt', flush=True)
        finally:
            shell.close()
        with tempfile.TemporaryDirectory(prefix='zsh-compinit-proof-') as plain_tmp:
            plain = Path(plain_tmp)
            (plain / '.zshrc').write_text('PS1="PLAIN> "\nsource "' + str(ROOT / 'resources/terminal/zsh-integration.zsh') + '"\n')
            (plain / 'needle.txt').touch()
            fallback = Shell(plain)
            try:
                actual, _, options = fallback.complete('cat need')
                assert actual == 'cat needle.txt ' and options[0][2] == actual, (actual, options)
                assert not list(plain.glob('.zcompdump*'))
                ident = fallback.request('s', 'echo MUST-NOT-RUN', index=0)
                fallback.until(ident + b';error;stale-generation')
                ident = fallback.request('d', '_terminal_proof_generation=999999999')
                fallback.until(ident + f';direct;{fallback.generation}'.encode())
                fallback.send_tty(b'\n')
                fallback.wait_init('start', 'fixed')
                assert fallback.generation == 1000000000
                fallback.send_tty(b'\n')
                deadline = time.monotonic() + 8
                while True:
                    assert time.monotonic() < deadline
                    ready, _, _ = select.select([fallback.sock, fallback.pty_fd], [], [], .2)
                    if fallback.sock in ready:
                        data = fallback.sock.recv(65536)
                        if not data: break
                        assert b'0;init;start;fixed;1000000001;' not in data
                    if fallback.pty_fd in ready:
                        os.read(fallback.pty_fd, 65536)
                print('PASS compinit fallback, zero generation rejected, overflow disconnect', flush=True)
            finally:
                fallback.close()
        for close_write in (False, True):
            with tempfile.TemporaryDirectory(prefix='zsh-dispatch-failure-') as broken_tmp:
                broken_home = Path(broken_tmp)
                (broken_home / '.zshrc').write_text('PS1="BROKEN> "\nsource "' + str(ROOT / 'resources/terminal/zsh-integration.zsh') + '"\n')
                broken = Shell(broken_home)
                try:
                    broken.send_frame(f'919:s:0:{broken.generation}:'.encode())
                    if close_write:
                        broken.sock.shutdown(socket.SHUT_WR)
                    deadline = time.monotonic() + 5
                    while True:
                        assert time.monotonic() < deadline, (close_write, broken.events, broken.terminal)
                        ready, _, _ = select.select([broken.sock, broken.pty_fd], [], [], .1)
                        if broken.sock in ready:
                            data = broken.sock.recv(65536)
                            if not data:
                                break
                        if broken.pty_fd in ready:
                            broken.terminal += os.read(broken.pty_fd, 65536)
                    print('PASS partial frame', 'EOF' if close_write else 'deadline', 'closes channel', flush=True)
                finally:
                    broken.close()
        if failures:
            raise SystemExit(f'{len(failures)} proof gates failed')

if __name__ == '__main__':
    main()
