"""Single-user, loopback-only Linux lab with real PTYs and Python processes."""
import asyncio
import contextlib
import fcntl
import json
import os
from pathlib import Path
import pty
import secrets
import signal
import struct
import termios
from urllib.parse import urlsplit

from aiohttp import web, WSMsgType

ROOT = Path(__file__).resolve().parent.parent
HOME = Path('/home/pi')
TOKEN = secrets.token_urlsafe(32)
MAX_FILE = 2_000_000


@web.middleware
async def local_only(request, handler):
    host = urlsplit('http://' + request.host).hostname
    if host not in {'localhost', '127.0.0.1', '::1'}:
        raise web.HTTPForbidden(text='Pi Lab is a local, single-user service.')
    origin = request.headers.get('Origin')
    if origin and origin != f'{request.scheme}://{request.host}':
        raise web.HTTPForbidden(text='Cross-origin access denied.')
    if request.headers.get('Sec-Fetch-Site') == 'cross-site':
        raise web.HTTPForbidden(text='Cross-site access denied.')
    if request.path.startswith('/api/') and request.cookies.get('pilab_session') != TOKEN:
        raise web.HTTPForbidden(text='Open the desktop first to establish a local session.')
    if request.path.startswith('/api/') and request.headers.get('Upgrade', '').lower() == 'websocket' and not origin:
        raise web.HTTPForbidden(text='WebSocket Origin is required.')
    try:
        response = await handler(request)
    except (ValueError, KeyError, TypeError) as exc:
        return web.json_response({'error': str(exc)}, status=400)
    except OSError as exc:
        return web.json_response({'error': str(exc)}, status=400)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'same-origin'
    response.headers['Cache-Control'] = 'no-store'
    return response


def safe_path(value):
    if not isinstance(value, str) or '\x00' in value:
        raise ValueError('Invalid path')
    path = Path(value)
    resolved = path.resolve()
    if not resolved.is_relative_to(HOME) or resolved == HOME and path != HOME:
        raise ValueError('File operations must stay in /home/pi')
    return resolved


def snapshot():
    result = {str(HOME): None}
    total = 0
    for directory, dirs, names in os.walk(HOME, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and not (Path(directory)/d).is_symlink() and d not in {'node_modules', '__pycache__', 'venv'})
        for name in dirs + sorted(names):
            path = Path(directory)/name
            if path.is_symlink() or name.startswith('.'):
                continue
            if path.is_dir():
                result[str(path)] = None
            elif path.is_file() and path.stat().st_size <= MAX_FILE:
                try:
                    text = path.read_text(encoding='utf-8')
                except (UnicodeDecodeError, OSError):
                    continue
                total += len(text.encode('utf-8'))
                if total > 8_000_000:
                    return result
                result[str(path)] = text
            if len(result) >= 1000:
                return result
    return result


async def status(request):
    return web.json_response({'connected': True, 'kind': 'linux-container', 'platform': os.uname().machine, 'python': os.sys.version.split()[0], 'home': str(HOME)})


