"""Panel-JS: Syntaxcheck mit node."""
import shutil
import subprocess
from pathlib import Path

import pytest

JS = Path(__file__).parent.parent / "custom_components/kamera_zentrale/www/kamera-zentrale-panel.js"


@pytest.mark.skipif(not shutil.which("node"), reason="node fehlt")
def test_node_check():
    r = subprocess.run(["node", "--check", str(JS)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
