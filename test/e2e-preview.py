#!/usr/bin/env python3
"""End-to-end checks against a private preview OpenCode server and the real Codex CLI.

Run from the repository root: python3 test/e2e-preview.py
Uses the installed Codex and Claude logins; never touches the shared OpenCode service.
"""
import base64, json, os, pathlib, re, signal, subprocess, sys, tempfile, time, urllib.request, urllib.error

root = pathlib.Path(__file__).resolve().parent.parent
trace_file = tempfile.NamedTemporaryFile(prefix='codex-trace-', suffix='.jsonl', delete=False).name
env = {**os.environ, 'OPENCODE_CODEX_TRACE': trace_file}
proc = subprocess.Popen(['bash', str(root / 'preview.sh'), 'serve'], cwd=root, env=env,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
failures = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)
    if not ok:
        failures.append(name)


def traces():
    return [json.loads(line) for line in pathlib.Path(trace_file).read_text().splitlines() if line.strip()]


try:
    addr = re.fullmatch(r'server listening on (http://127\.0\.0\.1:\d+)\n', proc.stdout.readline()).group(1)
    password = re.fullmatch(r'server password (\S+)\n', proc.stdout.readline()).group(1)
    auth = 'Basic ' + base64.b64encode(f'opencode:{password}'.encode()).decode()

    def req(path, body=None, method=None, timeout=240):
        request = urllib.request.Request(addr + path, method=method,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={'Authorization': auth, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = response.read()
                return json.loads(data) if data else None
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'{path}: {error.code} {error.read()[:300]!r}') from None

    def data(x):
        return x.get('data', x) if isinstance(x, dict) else x

    def new_session(agent, title):
        return data(req('/api/session', {'agent': agent, 'title': title,
                                         'location': {'directory': str(root / 'demo')}}))['id']

    def wait(sid):
        req(f'/api/experimental/session/{sid}/wait', method='POST')

    def messages(sid):
        return data(req(f'/api/session/{sid}/message'))  # newest first

    def last_text(sid):
        for item in messages(sid):
            if item.get('type') == 'assistant':
                return ' '.join(p.get('text', '') for p in item.get('content') or [] if p.get('type') == 'text').strip()
        return ''

    def failed_steps(sid):
        return [i for i in messages(sid) if i.get('type') == 'idle' and i.get('outcome') not in ('succeeded', None)]

    def turn(sid, text, **extra):
        req(f'/api/session/{sid}/prompt', {'text': text, **extra})
        wait(sid)
        return last_text(sid)

    def modes(sid, since):
        return [t.get('mode') for t in traces()[since:] if t.get('session') == sid and 'mode' in t]

    # 1. Fresh Codex session: first turn new, second resumes the same thread.
    sid = new_session('codex', 'fresh')
    n = len(traces())
    a1 = turn(sid, 'Remember the code ORCHID-512. Reply with exactly READY.')
    a2 = turn(sid, 'Reply with exactly the code I gave you. Do not read files.')
    check('fresh: two turns', a1 == 'READY' and 'ORCHID-512' in a2, f'{a1!r} / {a2!r}')
    check('fresh: new then resume', modes(sid, n) == ['new', 'resume'], str(modes(sid, n)))
    session = data(req(f'/api/session/{sid}'))
    check('title request does not fail', not failed_steps(sid), f"title={session.get('title')!r}")

    # 2. Message sent while Codex is running (steer delivery).
    n = len(traces())
    req(f'/api/session/{sid}/prompt', {'text': 'Use your shell to run `sleep 6`, then reply with exactly SLEPT.'})
    time.sleep(2)
    req(f'/api/session/{sid}/prompt', {'text': 'Also reply with exactly SECOND.', 'delivery': 'steer'})
    wait(sid)
    texts = [' '.join(p.get('text', '') for p in i.get('content') or [] if p.get('type') == 'text')
             for i in messages(sid) if i.get('type') == 'assistant']
    m = modes(sid, n)
    check('steer: both prompts answered on the same Codex thread',
          any('SECOND' in t for t in texts[:2]) and m and all(x.startswith('resume') for x in m),
          f'modes={m} latest={texts[:2]}')

    # 3. Interrupt a running turn, then continue in the same session.
    n = len(traces())
    req(f'/api/session/{sid}/prompt', {'text': 'Use your shell to run `sleep 40`, then reply with exactly LATE.'})
    time.sleep(6)
    req(f'/api/session/{sid}/interrupt', method='POST')
    wait(sid)
    leftover = subprocess.run(['pgrep', '-f', 'codex exec.*resume'], capture_output=True, text=True).stdout.split()
    a = turn(sid, 'Reply with exactly AFTER-INTERRUPT.')
    check('interrupt: no Codex process left, next turn works on the same thread',
          'AFTER-INTERRUPT' in a and not leftover and modes(sid, n)[-1].startswith('resume'),
          f'{a!r} leftover={leftover} modes={modes(sid, n)}')

    # 4. Codex -> Claude -> Codex in the same session.
    n = len(traces())
    req(f'/api/session/{sid}/agent', {'agent': 'claude'})
    c = turn(sid, 'Reply with exactly CLAUDE-HERE and the code ORCHID from earlier, nothing else.')
    req(f'/api/session/{sid}/agent', {'agent': 'codex'})
    b = turn(sid, 'What did the previous assistant reply, verbatim? Do not read files.')
    check('switch back: Codex sees the Claude turn', 'CLAUDE-HERE' in b and modes(sid, n)[-1:] == ['seed'],
          f'claude={c!r} codex={b!r} modes={modes(sid, n)}')

    # 5. Revert to an earlier user message, then continue.
    target = next(i for i in messages(sid) if i.get('type') == 'user' and 'previous assistant' in (i.get('text') or ''))
    req(f'/api/session/{sid}/revert/stage', {'messageID': target['id']})
    req(f'/api/session/{sid}/revert/commit', method='POST')
    n = len(traces())
    r = turn(sid, 'Reply with exactly REVERTED-OK.')
    check('revert: next turn reseeds and works', 'REVERTED-OK' in r and modes(sid, n) == ['seed'], f'{r!r} {modes(sid, n)}')

    # 6. Fork the session and continue in the fork.
    fork = data(req(f'/api/session/{sid}/fork', {}))['id']
    n = len(traces())
    f = turn(fork, 'Reply with exactly the code that starts with ORCHID. Do not read files.')
    check('fork: works with the inherited history', 'ORCHID-512' in f and modes(fork, n) == ['seed'], f'{f!r} {modes(fork, n)}')

    auto = [i for i in messages(sid) if i.get('type') == 'compaction' and i.get('reason') == 'auto']
    check('no spurious auto-compaction after shell-heavy turns', not auto, f'{len(auto)} auto compactions')

    # 7. Manual compaction, then continue.
    req(f'/api/session/{sid}/compact', {})
    wait(sid)
    n = len(traces())
    k = turn(sid, 'Reply with exactly the code that starts with ORCHID. Do not read files.')
    compactions = [i for i in messages(sid) if i.get('type') == 'compaction']
    check('compaction: completes and context survives',
          compactions and compactions[0].get('status') == 'completed' and 'ORCHID-512' in k,
          f'{k!r} status={compactions[0].get("status") if compactions else None} modes={modes(sid, n)}')

    errors = [t for t in traces() if 'error' in t]
    print('bridge errors overall:', errors)
finally:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
    print('trace:', trace_file)

sys.exit(1 if failures else 0)
