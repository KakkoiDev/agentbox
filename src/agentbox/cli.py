"""agentbox: open the pi coding agent in the current folder, inside a macOS sandbox, with any model.

    agentbox                                   # the default model (config, or the first Ollama model)
    agentbox --model deepseek/flash --thinking max
    agentbox --model ollama/qwen3.8:27b -p "fix the failing test"   # anything after the options goes to pi
    agentbox models | proxy | spent | install <pi package> | doctor | harness --model M

The sandbox (built fresh for every run):
- writes only in the current folder, agentbox's own state (pi's sessions) and a private temp folder;
- reads nothing else in your home folder (except git's config and the folders pi and node are installed in),
  and never ~/.ssh, ~/.aws, ~/.gnupg, keychains or API keys, even when the current folder is above them;
- network only to the model's own port on localhost (--net lifts this).
"""
import argparse, json, os, re, shutil, socket, subprocess, sys, time, urllib.request
from pathlib import Path

from . import __version__
from .paths import CONFIG, HERE, PI_HOME, STATE

HOME = Path.home()
OLLAMA = os.environ.get('OLLAMA_HOST_URL', 'http://127.0.0.1:11434')
PORTS = {'ollama': 11434, 'deepseek': 8096}
SECRETS = ['.ssh', '.gnupg', '.aws', '.config/gh', '.config/deepseek', '.netrc', '.docker/config.json', '.kube',
           'Library/Keychains', '.pi/agent/auth.json', '.config/agentbox', '.git-credentials']
DEEPSEEK_MODELS = [{'id': 'flash', 'reasoning': True, 'contextWindow': 1000000, 'maxTokens': 131072,
                    'thinkingLevelMap': {'minimal': None, 'low': None, 'medium': None, 'high': 'high', 'xhigh': None, 'max': 'max'}}] + \
                  [{'id': i, 'reasoning': False, 'contextWindow': 1000000, 'maxTokens': 131072} for i in ('flash-max', 'flash-high', 'flash-off')]


def config():
    try:
        return json.loads(CONFIG.read_text())
    except (OSError, ValueError):
        return {}


def die(msg):
    sys.exit(f'agentbox: {msg}')


