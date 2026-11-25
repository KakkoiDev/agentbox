"""A loopback proxy to DeepSeek's own API, so pi can use DeepSeek's hosted model from inside agentbox's sandbox.

- The sandbox lets the agent reach only localhost; this proxy is the only thing that talks to api.deepseek.com, and
  only for chat completions.
- The API key stays here: read from ~/.config/deepseek/api-key (or $DEEPSEEK_API_KEY_FILE), never written into pi's
  config, never logged.
- DeepSeek's thinking mode with tools needs every earlier turn's `reasoning_content` sent back (else HTTP 400); the
  proxy puts it back if a client dropped it.
- Every request's tokens and cost go to <state>/deepseek-usage.jsonl, and a spending cap (<state>/deepseek-budget.json,
  default $25) stops requests once it is reached.

Model ids (`--model deepseek/<id>`), each served by deepseek-flash:
    flash       follows pi's --thinking: off, high or max
    flash-max   thinking at effort max, whatever pi asks
    flash-high  thinking at effort high
    flash-off   no thinking

    agentbox proxy           # serves 127.0.0.1:8096 until stopped (agentbox starts it for you when needed)
    agentbox spent           # what has been spent so far
"""
import hashlib, json, os, sys, threading, time, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .paths import STATE

PORT = 8096
UPSTREAM = 'https://api.deepseek.com/chat/completions'
KEY_FILE = Path(os.environ.get('DEEPSEEK_API_KEY_FILE') or Path.home() / '.config' / 'deepseek' / 'api-key')
USAGE = STATE / 'deepseek-usage.jsonl'
BUDGET = STATE / 'deepseek-budget.json'
MODELS = {'flash': ('deepseek-flash', 'client'), 'flash-max': ('deepseek-flash', 'max'),
          'flash-high': ('deepseek-flash', 'high'), 'flash-off': ('deepseek-flash', None)}
# $ per 1M tokens (api-docs.deepseek.com/quick_start/pricing, read 2026-11-24), off-peak; peak hours cost double
PRICE = dict(hit=0.003, miss=0.15, out=0.6)
LOCK = threading.Lock()
REASONING = {}   # tool-call id or hash of reply text -> reasoning_content DeepSeek sent with it


def peak(t=None):
    """DeepSeek's peak hours, when prices double: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday."""
    g = time.gmtime(t)
    return g.tm_wday < 5 and (1 <= g.tm_hour < 4 or 6 <= g.tm_hour < 10)


def cost(u, t=None):
    hit = u.get('prompt_cache_hit_tokens', 0)
    miss = u.get('prompt_cache_miss_tokens', max(0, u.get('prompt_tokens', 0) - hit))
    c = (hit * PRICE['hit'] + miss * PRICE['miss'] + u.get('completion_tokens', 0) * PRICE['out']) / 1e6
    return c * (2 if peak(t) else 1)


def spent():
    if not USAGE.exists():
        return 0.0
    return sum(json.loads(l).get('cost', 0) for l in USAGE.read_text().splitlines() if l.strip())


def cap():
    return json.loads(BUDGET.read_text()).get('usd', 25) if BUDGET.exists() else 25


def text_key(content):
    return 'c:' + hashlib.sha256((content or '').strip().encode()).hexdigest()


def remember(msg):
    rc = msg.get('reasoning_content')
    if not rc:
        return
    with LOCK:
        for tc in msg.get('tool_calls') or []:
            if tc.get('id'):
                REASONING[tc['id']] = rc
        if (msg.get('content') or '').strip():
            REASONING[text_key(msg['content'])] = rc


