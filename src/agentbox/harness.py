"""What agentbox gives pi for a model: the extensions and prompt lines that help it most.

This is the part the benches tune (agentbench, `agent_bench.py run --harness agentbox` runs a model with exactly
this). A rule goes in only with a bench result behind it, and says which; a change that only might help waits in
OPTIONAL until a bench A/B shows it does.

    agentbox harness --model ollama/gemma4:26b-mlx         # what a run with that model gets, and why
    agentbox harness --model deepseek/flash --json         # the same, for a bench runner
"""
import re

from .paths import HERE

EXT = HERE / 'extensions'
PI_CORE = EXT / 'pi-core'

ALL = lambda p, m: True
GEMMA = lambda p, m: p != 'deepseek' and re.search(r'gemma', m, re.I) is not None

# (extension, applies to (provider, model id), why)
EXTENSIONS = [
    (EXT / 'command-timeout' / 'index.ts', ALL,
     "2026-11-24: pi's bash tool has no default timeout; one command that never ended (DeepSeek fuzzing a calculator, "
     "agentic-v4) used a task's whole 15 minutes. Every command now stops after 120 s unless the model asks for more "
     "(600 s at most)."),
    (PI_CORE / 'local-model-guard' / 'index.ts', GEMMA,
     "2026-11-14, agentic-v1: Gemma 4 26B solved 0/5 and 1/5 bare, with a 15-25 min hang every run (thinking-only "
     "turns, tool calls written as text); with the guard 3/5 in three runs, 4.6 min, no hang. Gemma 4 12B: 1/5 either "
     "way. Not on for Qwen 3.8 27B (4/5 either way, the guard took no action) or gpt-oss 20B (no gain)."),
]
# not on by default: no bench result shows a gain yet (load them with "extensions" in ~/.config/agentbox/config.json)
OPTIONAL = {
    'coding-boost': (PI_CORE / 'coding-boost' / 'index.ts',
                     "coding rules, keyword guides, a wake-up to test unverified changes; agentic-v1..v3: gpt-oss 20B "
                     "2-5/5 across ~20 setups vs 5/5 bare on v2 and v3, Qwen 3.8 27B 3-5/5 vs 4-5/5 bare: no gain shown"),
    'async-rewake': (PI_CORE / 'async-rewake' / 'extension' / 'index.ts',
                     "long jobs in the background, the agent woken when they finish: a convenience, not benched"),
}
PROMPTS = []   # (text, applies to, why): lines appended to pi's system prompt


def resolve_extension(name_or_path):
    """A config entry: an OPTIONAL name (coding-boost, async-rewake) or a path to any pi extension."""
    return str(OPTIONAL[name_or_path][0]) if name_or_path in OPTIONAL else name_or_path


def for_model(model, thinking=None):
    provider, _, mid = model.partition('/')
    exts = [dict(path=str(p), why=w) for p, f, w in EXTENSIONS if f(provider, mid)]
    prompts = [dict(text=t, why=w) for t, f, w in PROMPTS if f(provider, mid)]
    args = [x for e in exts for x in ('-e', e['path'])]
    if prompts:
        args += ['--append-system-prompt', '\n\n'.join(p['text'] for p in prompts)]
    return dict(model=model, thinking=thinking, extensions=exts, prompts=prompts, pi_args=args)
