"""Exercise the embedded host transaction with fake systemd, Magpie and Docker transports."""
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from io import StringIO
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "import-codex-config.sh"
HOST = SCRIPT.read_text().split("<<'PY'\n", 1)[1].split("\nPY\n", 1)[0]
HEADER, ACTION = HOST.split("\ntry:\n    require(sys.platform", 1)
ACTION = "\ntry:\n    require(sys.platform" + ACTION


class MagpieGatewayTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix="canvas-magpie-")))
        env = {"HOME": str(self.root), "XDG_CONFIG_HOME": str(self.root / "config"), "XDG_STATE_HOME": str(self.root / "state"), "PATH": "/usr/bin"}
        self.stack.enter_context(patch.dict(os.environ, env, clear=True))
        self.stack.enter_context(patch.object(sys, "argv", ["gateway", "begin", "app-id", str(self.root / "stage"), ""]))
        self.ns = {}
        exec(HEADER, self.ns)
        # CI may run as root; only bypass the entry-point user guard, not ownership checks.
        require = self.ns["require"]
        self.ns["require"] = lambda ok, message: require(ok or message.startswith("Run Magpie setup on Linux"), message)
        self.stage = self.root / "stage"
        self.stage.mkdir(mode=0o700)
        self.original_env = {**env, "MAGPIE_ADDR": "127.0.0.1:3425"}
        self.service_env = self.original_env.copy()
        self.active = "active"
        self.environment_files = ""
        self.client = "172.18.0.42"
        self.gateway = "172.18.0.1"
        self.keys = {"existing-id": {"name": "existing-client", "key": "unrelated-private-key", "enabled": True}}
        self.created = 0
        self.restarts = []
        self.probes = []
        self.ignore_acl = False
        self.ignore_auth = False
        self.backup = ""
        self.output = ""
        read_bytes = Path.read_bytes

        def read(path):
            if str(path) == f"/proc/{os.getpid()}/environ":
                return b"\0".join(f"{k}={v}".encode() for k, v in self.service_env.items())
            return read_bytes(path)

        self.stack.enter_context(patch.object(Path, "read_bytes", read))
        self.stack.enter_context(patch("shutil.which", return_value=sys.executable))
        self.stack.enter_context(patch("subprocess.run", side_effect=self.transport))

    def unit_env(self):
        result = self.original_env.copy()
        drop = self.ns["drop_file"]
        if drop.exists():
            result.update(value.split("=", 1) for value in re.findall(r'Environment="([^"]+)"', drop.read_text()))
        return result

    def transport(self, args, *, input=None, text=True, capture_output=True, env=None):
        out = ""
        if args[0] == "systemctl":
            if "show" in args:
                prop = next(a.split("=", 1)[1] for a in args if a.startswith("--property="))
                out = {"MainPID": str(os.getpid()), "ActiveState": self.active, "EnvironmentFiles": self.environment_files,
                       "Environment": shlex.join(f"{k}={v}" for k, v in self.unit_env().items())}[prop]
            else:
                self.assertIn("daemon-reload", args)
        elif args[:3] == ["magpie", "daemon", "restart"]:
            self.service_env = self.unit_env()
            self.restarts.append(self.service_env["MAGPIE_ADDR"])
        elif args[:3] == ["magpie", "gateway-key", "list"]:
            out = "ID NAME STATE GATEWAY_KEY\n" + "\n".join(f"{k} {v['name']} {'enabled' if v['enabled'] else 'disabled'} ****" for k, v in self.keys.items())
        elif args[:3] == ["magpie", "gateway-key", "add"]:
            self.created += 1
            out = f"sk-magpie-key-fixture-private-{self.created}"
            self.keys[f"created-{self.created}"] = {"name": args[3], "key": out, "enabled": True}
        elif args[:3] == ["magpie", "gateway-key", "remove"]:
            self.keys.pop(args[3])
        elif args[:2] == ["docker", "inspect"]:
            out = json.dumps({"app-network": {"IPAddress": self.client, "Gateway": self.gateway}})
        elif args[:3] == ["docker", "network", "inspect"]:
            out = "bridge"
        elif args[:3] == ["docker", "exec", "-i"]:
            (self.stage / "magpie-gateway.json").write_text(input)
        elif args[:3] == ["docker", "exec", "app-id"]:
            allowed = self.service_env.get("MAGPIE_ALLOW_IPS", "")
            payload = json.loads((self.stage / "magpie-gateway.json").read_text())
            if not self.ignore_acl and ipaddress.IPv4Address(self.client) not in ipaddress.IPv4Network(allowed):
                out = "403"
            elif self.ignore_auth or (args[-1] == "yes" and any(k["key"] == payload["key"] and k["enabled"] for k in self.keys.values())):
                out = "200"
            else:
                out = "401"
            self.probes.append(int(out))
        else:
            self.fail("Unexpected transport call: " + repr(args[:4]))
        return subprocess.CompletedProcess(args, 0, out, "")

    def invoke(self, action, success=True):
        self.ns.update(action=action, backup_arg=self.backup)
        stdout, stderr = StringIO(), StringIO()
        code = 0
        with redirect_stdout(stdout), redirect_stderr(stderr):
            try:
                exec(ACTION, self.ns)
            except SystemExit as error:
                code = error.code
        self.output += stdout.getvalue() + stderr.getvalue()
        self.assertEqual(code == 0, success, stderr.getvalue())
        if action in ("begin", "begin-sync") and success:
            self.backup = stdout.getvalue().strip()

    def begin(self):
        self.invoke("lock")
        self.invoke("begin")
        self.invoke("prepare")

    def assert_private_output(self):
        self.assertNotIn("sk-magpie-key-fixture-private", self.output)
        self.assertNotIn("unrelated-private-key", self.output)

    def test_success_reuses_owned_key_and_sets_only_app_ipv4(self):
        self.begin()
        self.invoke("activate")
        self.invoke("commit")
        self.assertEqual(self.restarts, ["172.18.0.1:3425", "172.18.0.1:3425", "0.0.0.0:3425"])
        self.assertEqual(self.probes, [403, 401, 200, 401, 200])
        self.assertEqual(self.service_env["MAGPIE_ALLOW_IPS"], "172.18.0.42/32")
        self.assertNotIn("sk-magpie", self.ns["drop_file"].read_text())
        for path in (self.ns["state_file"], self.ns["drop_file"], Path(self.backup) / "transaction.json"):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.client = "172.18.0.99"
        self.begin()
        self.invoke("activate")
        self.invoke("commit")
        self.assertEqual(self.created, 1)
        self.assertEqual(self.service_env["MAGPIE_ALLOW_IPS"], "172.18.0.99/32")
        self.assert_private_output()

    def test_deployment_sync_requires_existing_managed_key(self):
        self.invoke("lock")
        self.invoke("begin-sync", success=False)
        self.assertIn("Initialize --magpie-gateway", self.output)
        self.assertEqual(self.created, 0)
        self.assertFalse(self.restarts)

    def test_deployment_sync_reuses_key_and_replaces_previous_container_ip(self):
        self.begin()
        self.invoke("activate")
        self.invoke("commit")
        identity = self.ns["state_file"].read_text()
        self.client = "172.18.0.5"
        self.invoke("begin-sync")
        self.invoke("prepare")
        self.invoke("activate")
        self.invoke("commit")
        self.assertEqual(self.ns["state_file"].read_text(), identity)
        self.assertEqual(self.created, 1)
        self.assertEqual(self.service_env["MAGPIE_ALLOW_IPS"], "172.18.0.5/32")
        self.assert_private_output()

    def test_early_failure_revokes_only_new_key_without_restarting_service(self):
        self.begin()
        self.invoke("rollback")
        self.assertEqual(list(self.keys), ["existing-id"])
        self.assertFalse(self.restarts)
        self.assertFalse(self.ns["drop_file"].exists())
        self.assertFalse(self.ns["state_file"].exists())
        self.assert_private_output()

    def test_ignored_allowlist_never_widens_to_lan(self):
        self.ignore_acl = True
        self.begin()
        self.invoke("activate", success=False)
        self.assertNotIn("0.0.0.0:3425", self.restarts)
        self.invoke("rollback")
        self.assertEqual(self.service_env, self.original_env)
        self.assertEqual(list(self.keys), ["existing-id"])
        self.assert_private_output()

    def test_ignored_gateway_auth_never_widens_to_lan(self):
        self.ignore_auth = True
        self.begin()
        self.invoke("activate", success=False)
        self.assertNotIn("0.0.0.0:3425", self.restarts)
        self.invoke("rollback")
        self.assertEqual(self.service_env, self.original_env)
        self.assertEqual(list(self.keys), ["existing-id"])

    def test_install_failure_restores_previous_managed_key_and_dropin(self):
        self.begin()
        self.invoke("activate")
        self.invoke("commit")
        old_drop = self.ns["drop_file"].read_text()
        old_state = self.ns["state_file"].read_text()
        self.client = "172.18.0.99"
        self.begin()
        self.invoke("activate")
        self.invoke("commit")
        self.invoke("rollback")
        self.assertEqual(self.ns["drop_file"].read_text(), old_drop)
        self.assertEqual(self.ns["state_file"].read_text(), old_state)
        self.assertEqual(self.service_env["MAGPIE_ALLOW_IPS"], "172.18.0.42/32")
        self.assertEqual(self.created, 1)

    def test_environment_file_override_is_rejected_before_mutation(self):
        self.environment_files = "/private/override.env"
        self.invoke("begin", success=False)
        self.assertEqual(self.created, 0)
        self.assertFalse(self.restarts)

    def test_inactive_user_service_is_not_taken_over(self):
        self.active = "inactive"
        self.invoke("begin", success=False)
        self.assertEqual(self.created, 0)
        self.assertIn("magpie daemon install", self.output)

    def test_revoked_owned_key_is_not_recreated(self):
        self.begin()
        self.invoke("activate")
        self.invoke("commit")
        self.keys["created-1"]["enabled"] = False
        self.invoke("begin", success=False)
        self.assertEqual(self.created, 1)
        self.assertIn("refusing to recreate", self.output)

    def test_ip_change_during_import_is_rejected_and_new_key_revoked(self):
        self.begin()
        self.client = "172.18.0.99"
        self.invoke("activate", success=False)
        self.assertNotIn("0.0.0.0:3425", self.restarts)
        self.invoke("rollback")
        self.assertEqual(list(self.keys), ["existing-id"])


if __name__ == "__main__":
    unittest.main()
