"""Linux deployment contracts with a fake Docker CLI; never touches a Docker socket."""
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import random
import re
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
    if os.getenv("SCENARIO") == "missing-infra" and a[-1] in ("postgres:17-alpine", "rustfs/rustfs:latest", "amazon/aws-cli:latest"):
        sys.exit(1)
    if os.getenv("SCENARIO") == "loaded-image-mismatch" and a[3] == "{{.Id}}":
        print("sha256:" + "c" * 64); sys.exit(0)
    print(os.environ["IMAGE_ID"] if a[3] == "{{.Id}}" else os.environ["SHA"])
    sys.exit(0)
if a[0] == "save":
    print("fake-infra-images"); sys.exit(0)
if a[0] == "inspect":
    print("wrong" if os.getenv("SCENARIO") == "wrong-image" else os.environ["IMAGE_ID"] if a[2] == "{{.Image}}" else "healthy")
    sys.exit(0)
if a[0] == "compose":
    if "up" in a:
        previous = os.getenv("APP_IMAGE") == "infinite-canvas:previous"
        scenario = os.getenv("SCENARIO")
        sys.exit(1 if scenario == "rollback-fails" or (scenario == "unhealthy" and not previous) else 0)
    if "ps" in a and ("-a" not in a or os.getenv("SCENARIO") == "unmanaged"):
        print("previous-container-id" if os.getenv("APP_IMAGE") == "infinite-canvas:previous" else "container-id")
    sys.exit(0)
raise SystemExit("Unexpected docker call: " + repr(a))
'''
FAKE_MAGPIE_SYNC = r'''#!/usr/bin/env bash
set -eu
printf '%s|%s\n' "$*" "$(readlink "$DEPLOY_ROOT/current" || true)" >> "$MAGPIE_SYNC_LOG"
[[ "$*" == '--container container-id --sync-magpie-gateway' || "$*" == '--container previous-container-id --sync-magpie-gateway' ]]
if [[ "$2" == container-id ]]; then grep -q '{{.State.Health.Status}}' "$CALL_LOG"; fi
if [[ "$SCENARIO" == magpie-rollback-fails || ( "$SCENARIO" == magpie-fails && "$2" == container-id ) ]]; then
    echo 'Magpie gateway synchronization failed' >&2
    exit 1