async def workspace(request):
    if request.method == 'GET':
        return web.json_response({'files': await asyncio.to_thread(snapshot)})
    data = await request.json()
    ops = data.get('operations')
    if not isinstance(ops, list) or len(ops) > 2000:
        raise ValueError('Invalid operations')
    # Validate the complete batch before changing any files.
    for op in ops:
        path = safe_path(op['path'])
        if path == HOME:
            raise ValueError('The home directory cannot be replaced')
        if op['kind'] not in {'write', 'mkdir', 'delete'}:
            raise ValueError('Invalid operation')
        if op['kind'] == 'write' and (not isinstance(op.get('content'), str) or len(op['content'].encode()) > MAX_FILE):
            raise ValueError('Text files must be smaller than 2 MB')
        if op['kind'] == 'write' and path.exists() and not path.is_file():
            raise ValueError('Cannot replace a folder with a file')
    for op in ops:
        path = safe_path(op['path'])
        if op['kind'] == 'delete':
            if path.is_dir():
                path.rmdir()  # Only empty folders; children must be explicit operations.
            elif path.exists():
                path.unlink()
        elif op['kind'] == 'mkdir':
            path.mkdir(parents=True, exist_ok=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name('.' + path.name + '.pilab-' + secrets.token_hex(4))
            try:
                temporary.write_text(op['content'], encoding='utf-8')
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
    return web.json_response({'ok': True})


def kill_group(pid, sig=signal.SIGTERM):
    with contextlib.suppress(ProcessLookupError):
        os.killpg(pid, sig)


async def terminal(request):
    ws = web.WebSocketResponse(heartbeat=25, max_msg_size=65536)
    await ws.prepare(request)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(HOME)
        os.environ.update(HOME=str(HOME), TERM='xterm-256color', COLORTERM='truecolor', PS1='\\[\\e[32m\\]root@pilab\\[\\e[0m\\]:\\w\\$ ')
        os.execv('/bin/bash', ['bash', '--noprofile', '--norc', '-i'])
    os.set_blocking(fd, False)
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue(maxsize=128)

    def readable():
        try:
            chunk = os.read(fd, 16384)
        except BlockingIOError:
            return
        except OSError:
            chunk = b''
        if not chunk:
            loop.remove_reader(fd)
        try:
            queue.put_nowait(chunk)
        except asyncio.QueueFull:
            loop.remove_reader(fd)
            # Disconnect a stalled consumer instead of accumulating unlimited output.
            asyncio.create_task(ws.close(code=1013, message=b'Terminal output exceeded the client buffer'))

    loop.add_reader(fd, readable)

    async def pump():
        while True:
            chunk = await queue.get()
            if not chunk:
                await ws.close()
                return
            await ws.send_bytes(chunk)

    pump_task = asyncio.create_task(pump())
    try:
        async for message in ws:
            if message.type == WSMsgType.TEXT:
                try:
                    data = json.loads(message.data)
                    if data.get('type') == 'input':
                        value = data.get('data', '')
                        if isinstance(value, str):
                            os.write(fd, value.encode()[:32768])
                    elif data.get('type') == 'resize':
                        rows = max(2, min(300, int(data.get('rows', 24))))
                        cols = max(10, min(500, int(data.get('cols', 80))))
                        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                except (ValueError, TypeError, OSError):
                    continue
    finally:
        loop.remove_reader(fd)
        pump_task.cancel()
        kill_group(pid, signal.SIGKILL)
        os.close(fd)
        with contextlib.suppress(ChildProcessError):
            await asyncio.to_thread(os.waitpid, pid, 0)
        with contextlib.suppress(asyncio.CancelledError):
            await pump_task
    return ws


async def run_python(request):
    ws = web.WebSocketResponse(heartbeat=25, max_msg_size=2_100_000)
    await ws.prepare(request)
    process = None
    try:
        first = await asyncio.wait_for(ws.receive_json(), timeout=10)
        code = first.get('code')
        if not isinstance(code, str) or len(code.encode()) > MAX_FILE:
            raise ValueError('Python source must be smaller than 2 MB')
        path = safe_path(first.get('path', str(HOME/'Python/untitled.py')))
        if not path.parent.is_dir():
            raise ValueError('The source folder does not exist')
        runner = 'import sys; __file__=sys.argv[1]; sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent)); exec(compile(sys.argv[2], __file__, "exec"))'
        process = await asyncio.create_subprocess_exec('python3', '-u', '-c', runner, str(path), code, cwd=path.parent, env={**os.environ, 'HOME': str(HOME)}, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, start_new_session=True)

        async def output():
            while chunk := await process.stdout.read(8192):
                await ws.send_json({'type': 'output', 'text': chunk.decode('utf-8', errors='replace')})
            exit_code = await process.wait()
            await ws.send_json({'type': 'done', 'exitCode': exit_code})
            await ws.close()

        async def receive():
            async for message in ws:
                if message.type == WSMsgType.TEXT:
                    data = json.loads(message.data)
                    if data.get('type') == 'stop':
                        kill_group(process.pid, signal.SIGKILL)
                    elif data.get('type') == 'input' and process.returncode is None:
                        process.stdin.write(str(data.get('text', '')).encode()[:65536])
                        await process.stdin.drain()

        out_task = asyncio.create_task(output())
        in_task = asyncio.create_task(receive())
        try:
            done, _ = await asyncio.wait({out_task, in_task}, timeout=600, return_when=asyncio.FIRST_COMPLETED)
            if not done:
                await ws.send_json({'type': 'output', 'text': '\nStopped after the 10 minute run limit.\n'})
        finally:
            if process.returncode is None:
                kill_group(process.pid, signal.SIGKILL)
            await process.wait()
            for task in (out_task, in_task):
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, ConnectionError):
                    await task
    except (ValueError, OSError, asyncio.TimeoutError) as exc:
        if not ws.closed:
            await ws.send_json({'type': 'error', 'text': str(exc)})
    finally:
        if process and process.returncode is None:
            kill_group(process.pid, signal.SIGKILL)
            await process.wait()
        await ws.close()
    return ws


async def index(request):
    response = web.FileResponse(ROOT/'dist/index.html')
    response.set_cookie('pilab_session', TOKEN, httponly=True, samesite='Strict')
    return response


def seed():
    HOME.mkdir(parents=True, exist_ok=True)
    for name in ['Desktop', 'Documents', 'Downloads', 'Python']:
        (HOME/name).mkdir(exist_ok=True)
    examples = {
        'Python/hello.py': 'name = input("Your name: ")\nprint(f"Hello, {name}! Running in real Linux.")\n',
        'Python/system_info.py': 'import os, platform, sys\nprint("System:", platform.platform())\nprint("Python:", sys.version)\nprint("Files:", os.listdir("/home/pi"))\n',
        'Documents/Welcome.txt': 'Pi Lab — real Linux container\n\nTerminal is a real Bash shell. Try ls, python3, nano, git, or apt.\nPython Editor executes CPython in the same filesystem. input() is supported.\nFiles in /home/pi persist in a Docker volume.\nThis is Debian Linux on your machine, not Raspberry Pi OS or ARM hardware.\nGPIO requires real hardware and is not available in this container.\nDo not expose this single-user development service to the internet.\n',
    }
    for name, text in examples.items():
        path = HOME/name
        if not path.exists():
            path.write_text(text)


if __name__ == '__main__':
    seed()
    app = web.Application(middlewares=[local_only], client_max_size=12_000_000)
    app.add_routes([web.get('/', index), web.get('/api/status', status), web.get('/api/workspace', workspace), web.post('/api/workspace', workspace), web.get('/api/terminal', terminal), web.get('/api/run', run_python)])
    app.router.add_static('/', ROOT/'dist', show_index=False)
    web.run_app(app, host='0.0.0.0', port=4180, access_log=None)
