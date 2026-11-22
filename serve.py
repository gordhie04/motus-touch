#!/usr/bin/env python3
"""Start Motus-Touch on this computer only (127.0.0.1) and open it in your browser.

- No caching, so updates show up right away.
- Security headers on every file, including the AI model worker.
- Cross-origin isolation, which lets AI models use several CPU cores.
"""
import functools, http.server, os, signal, socket, subprocess, sys, threading, time, urllib.request, webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
CSP = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob:; connect-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def log_message(self, *args):
        pass


PORT = 4173   # always the same address: the browser keeps your library per address


BROWSERS = {'chrome': 'Google Chrome', 'edge': 'Microsoft Edge'}
CHOICE = (sys.argv[1] if len(sys.argv) > 1 else 'chrome').lower()


def open_browser(url):
    # Open the chosen browser on a Mac (Chrome unless told "edge"), otherwise the default browser
    if sys.platform == 'darwin' and CHOICE in BROWSERS and subprocess.call(['open', '-a', BROWSERS[CHOICE], url], stderr=subprocess.DEVNULL) == 0:
        return
    webbrowser.open(url)


def port_in_use():
    with socket.socket() as s:
        return s.connect_ex(('127.0.0.1', PORT)) == 0


def stale_servers():
    """PIDs of old Python web servers (http.server / serve.py) listening on our port. Mac/Linux only."""
    try:
        pids = subprocess.run(['lsof', '-nP', f'-iTCP:{PORT}', '-sTCP:LISTEN', '-t'], capture_output=True, text=True, timeout=5).stdout.split()
    except Exception:
        return []
    found = []
    for pid in pids:
        try:
            cmd = subprocess.run(['ps', '-o', 'command=', '-p', pid], capture_output=True, text=True, timeout=5).stdout
        except Exception:
            continue
        if 'python' in cmd.lower() and ('http.server' in cmd or 'serve.py' in cmd) and int(pid) != os.getpid():
            found.append(int(pid))
    return found


def stop_stale():
    pids = stale_servers()
    if not pids:
        return False
    print('Stopping an older Motus-Touch server…')
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    for _ in range(30):
        if not port_in_use():
            return True
        time.sleep(.1)
    return not port_in_use()


def same_app_running(url):
    try:
        with urllib.request.urlopen(url + 'index.html', timeout=2) as r, open(os.path.join(ROOT, 'index.html'), 'rb') as f:
            return r.read() == f.read()
    except Exception:
        return False


if __name__ == '__main__':
    url = f'http://127.0.0.1:{PORT}/'
    if port_in_use():
        if same_app_running(url):
            print(f'Motus-Touch is already running. Opening {url}')
            open_browser(url)
            sys.exit(0)
        if not stop_stale():
            print(f'Another program is using {url}, so Motus-Touch can\'t start.\n'
                  'Close other Motus-Touch Terminal windows (or restart the Mac), then double-click the starter again.')
            input('Press Return to close this window.')
            sys.exit(1)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), functools.partial(Handler, directory=ROOT))
    print(f'Motus-Touch is running at {url}\nKeep this window open while you edit. Press Ctrl+C to stop.')
    threading.Timer(.6, lambda: open_browser(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
