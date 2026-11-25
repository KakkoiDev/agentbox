import os
from pathlib import Path

# agentbox's own state: pi's config, sessions and packages, the proxy's usage log, per-run temp folders
STATE = Path(os.environ.get('AGENTBOX_HOME') or Path.home() / '.local' / 'share' / 'agentbox')
CONFIG = Path(os.environ.get('AGENTBOX_CONFIG') or Path.home() / '.config' / 'agentbox' / 'config.json')
PI_HOME = STATE / 'pi'
HERE = Path(__file__).resolve().parent
