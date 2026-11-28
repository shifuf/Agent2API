"""Regression: installed WASM capability discovery on the normal worker stack.

Usage: python3 scripts/test-docker-plugin-startup.py IMAGE PLUGINS_DIRECTORY
The fixture must contain plugins.json and signed installed packages, without
accounts. The test runs without network or published ports and uses fresh data.
"""

import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


def docker(*args, check=True):
    result = subprocess.run(["docker", *args], capture_output=True, text=True,
                            timeout=60)
    if check and result.returncode:
        raise RuntimeError("Docker operation failed: " + args[0])
    return result


def verify_start(container, expected):
    docker("start", container)
    started = time.monotonic()
    deadline = started + 180
    ready_at = None
    while time.monotonic() < deadline:
        state = json.loads(docker("inspect", container).stdout)[0]["State"]
        if not state["Running"]:
            raise AssertionError("Installed plugin startup exited: " + str(state["ExitCode"]))
        response = docker("exec", container, "curl", "-fsS",
                          "http://127.0.0.1:3065/api/plugins/startup", check=False)
        if response.returncode == 0:
            snapshot = json.loads(response.stdout)
            snapshot = snapshot.get("data", snapshot)
            phases = {pack["id"]: pack["startup"]["phase"]
                      for pack in snapshot["packs"]}
            ready = not snapshot["pending"] and all(
                phases.get(pack) == "ready" for pack in expected)
            if ready:
                ready_at = ready_at or time.monotonic()
                if time.monotonic() - ready_at >= 30:
                    assert state["Health"]["Status"] == "healthy"
                    return snapshot["bootId"]
            else:
                ready_at = None
        time.sleep(2)
    raise AssertionError("Installed plugins failed readiness/stability deadline")


def main():
    image, plugin_path = sys.argv[1:]
    plugins = pathlib.Path(plugin_path).resolve(strict=True)
    registry = json.loads((plugins / "plugins.json").read_text())
    expected = {pack["id"] for pack in registry["packs"] if pack.get("enabled", True)}
    assert expected, "Supply at least one enabled signed plugin"
    parent = pathlib.Path(tempfile.gettempdir()).resolve()
    fixture = pathlib.Path(tempfile.mkdtemp(prefix="agent2api-plugin-stack-", dir=parent)).resolve()
    assert fixture.parent == parent and fixture.name.startswith("agent2api-plugin-stack-")
    container = None
    try:
        shutil.copytree(plugins, fixture / "plugins")
        name = "agent2api-plugin-stack-" + uuid.uuid4().hex[:12]
        container = docker("create", "--name", name, "--network", "none",
                           "--restart", "no", "--mount",
                           "type=bind,source=" + str(fixture) + ",target=/data",
                           "--env", "AGENT2API_ALLOW_NO_KEY=1",
                           "--env", "AGENT2API_SELF_UPDATE=0",
                           "--env", "AGENT2API_CAPTCHA_ENABLED=0", image).stdout.strip()
        first = verify_start(container, expected)
        docker("stop", "--time", "15", container)
        second = verify_start(container, expected)
        assert first != second, "Restart must create a fresh boot"
        print("PASS: " + str(len(expected)) + " installed plugins ready; two stable boots")
    finally:
        if container:
            docker("stop", "--time", "15", container, check=False)
            docker("rm", container)
        assert fixture.parent == parent and fixture.name.startswith("agent2api-plugin-stack-")
        shutil.rmtree(fixture)


if __name__ == "__main__":
    main()