def http_json(url, data=None, timeout=3):
    req = urllib.request.Request(url, json.dumps(data).encode() if data is not None else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def ollama_models():
    try:
        return [m['name'] for m in http_json(OLLAMA + '/api/tags')['models']]
    except Exception:
        return []


def ollama_context(name):
    """The context Ollama will give the model: its num_ctx if set, else its trained length capped at 32k for GGUF."""
    try:
        j = http_json(OLLAMA + '/api/show', {'model': name}, timeout=10)
    except Exception:
        return 32768
    m = re.search(r'num_ctx\s+(\d+)', j.get('parameters') or '')
    if m:
        return int(m[1])
    trained = next((v for k, v in (j.get('model_info') or {}).items() if k.endswith('.context_length')), 32768)
    return trained if (j.get('details') or {}).get('format') != 'gguf' else min(trained, 32768)


def write_pi_config(model):
    """agentbox's own pi config (not ~/.pi): Ollama's models and DeepSeek's, other providers you added kept as they are."""
    PI_HOME.mkdir(parents=True, exist_ok=True)
    mj = PI_HOME / 'models.json'
    cfg = json.loads(mj.read_text()) if mj.exists() else {}
    prov = cfg.setdefault('providers', {})
    prov['ollama'] = {'api': 'openai-completions', 'apiKey': 'ollama', 'baseUrl': OLLAMA + '/v1',
                      'compat': {'supportsStore': False, 'supportsStrictMode': False},
                      'models': [dict({'id': n}, **({'contextWindow': ollama_context(n)} if model == f'ollama/{n}' else {}))
                                 for n in ollama_models()]}
    prov['deepseek'] = {'api': 'openai-completions', 'apiKey': 'proxy', 'baseUrl': 'http://127.0.0.1:8096/v1',
                        'compat': {'supportsStore': False, 'supportsStrictMode': False, 'thinkingFormat': 'deepseek',
                                   'supportsReasoningEffort': True, 'requiresReasoningContentOnAssistantMessages': True},
                        'models': DEEPSEEK_MODELS}
    mj.write_text(json.dumps(cfg, indent=1))
    st = PI_HOME / 'settings.json'
    s = json.loads(st.read_text()) if st.exists() else {}
    s.setdefault('quietStartup', 'header')
    st.write_text(json.dumps(s, indent=1))
    return cfg


def port_of(cfg, provider):
    url = cfg.get('providers', {}).get(provider, {}).get('baseUrl', '')
    m = re.match(r'https?://(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)', url)
    return int(m[1]) if m else None


def listening(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0


def ensure_proxy():
    from . import proxy
    if listening(proxy.PORT):
        return
    if not proxy.KEY_FILE.exists():
        die(f'no DeepSeek API key: save it in {proxy.KEY_FILE} (chmod 600)')
    STATE.mkdir(parents=True, exist_ok=True)
    log = open(STATE / 'proxy.log', 'a')
    subprocess.Popen([sys.executable, '-m', 'agentbox.proxy'], stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                     start_new_session=True, cwd=str(STATE))
    for _ in range(50):
        if listening(proxy.PORT):
            print(f'agentbox: started the DeepSeek proxy (127.0.0.1:{proxy.PORT}, log {STATE / "proxy.log"})', file=sys.stderr)
            return
        time.sleep(0.1)
    die(f'the DeepSeek proxy did not start: see {STATE / "proxy.log"}')


def install_root(exe):
    """The folder a tool is installed in, so the sandbox can let it read its own files when it lives in your home."""
    p = shutil.which(exe)
    if not p:
        return None
    real = Path(os.path.realpath(p))
    for parent in real.parents:   # .../lib/node_modules/<pkg>/... or a version folder of nvm, fnm, volta, asdf, ...
        if parent.parent == HOME or parent == HOME:
            return parent
    return real.parent.parent


def q(p):
    return '"' + str(p).replace('\\', '\\\\').replace('"', '\\"') + '"'


def sandbox_profile(work, tmp, cache, port, net, extra_reads=()):
    reads = [work, STATE, tmp, HERE, *extra_reads] + [p for p in (install_root('pi'), install_root('node'), HOME / '.local/share/uv/python',
                                               HOME / '.gitconfig', HOME / '.config/git') if p]
    L = ['(version 1)', '; written by agentbox for one run; the last matching rule wins', '(allow default)', '',
         '(deny file-write*)',
         '(allow file-write*', f'  (subpath {q(work)}) (subpath {q(STATE)}) (subpath {q(tmp)}) (subpath {q(cache)})',
         '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/ptmx") (regex #"^/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/pty"))', '',
         f'(deny file-read* (subpath {q(HOME)}))',
         '(allow file-read*'] + [f'  (subpath {q(p)})' for p in reads] + [')',
         f'(allow file-read-metadata (subpath {q(HOME)}))   ; node resolves the current folder through its parents', '',
         '(deny file-read* file-write*'] + [f'  (subpath {q(HOME / s)})' for s in SECRETS] + [')', '',
         '; the shared temp folders hold other programs\' files: only this run\'s own',
         '(deny file-read* file-write* (subpath "/private/tmp") (subpath "/private/var/folders"))',
         '(allow file-read-metadata (literal "/private/tmp") (literal "/tmp") (literal "/private/var/folders"))',
         f'(allow file-read* file-write* (subpath {q(tmp)}) (subpath {q(cache)}))', '']
    if not net:
        L += ['(deny network-outbound)', '(allow network-outbound (remote unix-socket)'
              + (f' (remote ip "localhost:{port}")' if port else '') + ')']
    return '\n'.join(L) + '\n'


def run(a, rest):
    if sys.platform != 'darwin':
        die('agentbox needs macOS (sandbox-exec)')
    if not shutil.which('pi'):
        die('pi is not installed (the pi coding agent, version 1.1 or later)')
    cfg_user = config()
    work = Path.cwd().resolve()
    if not a.allow_home and (work == HOME or HOME.is_relative_to(work)):
        die(f'{work} holds your whole home folder; run agentbox in a project folder (or pass --allow-home)')
    model = a.model or cfg_user.get('model') or next((f'ollama/{m}' for m in ollama_models()), None)
    if not model or '/' not in model:
        die('no model: pass --model provider/id (agentbox models lists them)')
    cfg = write_pi_config(model)
    prov, _, mid = model.partition('/')
    known = [m['id'] for m in cfg.get('providers', {}).get(prov, {}).get('models', [])]
    if prov in cfg.get('providers', {}) and mid not in known:   # pi would quietly run a similar-named model instead
        die(f'{model} is not a known model; {prov} has: {", ".join(known) or "none"}')
    if prov == 'deepseek':
        from . import proxy
        ensure_proxy()
        if proxy.peak():
            print('agentbox: DeepSeek peak hours (01-04 and 06-10 UTC, Mon-Fri): prices are doubled now', file=sys.stderr)
    port = port_of(cfg, prov) or PORTS.get(prov)
    tmp = STATE / 'tmp' / str(os.getpid())
    tmp.mkdir(parents=True, exist_ok=True)
    cache = Path(os.path.realpath(subprocess.run(['getconf', 'DARWIN_USER_CACHE_DIR'], capture_output=True, text=True).stdout.strip() or tmp))
    from . import harness
    thinking = a.thinking or cfg_user.get('thinking')
    h = harness.for_model(model, thinking)
    user_exts = [str(Path(harness.resolve_extension(e)).expanduser()) for e in cfg_user.get('extensions', [])]
    exts = [e['path'] for e in h['extensions']] + user_exts
    cmd = ['pi', '--model', model] + (['--thinking', thinking] if thinking else [])
    cmd += h['pi_args'] + [x for e in user_exts for x in ('-e', e)] + rest
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(PI_HOME), TMPDIR=str(tmp) + '/')
    if a.no_sandbox:
        print('agentbox: no sandbox: the agent can read and write anything you can', file=sys.stderr)
        os.execvpe(cmd[0], cmd, env)
    prof = tmp / 'sandbox.sb'
    prof.write_text(sandbox_profile(work, tmp, cache, port, a.net or cfg_user.get('net'), [Path(e).parent for e in exts]))
    os.execvpe('sandbox-exec', ['sandbox-exec', '-f', str(prof)] + cmd, env)


def models(_a, _rest):
    for m in ollama_models():
        print(f'ollama/{m}')
    for m in DEEPSEEK_MODELS:
        print(f"deepseek/{m['id']}" + ('   (follows --thinking off|high|max)' if m['id'] == 'flash' else ''))


def doctor(_a, _rest):
    from . import proxy
    checks = [('macOS sandbox-exec', bool(shutil.which('sandbox-exec'))), ('pi', bool(shutil.which('pi'))),
              ('node', bool(shutil.which('node'))), ('Ollama answering', bool(ollama_models())),
              (f'DeepSeek key ({proxy.KEY_FILE})', proxy.KEY_FILE.exists()),
              ('DeepSeek proxy running', listening(proxy.PORT))]
    for name, ok in checks:
        print(f"{'ok ' if ok else '-- '} {name}")
    if shutil.which('pi'):
        print('    pi ' + subprocess.run(['pi', '--version'], capture_output=True, text=True).stdout.strip())
    print(f'    state: {STATE}   config: {CONFIG}')


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    sub = {'models': models, 'doctor': doctor}
    if argv and argv[0] in ('proxy', 'spent', 'install', 'models', 'doctor', 'harness'):
        cmd, rest = argv[0], argv[1:]
        if cmd == 'harness':   # what a run gets for a model; --json for bench runners
            from . import harness
            hp = argparse.ArgumentParser(prog='agentbox harness')
            hp.add_argument('--model', '-m', required=True)
            hp.add_argument('--thinking', '-t')
            hp.add_argument('--json', action='store_true')
            ha = hp.parse_args(rest)
            h = dict(harness.for_model(ha.model, ha.thinking), version=__version__)
            if ha.json:
                return print(json.dumps(h))
            for e in h['extensions']:
                print(f"extension {e['path']}\n    {e['why']}")
            for pr in h['prompts']:
                print(f"prompt {pr['text']!r}\n    {pr['why']}")
            return
        if cmd == 'proxy':
            from . import proxy
            return proxy.serve()
        if cmd == 'spent':
            from . import proxy
            return print(f'${proxy.spent():.4f} of ${proxy.cap()} (cap in {proxy.BUDGET})')
        if cmd == 'install':   # a pi package into agentbox's own pi config, e.g. git:github.com/KakkoiDev/pi-core
            write_pi_config('')
            os.execvpe('pi', ['pi', 'install'] + rest, dict(os.environ, PI_CODING_AGENT_DIR=str(PI_HOME)))
        return sub[cmd](None, rest)
    p = argparse.ArgumentParser(prog='agentbox', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--model', '-m', help='provider/id, e.g. deepseek/flash or ollama/qwen3.8:27b')
    p.add_argument('--thinking', '-t', help="pi's thinking level (deepseek/flash: off, high or max)")
    p.add_argument('--net', action='store_true', help='let the agent reach the network, not only its model')
    p.add_argument('--allow-home', action='store_true', help='allow running in your home folder itself')
    p.add_argument('--no-sandbox', action='store_true', help='run pi without the sandbox')
    p.add_argument('--version', action='version', version=f'agentbox {__version__}')
    a, rest = p.parse_known_args(argv)
    return run(a, rest)


if __name__ == '__main__':
    main()