def restore(messages):
    n = 0
    for m in messages:
        if m.get('role') != 'assistant' or m.get('reasoning_content'):
            continue
        ids = [tc.get('id') for tc in m.get('tool_calls') or []]
        rc = next((REASONING[i] for i in ids if i in REASONING), None) or REASONING.get(text_key(m.get('content') if isinstance(m.get('content'), str) else ''))
        m['reasoning_content'] = rc or ''
        n += bool(rc)
    return n


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.rstrip('/').endswith('/models'):
            return self.reply(200, {'object': 'list', 'data': [{'id': k, 'object': 'model'} for k in MODELS]})
        self.reply(404, {'error': 'not found'})

    def do_POST(self):
        if not self.path.rstrip('/').endswith('/chat/completions'):
            return self.reply(404, {'error': {'message': 'only /v1/chat/completions'}})
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        if spent() >= cap():
            return self.reply(429, {'error': {'message': f'DeepSeek budget reached (${cap()}); raise it in {BUDGET}'}})
        alias = body.get('model', '')
        if alias not in MODELS:
            return self.reply(400, {'error': {'message': f'unknown model {alias}; one of {list(MODELS)}'}})
        model, effort = MODELS[alias]
        body['model'] = model
        if effort == 'client':   # pi's own --thinking (thinkingFormat deepseek); DeepSeek has two efforts, high and max
            body.pop('store', None)
            if (body.get('thinking') or {}).get('type') == 'enabled':
                effort = 'max' if body.get('reasoning_effort') in ('xhigh', 'max') else 'high'
            else:
                effort = None
        else:
            for k in ('reasoning_effort', 'reasoning', 'thinking', 'store', 'temperature', 'top_p'):
                body.pop(k, None)
        if effort:
            body['thinking'] = {'type': 'enabled'}
            body['reasoning_effort'] = effort
        else:
            body['thinking'] = {'type': 'disabled'}
            body.pop('reasoning_effort', None)
        restored = restore(body.get('messages', []))
        stream = bool(body.get('stream'))
        if stream:
            body['stream_options'] = {'include_usage': True}
        req = urllib.request.Request(UPSTREAM, json.dumps(body).encode(), method='POST', headers={
            'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY_FILE.read_text().strip()})
        t0 = time.time()
        for attempt in range(4):
            try:
                up = urllib.request.urlopen(req, timeout=900)
                break
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503) and attempt < 3:
                    time.sleep(10 * (attempt + 1))
                    continue
                return self.reply(e.code, json.loads(e.read() or b'{}') if e.headers.get_content_type() == 'application/json' else {'error': {'message': f'upstream {e.code}'}})
            except Exception as e:
                if attempt < 3:
                    time.sleep(10 * (attempt + 1))
                    continue
                return self.reply(502, {'error': {'message': f'upstream: {e}'}})
        usage, served = {}, None
        if not stream:
            data = json.loads(up.read())
            usage, served = data.get('usage') or {}, data.get('model')
            for ch in data.get('choices', []):
                remember(ch.get('message') or {})
            self.reply(200, data)
        else:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Connection', 'close')
            self.end_headers()
            acc = {}
            for line in up:
                try:
                    self.wfile.write(line)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    break
                s = line.decode('utf-8', 'replace').strip()
                if not s.startswith('data:') or s == 'data: [DONE]':
                    continue
                try:
                    ev = json.loads(s[5:])
                except ValueError:
                    continue
                served = ev.get('model') or served
                if ev.get('usage'):
                    usage = ev['usage']
                for ch in ev.get('choices') or []:
                    m = acc.setdefault(ch.get('index', 0), {'content': '', 'reasoning_content': '', 'tool_calls': {}})
                    d = ch.get('delta') or {}
                    m['content'] += d.get('content') or ''
                    m['reasoning_content'] += d.get('reasoning_content') or ''
                    for tc in d.get('tool_calls') or []:
                        if tc.get('id'):
                            m['tool_calls'][tc.get('index', 0)] = tc['id']
            for m in acc.values():
                remember(dict(content=m['content'], reasoning_content=m['reasoning_content'],
                              tool_calls=[{'id': i} for i in m['tool_calls'].values()]))
            self.close_connection = True
        rec = dict(t=time.strftime('%FT%TZ', time.gmtime()), alias=alias, effort=effort or 'off', served=served,
                   seconds=round(time.time() - t0, 1), usage=usage, cost=round(cost(usage), 6), peak=peak(), restored_reasoning=restored)
        with LOCK, open(USAGE, 'a') as f:
            f.write(json.dumps(rec) + '\n')


def serve():
    if not KEY_FILE.exists():
        sys.exit(f'no DeepSeek API key: save it in {KEY_FILE} (chmod 600)')
    STATE.mkdir(parents=True, exist_ok=True)
    print(f'DeepSeek proxy on 127.0.0.1:{PORT}; spent ${spent():.4f} of ${cap()}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()


if __name__ == '__main__':
    serve()
