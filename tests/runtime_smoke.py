"""Run inside the container: python3 - < tests/runtime_smoke.py."""
import asyncio
import json
from aiohttp import ClientSession, CookieJar, WSMsgType

BASE='http://127.0.0.1:4180'

async def main():
    passed=[]
    async with ClientSession(cookie_jar=CookieJar(unsafe=True)) as session:
        assert (await session.get(BASE+'/api/status')).status==403
        passed.append('API requires a local session')
        await session.get(BASE+'/')
        info=await (await session.get(BASE+'/api/status')).json()
        assert info['kind']=='linux-container'
        passed.append('Real Linux status')
        response=await session.post(BASE+'/api/workspace',json={'operations':[{'kind':'write','path':'/etc/escape.txt','content':'no'}]})
        assert response.status==400
        passed.append('File API rejects paths outside workspace')
        assert (await session.get(BASE+'/api/status',headers={'Origin':'https://evil.example'})).status==403
        passed.append('Cross-origin requests rejected')
        response=await session.post(BASE+'/api/workspace',json={'operations':[{'kind':'write','path':'/home/pi/Python/smoke.py','content':'print(6 * 7)\n'}]})
        assert response.status==200
        passed.append('File API writes real Linux files')

        async def run(code,inputs=()):
            messages=[]
            async with session.ws_connect(BASE+'/api/run',origin=BASE) as ws:
                await ws.send_json({'code':code,'path':'/home/pi/Python/smoke.py'})
                for value in inputs:
                    await ws.send_json({'type':'input','text':value+'\n'})
                async with asyncio.timeout(20):
                    async for message in ws:
                        if message.type==WSMsgType.TEXT: messages.append(json.loads(message.data))
            return messages

        messages=await run('import platform; print(platform.system()); print(6*7)')
        output=''.join(m.get('text','') for m in messages)
        assert 'Linux' in output and '42' in output and any(m.get('exitCode')==0 for m in messages)
        passed.append('CPython execution and streaming stdout')
        messages=await run('name=input("Name: "); print("Hello "+name)',['Student'])
        assert 'Hello Student' in ''.join(m.get('text','') for m in messages)
        passed.append('Python input() receives stdin')
        messages=await run('raise ValueError("smoke-error")')
        assert 'ValueError: smoke-error' in ''.join(m.get('text','') for m in messages)
        assert any(m.get('exitCode')==1 for m in messages)
        passed.append('Python errors and nonzero exit code')
        async with session.ws_connect(BASE+'/api/run',origin=BASE) as ws:
            await ws.send_json({'code':'while True: pass','path':'/home/pi/Python/smoke.py'})
            await ws.send_json({'type':'stop'})
            async with asyncio.timeout(10):
                messages=[json.loads(m.data) async for m in ws if m.type==WSMsgType.TEXT]
            assert any(m.get('exitCode',0)<0 for m in messages)
        passed.append('Stop interrupts infinite Python loop')
        await run('from pathlib import Path; Path("/home/pi/Documents/from_python.txt").write_text("shared filesystem")')
        assert (await (await session.get(BASE+'/api/workspace')).json())['files']['/home/pi/Documents/from_python.txt']=='shared filesystem'
        passed.append('Python and File Manager share files')
        async with session.ws_connect(BASE+'/api/terminal',origin=BASE) as ws:
            await ws.send_json({'type':'resize','cols':100,'rows':30})
            await ws.send_json({'type':'input','data':"printf 'alpha\\nbeta\\n' | wc -l; python3 /home/pi/Python/smoke.py; printf '\\nPTY_OK\\n'\r"})
            output=''
            async with asyncio.timeout(15):
                async for message in ws:
                    if message.type==WSMsgType.BINARY: output+=message.data.decode(errors='replace')
                    if '\r\nPTY_OK\r\n' in output: break
            assert '2\r\n' in output and '42\r\n' in output, repr(output)
            passed.append('Real Bash pipes and saved Python execution')
            await ws.send_json({'type':'input','data':'nano /home/pi/Python/smoke.py\r'})
            screen=''
            async with asyncio.timeout(10):
                async for message in ws:
                    if message.type==WSMsgType.BINARY: screen+=message.data.decode(errors='replace')
                    if 'GNU nano' in screen: break
            assert 'GNU nano' in screen
            await ws.send_json({'type':'input','data':'\x18'})
            passed.append('Full-screen nano runs in PTY')
    print(json.dumps({'passed':passed,'count':len(passed)},indent=2))

asyncio.run(main())
