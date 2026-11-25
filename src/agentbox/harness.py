"""What agentbox gives pi for a model: the extensions and prompt additions that help it most.

This is the part the benches tune. Every entry says which finding it comes from; colibri-poc's agent_bench runs a
model with exactly this (`agent_bench.py run --harness agentbox`), so a change here shows up in the scores.

    agentbox harness --model ollama/qwen3.8:27b         # what a run with that model gets
    agentbox harness --model deepseek/flash --json      # the same, for a bench runner
"""
from .paths import HERE

EXT = HERE / 'extensions'

# (what, applies to(provider, model id) -> bool, why)
EXTENSIONS = [
    (EXT / 'command-timeout' / 'index.ts', lambda p, m: True,
     "2026-11-24: pi's bash tool has no default timeout; one command that never ended (DeepSeek fuzzing a calculator, "
     "agentic-v4) used a task's whole 15 minutes. Every command now stops after 120 s unless the model asks for more "
     "(600 s at most)."),
]
PROMPTS = []   # (text, applies to, why): lines appended to pi's system prompt


def is_local(provider):
    return provider != 'deepseek'


def for_model(model, thinking=None):
    provider, _, mid = model.partition('/')
    exts = [dict(path=str(p), why=w) for p, f, w in EXTENSIONS if f(provider, mid)]
    prompts = [dict(text=t, why=w) for t, f, w in PROMPTS if f(provider, mid)]
    args = [x for e in exts for x in ('-e', e['path'])]
    if prompts:
        args += ['--append-system-prompt', '\n\n'.join(p['text'] for p in prompts)]
    return dict(model=model, thinking=thinking, extensions=exts, prompts=prompts, pi_args=args)