fi
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
                        CALL_LOG=str(self.root / "docker-calls"), IMAGE_ID=IMAGE_ID, SHA=SHA,
                        DEPLOY_ROOT=str(self.root), MAGPIE_SYNC_LOG=str(self.root / "magpie-sync"))
        self.transport = self.root / "transport"
        (self.transport / "deploy").mkdir(parents=True)
        for name in ["ssh-deploy.sh", "remote-deploy.sh"]:
            shutil.copy(REPO / "deploy" / name, self.transport / "deploy" / name)
        source = self.root / "payload"
        source.mkdir()
        files = {"image.tar": b"image", "compose.yml": (REPO / "docker-compose.yml").read_bytes(),
                 "remote-deploy.sh": (REPO / "deploy/remote-deploy.sh").read_bytes(),
                 "import-codex-config.sh": FAKE_MAGPIE_SYNC.encode(),
                 "image-ref": f"infinite-canvas:{RELEASE}\n".encode(),
                 "image-id": (IMAGE_ID + "\n").encode(), "revision": (SHA + "\n").encode()}
        for name, data in files.items():
            (source / name).write_bytes(data)
        sums = "".join(f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in files.items())
        (source / "SHA256SUMS").write_text(sums)
        incoming = self.root / "incoming" / RELEASE
        incoming.mkdir(parents=True)
        (incoming / "image.tar").write_bytes(files["image.tar"])
        with tarfile.open(incoming / "release.tar.gz", "w:gz") as archive:
            for path in source.iterdir():
                if path.name != "image.tar":
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
        self.assertFalse((self.root / "releases" / RELEASE / "image.tar").exists())
        cache = self.root / "shared/image-transfer/image.tar"
        self.assertEqual(cache.read_bytes(), b"image")
        self.assertEqual(cache.stat().st_mode & 0o777, 0o600)

    def test_unhealthy_update_restores_previous_and_still_fails(self):
        previous = self.previous()
        cache = self.root / "shared/image-transfer/image.tar"
        cache.parent.mkdir()
        cache.write_bytes(b"previous healthy image")
        result = self.run_deploy("unhealthy")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Previous release restored", result.stderr)
        self.assertEqual((self.root / "current").resolve(), previous)
        up = [c for c in self.calls() if "--wait" in c["args"]]
        self.assertEqual(len(up), 2)
        self.assertEqual(up[-1]["image"], "infinite-canvas:previous")
        self.assertFalse(any("down" in c["args"] or "prune" in c["args"] for c in self.calls()))
        self.assertEqual(cache.read_bytes(), b"previous healthy image")
        self.assertEqual((self.root / "releases" / RELEASE / "image.tar").read_bytes(), b"image")

    def test_magpie_sync_runs_after_health_and_before_promoting_current(self):
        result = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "magpie-sync").read_text().splitlines(),
                         ["--container container-id --sync-magpie-gateway|"])
        calls = self.calls()
        self.assertTrue(any("{{.State.Health.Status}}" in c["args"] for c in calls))

    def test_magpie_failure_keeps_current_and_resyncs_rollback_container(self):
        previous = self.previous()
        result = self.run_deploy("magpie-fails")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Previous release restored", result.stderr)
        self.assertNotIn("Deployment is healthy", result.stdout)
        self.assertEqual((self.root / "current").resolve(), previous)
        self.assertFalse((self.root / "shared/image-transfer/image.tar").exists())
        self.assertEqual((self.root / "magpie-sync").read_text().splitlines(), [
            "--container container-id --sync-magpie-gateway|releases/previous",
            "--container previous-container-id --sync-magpie-gateway|releases/previous",
        ])

    def test_magpie_rollback_sync_failure_is_reported(self):
        self.previous()
        result = self.run_deploy("magpie-rollback-fails")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ROLLBACK FAILED", result.stderr)
        self.assertNotIn("Previous release restored", result.stderr)

    def test_first_deploy_failure_keeps_evidence(self):
        result = self.run_deploy("unhealthy")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no previous release", result.stderr)
        self.assertFalse((self.root / "current").exists())
        self.assertTrue((self.root / "releases" / RELEASE / "image.tar").exists())
        self.assertFalse((self.root / "shared/image-transfer/image.tar").exists())

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
        cache = self.root / "shared/image-transfer/image.tar"
        cache.parent.mkdir()
        cache.write_bytes(b"previous verified basis")
        (self.root / "incoming" / RELEASE / "image.tar").write_bytes(b"changed after hashing")
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any("load" in c["args"] for c in self.calls()))
        self.assertEqual(cache.read_bytes(), b"previous verified basis")

    def test_missing_or_symlink_image_is_rejected_before_load(self):
        image = self.root / "incoming" / RELEASE / "image.tar"
        image.unlink()
        for symlink in [False, True]:
            with self.subTest(symlink=symlink):
                if symlink:
                    shutil.rmtree(self.root / "releases" / RELEASE)
                    image.symlink_to(self.root / "shared/production.env")
                result = self.run_deploy()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Missing regular image.tar", result.stderr)
                self.assertFalse(any("load" in c["args"] for c in self.calls()))

    def test_symlink_cache_is_rejected_before_docker_calls(self):
        cache = self.root / "shared/image-transfer"
        cache.symlink_to(self.root / "payload", target_is_directory=True)
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cache cannot be a symlink", result.stderr)
        self.assertFalse(self.calls())

    def test_cache_promotion_failure_does_not_rollback_healthy_release(self):
        cache = self.root / "shared/image-transfer/image.tar"
        cache.parent.mkdir()
        cache.write_bytes(b"previous basis")
        move = self.bin / "mv"
        move.write_text('#!/usr/bin/env bash\nif [[ "${@: -1}" == */shared/image-transfer/image.tar ]]; then exit 1; fi\nexec /usr/bin/mv "$@"\n')
        move.chmod(0o755)
        result = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("could not update image transfer cache", result.stderr)
        self.assertEqual((self.root / "current").resolve(), self.root / "releases" / RELEASE)
        self.assertEqual(cache.read_bytes(), b"previous basis")

    def test_package_contains_metadata_only_and_checksums_the_separate_image(self):
        shutil.copy(REPO / "docker-compose.yml", self.root / "docker-compose.yml")
        (self.root / "deploy").mkdir()
        shutil.copy(REPO / "deploy/remote-deploy.sh", self.root / "deploy/remote-deploy.sh")
        shutil.copy(REPO / "deploy/import-codex-config.sh", self.root / "deploy/import-codex-config.sh")
        package = (REPO / "Jenkinsfile").read_text().split("stage('Package release')", 1)[1].split("sh '''", 1)[1].split("'''", 1)[0]
        result = subprocess.run(["bash", "-c", package], cwd=self.root, env=dict(self.env, APP_IMAGE=f"infinite-canvas:{RELEASE}", RELEASE_SHA=SHA), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        directory = self.root / ".ci"
        self.assertEqual((directory / "image.tar").read_bytes(), b"fake-infra-images\n")
        with tarfile.open(directory / "release.tar.gz") as archive:
            self.assertEqual(set(archive.getnames()), {"compose.yml", "remote-deploy.sh", "import-codex-config.sh", "image-ref", "image-id", "revision", "SHA256SUMS"})
        self.assertIn("  image.tar\n", (directory / "SHA256SUMS").read_text())
        checked = subprocess.run(["sha256sum", "-c", "SHA256SUMS"], cwd=directory, capture_output=True, text=True)
        self.assertEqual(checked.returncode, 0, checked.stderr)

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

    def ssh_transport(self, fail=False, preflight=False, scenario="success", rsync_fail=False):
        fake = '''#!/usr/bin/env python3
import json, os, shlex, subprocess, sys
with open(os.environ["CALL_LOG"], "a") as f: f.write(json.dumps(sys.argv) + "\\n")
if os.getenv("SSH_FAIL") == "1": sys.exit(255)
if os.getenv("SSH_PREFLIGHT") == "1" and sys.argv[-1].startswith("set -eu"):
    sys.exit(subprocess.run(["bash", "-c", sys.argv[-1]]).returncode)
if os.path.basename(sys.argv[0]) == "rsync":
    rsh = next(a.split("=", 1)[1] for a in sys.argv if a.startswith("--rsh="))
    result = subprocess.run([*shlex.split(rsh), "-l", "deploy", "deploy.example.com", "rsync --server fixture"])
    sys.exit(23 if os.getenv("RSYNC_FAIL") == "1" else result.returncode)
if os.path.basename(sys.argv[0]) == "ssh": sys.stdin.buffer.read()
'''
        for name in ["ssh", "scp", "rsync"]:
            path = self.bin / name
            path.write_text(fake)
            path.chmod(0o755)
        env = dict(self.env, DEPLOY_HOST="deploy.example.com", DEPLOY_USER="deploy",
                   DEPLOY_KEY="/secret/key", KNOWN_HOSTS="/secret/hosts", DEPLOY_DIR=str(self.root),
                   COMPOSE_PROJECT="test", RELEASE_SHA=SHA, BUILD_NUMBER="7", SSH_FAIL="1" if fail else "0",
                   SSH_PREFLIGHT="1" if preflight else "0", SCENARIO=scenario,
                   RSYNC_FAIL="1" if rsync_fail else "0")
        return subprocess.run(["bash", str(REPO / "deploy/ssh-deploy.sh")], cwd=self.transport,
                              env=env, stdin=subprocess.DEVNULL, text=True, capture_output=True)

    def test_ssh_transport_requires_pinned_host_and_checks_each_hop(self):
        result = self.ssh_transport()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual(len(calls), 5)
        hops = [call for call in calls if Path(call[0]).name in ["ssh", "scp"]]
        self.assertEqual(len(hops), 4)
        for call in hops:
            self.assertIn("StrictHostKeyChecking=yes", call)
            self.assertIn("UserKnownHostsFile=/secret/hosts", call)
            self.assertIn("IdentitiesOnly=yes", call)
        self.assertNotIn("/secret/key", result.stdout + result.stderr)
        sync = next(call for call in calls if Path(call[0]).name == "rsync")
        self.assertIn("--copy-dest=" + str(self.root / "shared/image-transfer"), sync)
        for option in ["--checksum", "--compress", "--no-whole-file", "--stats"]:
            self.assertIn(option, sync)
        self.assertNotIn("--inplace", sync)
        self.assertNotIn("--delete", sync)

    def test_delta_failure_stops_before_release_upload_or_activation(self):
        cache = self.root / "shared/image-transfer/image.tar"
        cache.parent.mkdir()
        cache.write_bytes(b"previous basis")
        result = self.ssh_transport(rsync_fail=True)
        self.assertEqual(result.returncode, 23)
        self.assertIn("image delta upload (exit 23)", result.stderr)
        self.assertEqual(cache.read_bytes(), b"previous basis")
        self.assertFalse(any(Path(call[0]).name == "scp" for call in self.calls()))

    def test_rsync_ssh_adapter_preserves_quoted_credential_paths(self):
        self.ssh_transport()
        key = "/secret/key with spaces'quote"
        hosts = "/secret/hosts with spaces'quote"
        result = subprocess.run(["bash", str(REPO / "deploy/ssh-deploy.sh"), "--rsync-ssh", "deploy.example.com", "rsync --server fixture"],
                                env=dict(self.env, DEPLOY_HOST="deploy.example.com", DEPLOY_USER="deploy", DEPLOY_KEY=key, KNOWN_HOSTS=hosts,
                                         DEPLOY_DIR=str(self.root), COMPOSE_PROJECT="test", RELEASE_SHA=SHA, BUILD_NUMBER="7", DEPLOY_PORT="2222"),
                                stdin=subprocess.DEVNULL, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        call = self.calls()[-1]
        self.assertIn(key, call)
        self.assertIn("UserKnownHostsFile=" + hosts, call)
        self.assertEqual(call[-4:], ["-p", "2222", "deploy.example.com", "rsync --server fixture"])

    @unittest.skipUnless(shutil.which("rsync"), "real rsync is required")
    def test_real_rsync_protocol_uses_pinned_ssh_adapter_without_network(self):
        ssh = self.bin / "ssh"
        ssh.write_text('''#!/usr/bin/env python3
import json, os, sys
with open(os.environ["CALL_LOG"], "a") as f: f.write(json.dumps(sys.argv) + "\\n")
args = sys.argv[sys.argv.index("rsync"):]
os.execv("/usr/bin/rsync", args)
''')
        ssh.chmod(0o755)
        original = random.Random(0).randbytes(1024 * 1024)
        cache = self.root / "shared/image-transfer/image.tar"
        cache.parent.mkdir()
        cache.write_bytes(original)
        image = original + b"new image config"
        (self.transport / ".ci").mkdir()
        (self.transport / ".ci/image.tar").write_bytes(image)
        incoming = self.root / "incoming" / RELEASE / "image.tar"
        incoming.unlink()
        delta = (REPO / "deploy/ssh-deploy.sh").read_text().split("stage='image delta upload'", 1)[1].split("stage='release upload'", 1)[0]
        result = subprocess.run(["bash", "-ec", delta], cwd=self.transport,
                                env=dict(self.env, DEPLOY_HOST="deploy.example.com", DEPLOY_USER="deploy", DEPLOY_KEY="/secret/key with spaces'quote",
                                         KNOWN_HOSTS="/secret/hosts", DEPLOY_DIR=str(self.root), COMPOSE_PROJECT="test", RELEASE_SHA=SHA, BUILD_NUMBER="7",
                                         DEPLOY_PORT="2222", release=RELEASE, target="deploy@deploy.example.com"), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(hashlib.sha256(incoming.read_bytes()).digest(), hashlib.sha256(image).digest())
        self.assertEqual(hashlib.sha256(cache.read_bytes()).digest(), hashlib.sha256(original).digest())
        self.assertGreater(int(re.search(r"Matched data: ([\d,]+) bytes", result.stdout)[1].replace(",", "")), 0)
        call = self.calls()[-1]
        for argument in ["StrictHostKeyChecking=yes", "IdentitiesOnly=yes", "UserKnownHostsFile=/secret/hosts", "/secret/key with spaces'quote", "2222"]:
            self.assertIn(argument, call)

    def test_ssh_failure_stops_before_scp_or_deployment(self):
        result = self.ssh_transport(fail=True)
        self.assertEqual(result.returncode, 255)
        self.assertEqual(len(self.calls()), 1)
        self.assertIn("remote preflight (exit 255)", result.stderr)

    def test_missing_runtime_config_is_explicit_before_upload(self):
        (self.root / "shared/production.env").unlink()
        result = self.ssh_transport(preflight=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("production.env first", result.stderr)
        self.assertIn("remote preflight (exit 1)", result.stderr)
        self.assertEqual(len(self.calls()), 1)

    def test_missing_shared_directory_is_explicit_before_upload(self):
        shutil.rmtree(self.root / "shared")
        result = self.ssh_transport(preflight=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Missing deployment directory", result.stderr)
        self.assertEqual(len(self.calls()), 1)

    def test_real_preflight_accepts_initialized_config_without_logging_it(self):
        (self.root / "shared/production.env").write_text("PRIVATE_SENTINEL=must-not-be-logged\n")
        shutil.rmtree(self.root / "incoming")
        result = self.ssh_transport(preflight=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.calls()), 8)
        self.assertTrue((self.root / "incoming" / RELEASE).is_dir())
        self.assertNotIn("must-not-be-logged", result.stdout + result.stderr)

    def test_missing_infrastructure_images_are_transferred(self):
        infra_file = self.transport / ".ci" / "infra-images.tar.gz"
        shutil.rmtree(self.root / "incoming")
        result = self.ssh_transport(preflight=True, scenario="missing-infra")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(infra_file.exists())
        calls = self.calls()
        self.assertTrue(any(isinstance(call, dict) and call["args"][:1] == ["save"] for call in calls))

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


class BuildEnvironmentTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="canvas-build-tools-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        docker = self.root / "docker"
        docker.write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as log:
    log.write(json.dumps({"args": args, "buildkit": os.getenv("DOCKER_BUILDKIT")}) + "\\n")
if args == ["buildx", "version"]:
    if os.environ["BUILDX_STATE"] != "ready":
        print("docker: 'buildx' is not a docker command" if os.environ["BUILDX_STATE"] == "missing" else "failed to fetch metadata: exec format error", file=sys.stderr)
        sys.exit(1)
    print("github.com/docker/buildx fixture"); sys.exit(0)
if args[:1] == ["build"]:
    if os.environ["BUILDX_STATE"] != "ready":
        print("ERROR: BuildKit is enabled but the buildx component is missing or broken.", file=sys.stderr)
        sys.exit(1)
    sys.exit(int(os.getenv("BUILD_EXIT", "0")))
sys.exit("Unexpected Docker call")
''')
        docker.chmod(0o755)
        rsync = self.root / "rsync"
        rsync.write_text("#!/bin/sh\nexit 0\n")
        rsync.chmod(0o755)
        self.log = self.root / "calls.jsonl"
        self.script = (REPO / "Jenkinsfile").read_text().split("stage('Build image')", 1)[1].split("sh '''", 1)[1].split("'''", 1)[0]

    def run_stage(self, state, build_exit="0"):
        self.log.unlink(missing_ok=True)
        result = subprocess.run(["bash", "-c", self.script], cwd=self.root,
                                env=dict(os.environ, PATH=f"{self.root}:{os.environ['PATH']}", CALL_LOG=str(self.log), BUILDX_STATE=state,
                                         RELEASE_SHA=SHA, APP_IMAGE=f"infinite-canvas:{RELEASE}", BUILD_EXIT=build_exit), text=True, capture_output=True)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        return result, calls

    def test_missing_or_broken_buildx_is_reported_before_building(self):
        for state in ["missing", "broken"]:
            with self.subTest(state=state):
                result, calls = self.run_stage(state)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual([call["args"] for call in calls], [["buildx", "version"]])
                self.assertIn("docker-buildx-plugin", result.stderr)
                self.assertIn("Jenkins agent", result.stderr)

    def test_ready_buildx_keeps_existing_buildkit_target_and_image_identity(self):
        result, calls = self.run_stage("ready")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls[0]["args"], ["buildx", "version"])
        self.assertEqual(calls[1]["args"], ["build", "--progress=plain", "--target", "runtime", "--label", f"org.opencontainers.image.revision={SHA}", "--tag", f"infinite-canvas:{RELEASE}", "."])
        self.assertEqual(calls[1]["buildkit"], "1")

    def test_failed_build_is_not_retried_or_downgraded(self):
        result, calls = self.run_stage("ready", "17")
        self.assertEqual(result.returncode, 17)
        self.assertEqual(sum(call["args"][:1] == ["build"] for call in calls), 1)
        self.assertFalse(any(call["buildkit"] == "0" for call in calls))


@unittest.skipUnless(shutil.which("rsync"), "real rsync is required for delta-transfer regression")
class DeltaTransferTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="canvas-delta-test-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.cache = self.root / "cache"
        self.cache.mkdir()
        self.source = self.root / "source/image.tar"
        self.source.parent.mkdir()
        self.layer = random.Random(0).randbytes(2 * 1024 * 1024)

    def image(self, revision):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w") as archive:
            for name, data in [("manifest.json", json.dumps({"revision": revision}).encode()), ("base/layer.tar", self.layer)]:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        return output.getvalue()

    def transfer(self, name):
        destination = self.root / name
        destination.mkdir()
        result = subprocess.run(["rsync", "--times", "--perms", "--chmod=F600", "--checksum", "--compress", "--no-whole-file", "--stats",
                                 "--copy-dest=" + str(self.cache), str(self.source), str(destination) + "/"],
                                env=dict(os.environ, LC_ALL="C"), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(hashlib.sha256((destination / "image.tar").read_bytes()).digest(), hashlib.sha256(self.source.read_bytes()).digest())
        self.assertEqual((destination / "image.tar").stat().st_mode & 0o777, 0o600)
        literal = re.search(r"Literal data: ([\d,]+) bytes", result.stdout)
        self.assertIsNotNone(literal, result.stdout)
        return int(literal[1].replace(",", ""))

    def test_cold_transfer_then_changed_archive_reuses_basis_without_modifying_it(self):
        original = self.image("previous")
        self.source.write_bytes(original)
        cold = self.transfer("cold")
        self.assertEqual(cold, len(original))
        (self.cache / "image.tar").write_bytes(original)
        self.source.write_bytes(self.image("new-release"))
        warm = self.transfer("warm")
        self.assertLess(warm, cold // 4)
        self.assertEqual(hashlib.sha256((self.cache / "image.tar").read_bytes()).digest(), hashlib.sha256(original).digest())

    def test_corrupt_same_size_and_timestamp_basis_cannot_skip_content_verification(self):
        original = self.image("current")
        self.source.write_bytes(original)
        basis = bytearray(original)
        basis[4096] ^= 1
        cached = self.cache / "image.tar"
        cached.write_bytes(basis)
        os.utime(cached, (self.source.stat().st_atime, self.source.stat().st_mtime))
        self.assertLess(self.transfer("repaired"), len(original) // 4)
        self.assertEqual(hashlib.sha256(cached.read_bytes()).digest(), hashlib.sha256(basis).digest())


if __name__ == "__main__":
    unittest.main()
