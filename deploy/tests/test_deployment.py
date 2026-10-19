"""Linux deployment contracts with a fake Docker CLI; never touches a Docker socket."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time
import unittest

REPO = Path(__file__).resolve().parents[2]
SHA = "a" * 40
RELEASE = SHA + "-7"
IMAGE_ID = "sha256:" + "b" * 64
FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
a = sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as f:
    f.write(json.dumps({"args": a, "image": os.getenv("APP_IMAGE")}) + "\n")
if a == ["info"]: sys.exit(0)
if a == ["compose", "version"]: print("Docker Compose v2.30.0"); sys.exit(0)
if a == ["compose", "up", "--help"]: print("--wait-timeout"); sys.exit(0)
if a == ["load"]: sys.stdin.buffer.read(); sys.exit(0)
if a[:2] == ["image", "inspect"]:
    if os.getenv("SCENARIO") == "loaded-image-mismatch" and a[3] == "{{.Id}}":
        print("sha256:" + "c" * 64); sys.exit(0)
    print(os.environ["IMAGE_ID"] if a[3] == "{{.Id}}" else os.environ["SHA"])
    sys.exit(0)
if a[0] == "inspect":
    print("wrong" if os.getenv("SCENARIO") == "wrong-image" else os.environ["IMAGE_ID"] if a[2] == "{{.Image}}" else "healthy")
    sys.exit(0)
if a[0] == "compose":
    if "up" in a:
        previous = os.getenv("APP_IMAGE") == "infinite-canvas:previous"
        scenario = os.getenv("SCENARIO")
        sys.exit(1 if scenario == "rollback-fails" or (scenario == "unhealthy" and not previous) else 0)
    if "ps" in a and ("-a" not in a or os.getenv("SCENARIO") == "unmanaged"): print("container-id")
    sys.exit(0)
raise SystemExit("Unexpected docker call: " + repr(a))
'''


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="canvas-ci-test-", dir="/opt"))
        self.addCleanup(shutil.rmtree, self.root)
        (self.root / "shared").mkdir()
        (self.root / "shared/production.env").write_text("APP_PORT=3000\n")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        docker = self.bin / "docker"
        docker.write_text(FAKE_DOCKER)
        docker.chmod(0o755)
        self.env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}",
                        CALL_LOG=str(self.root / "docker-calls"), IMAGE_ID=IMAGE_ID, SHA=SHA)
        source = self.root / "payload"
        source.mkdir()
        files = {"image.tar.gz": __import__("gzip").compress(b"image"),
                 "compose.yml": (REPO / "docker-compose.yml").read_bytes(),
                 "remote-deploy.sh": (REPO / "deploy/remote-deploy.sh").read_bytes(),
                 "image-ref": f"infinite-canvas:{RELEASE}\n".encode(),
                 "image-id": (IMAGE_ID + "\n").encode(), "revision": (SHA + "\n").encode()}
        for name, data in files.items():
            (source / name).write_bytes(data)
        sums = "".join(f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in files.items())
        (source / "SHA256SUMS").write_text(sums)
        incoming = self.root / "incoming" / RELEASE
        incoming.mkdir(parents=True)
        with tarfile.open(incoming / "release.tar.gz", "w:gz") as archive:
            for path in source.iterdir():
                archive.add(path, arcname=path.name)

    def previous(self):
        previous = self.root / "releases/previous"
        previous.mkdir(parents=True)
        (previous / "compose.yml").write_text("services: {}\n")
        (previous / "image.env").write_text("APP_IMAGE=infinite-canvas:previous\n")
        (previous / "image-ref").write_text("infinite-canvas:previous\n")
        (previous / "runtime.env").write_text("APP_PORT=3000\n")
        (self.root / "current").symlink_to("releases/previous")
        return previous

    def run_deploy(self, scenario="success"):
        return subprocess.run(["bash", str(REPO / "deploy/remote-deploy.sh"), str(self.root), RELEASE, "test-canvas"],
                              env=dict(self.env, SCENARIO=scenario), text=True, capture_output=True)

    def calls(self):
        path = self.root / "docker-calls"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_first_deploy_updates_pointer_only_after_health(self):
        result = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "current").resolve(), self.root / "releases" / RELEASE)
        up = [c for c in self.calls() if "up" in c["args"] and "--wait" in c["args"]]
        self.assertEqual(up[0]["args"][-2:], ["--wait-timeout", "120"])
        self.assertFalse((self.root / "releases" / RELEASE / "image.tar.gz").exists())

    def test_unhealthy_update_restores_previous_and_still_fails(self):
        previous = self.previous()
        result = self.run_deploy("unhealthy")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Previous release restored", result.stderr)
        self.assertEqual((self.root / "current").resolve(), previous)
        up = [c for c in self.calls() if "--wait" in c["args"]]
        self.assertEqual(len(up), 2)
        self.assertEqual(up[-1]["image"], "infinite-canvas:previous")
        self.assertFalse(any("down" in c["args"] or "prune" in c["args"] for c in self.calls()))

    def test_first_deploy_failure_keeps_evidence(self):
        result = self.run_deploy("unhealthy")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no previous release", result.stderr)
        self.assertFalse((self.root / "current").exists())
        self.assertTrue((self.root / "releases" / RELEASE / "image.tar.gz").exists())

    def test_rollback_failure_is_explicit(self):
        self.previous()
        result = self.run_deploy("rollback-fails")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ROLLBACK FAILED", result.stderr)

    def test_running_image_mismatch_rolls_back(self):
        previous = self.previous()
        result = self.run_deploy("wrong-image")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Previous release restored", result.stderr)
        self.assertEqual((self.root / "current").resolve(), previous)

    def test_corrupt_archive_fails_before_changing_containers(self):
        archive = self.root / "incoming" / RELEASE / "release.tar.gz"
        archive.write_bytes(b"not a valid archive")
        self.assertNotEqual(self.run_deploy().returncode, 0)
        self.assertFalse(any("--wait" in c["args"] for c in self.calls()))

    def test_project_change_is_rejected(self):
        (self.root / "shared/project-name").write_text("different-project\n")
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Changing project", result.stderr)
        self.assertFalse(any("--wait" in c["args"] for c in self.calls()))

    def test_loaded_image_mismatch_fails_before_update(self):
        result = self.run_deploy("loaded-image-mismatch")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Loaded image does not match", result.stderr)
        self.assertFalse(any("--wait" in c["args"] for c in self.calls()))

    def test_unmanaged_existing_container_is_not_replaced(self):
        result = self.run_deploy("unmanaged")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("migrate explicitly", result.stderr)
        self.assertFalse(any("--wait" in c["args"] for c in self.calls()))

    def test_checksum_mismatch_fails_before_loading_image(self):
        source = self.root / "payload"
        (source / "image.tar.gz").write_bytes(b"changed after hashing")
        with tarfile.open(self.root / "incoming" / RELEASE / "release.tar.gz", "w:gz") as archive:
            for path in source.iterdir():
                archive.add(path, arcname=path.name)
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any("load" in c["args"] for c in self.calls()))

    def test_concurrent_deploy_rejected(self):
        with (self.root / ".deploy.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Another deployment", result.stderr)
        self.assertFalse(self.calls())

    def test_ssh_validation_refuses_shell_input(self):
        env = dict(self.env, DEPLOY_HOST="host;touch /tmp/injected", DEPLOY_USER="deploy",
                   DEPLOY_KEY="unused", KNOWN_HOSTS="unused", DEPLOY_DIR=str(self.root),
                   COMPOSE_PROJECT="test", RELEASE_SHA=SHA, BUILD_NUMBER="7")
        result = subprocess.run(["bash", str(REPO / "deploy/ssh-deploy.sh")], env=env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("Invalid SSH host", result.stderr)

    def ssh_transport(self, fail=False):
        fake = '''#!/usr/bin/env python3
import json, os, sys
with open(os.environ["CALL_LOG"], "a") as f: f.write(json.dumps(sys.argv) + "\\n")
if os.getenv("SSH_FAIL") == "1": sys.exit(255)
if os.path.basename(sys.argv[0]) == "ssh": sys.stdin.buffer.read()
'''
        for name in ["ssh", "scp"]:
            path = self.bin / name
            path.write_text(fake)
            path.chmod(0o755)
        env = dict(self.env, DEPLOY_HOST="deploy.example.com", DEPLOY_USER="deploy",
                   DEPLOY_KEY="/secret/key", KNOWN_HOSTS="/secret/hosts", DEPLOY_DIR=str(self.root),
                   COMPOSE_PROJECT="test", RELEASE_SHA=SHA, BUILD_NUMBER="7", SSH_FAIL="1" if fail else "0")
        return subprocess.run(["bash", str(REPO / "deploy/ssh-deploy.sh")], cwd=REPO,
                              env=env, stdin=subprocess.DEVNULL, text=True, capture_output=True)

    def test_ssh_transport_requires_pinned_host_and_checks_each_hop(self):
        result = self.ssh_transport()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual(len(calls), 3)
        for call in calls:
            self.assertIn("StrictHostKeyChecking=yes", call)
            self.assertIn("UserKnownHostsFile=/secret/hosts", call)
            self.assertIn("IdentitiesOnly=yes", call)
        self.assertNotIn("/secret/key", result.stdout + result.stderr)

    def test_ssh_failure_stops_before_scp_or_deployment(self):
        result = self.ssh_transport(fail=True)
        self.assertEqual(result.returncode, 255)
        self.assertEqual(len(self.calls()), 1)

    def supervisor(self, exit_role):
        app = self.root / "app"
        (app / "canvas-agent").mkdir(parents=True)
        (app / "web").mkdir()
        script = self.root / "entrypoint.sh"
        script.write_text((REPO / "docker-entrypoint.sh").read_text().replace("/app/", str(app) + "/"))
        child = '''#!/usr/bin/env bash
set -eu
role="$(basename "$0")"
if [[ "$role" == bun && ( "${1:-}" == -e || "${1:-}" == /usr/local/* ) ]]; then exit 0; fi
echo "$role-started" >> "$PROCESS_LOG"
if [[ "$EXIT_ROLE" == "$role" ]]; then sleep 0.2; exit 1; fi
trap 'echo "$role-stopped" >> "$PROCESS_LOG"; exit 0' TERM
while true; do sleep 0.1; done
'''
        for name in ["bun", "node"]:
            path = self.bin / name
            path.write_text(child)
            path.chmod(0o755)
        log = self.root / "process-log"
        process = subprocess.Popen(["bash", str(script)], env=dict(self.env, EXIT_ROLE=exit_role,
                                    PROCESS_LOG=str(log)), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        return process, log

    def test_agent_exit_stops_web_and_fails_container(self):
        process, log = self.supervisor("node")
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 1, stdout + stderr)
        self.assertIn("bun-stopped", log.read_text())

    def test_web_exit_stops_agent_and_fails_container(self):
        process, log = self.supervisor("bun")
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 1, stdout + stderr)
        self.assertIn("node-stopped", log.read_text())

    def test_sigterm_stops_both_processes(self):
        process, log = self.supervisor("none")
        for _ in range(100):
            if log.exists() and "bun-started" in log.read_text():
                break
            time.sleep(0.01)
        process.terminate()
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 143, stdout + stderr)
        self.assertIn("node-stopped", log.read_text())
        self.assertIn("bun-stopped", log.read_text())


if __name__ == "__main__":
    unittest.main()
