"""Image retention contracts using a fake Docker CLI; no Docker socket is used."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]


def image(letter, build, identity):
    return {"ref": f"infinite-canvas:{letter * 40}-{build}", "id": "sha256:" + identity * 64}


DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
a = sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as log: log.write(json.dumps(a) + "\n")
file = Path(os.environ["DOCKER_STATE"])
state = json.loads(file.read_text())
if a[:2] == ["image", "ls"]:
    for row in state["images"]:
        if row["ref"].startswith("infinite-canvas:"): print(row["ref"], row["id"])
elif a[:2] == ["container", "ls"]:
    for row in state["containers"]:
        if "--all" in a or row["running"]: print(row["name"])
elif a[:2] == ["container", "inspect"]:
    if os.getenv("INSPECT_FAIL"): sys.exit(23)
    for name in a[4:]:
        print(next(row["image"] for row in state["containers"] if row["name"] == name))
elif a[:2] == ["image", "rm"]:
    row = next(row for row in state["images"] if row["ref"] == a[-1])
    if os.getenv("REMOVE_FAIL") or any(c["image"] == row["id"] for c in state["containers"]): sys.exit(17)
    state["images"].remove(row)
    file.write_text(json.dumps(state))
elif a[:2] == ["builder", "prune"]:
    if os.getenv("PRUNE_FAIL"): sys.exit(19)
    state["cache_pruned"] = True
    file.write_text(json.dumps(state))
else:
    sys.exit("Unexpected Docker call: " + repr(a))
'''


class CleanupTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="canvas-cleanup-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        docker = self.root / "docker"
        docker.write_text(DOCKER)
        docker.chmod(0o755)
        self.current, self.previous = image("a", 10, "1"), image("b", 9, "2")
        self.failed, self.old = image("c", 99, "3"), image("d", 8, "4")
        self.running, self.stopped = image("e", 3, "5"), image("f", 2, "6")
        self.alias = image("a", 1, "1")
        self.manual = {"ref": "infinite-canvas:workspace-test", "id": "sha256:" + "7" * 64}
        self.infra = {"ref": "postgres:17-alpine", "id": "sha256:" + "8" * 64}
        self.state = self.root / "docker.json"
        self.state.write_text(json.dumps({"images": [self.current, self.previous, self.failed, self.old, self.running,
                                                  self.stopped, self.alias, self.manual, self.infra],
                                          "containers": [{"name": "running", "image": self.running["id"], "running": True},
                                                         {"name": "stopped", "image": self.stopped["id"], "running": False}]}))
        self.retained = self.root / "retained-images"
        self.retained.write_text(self.current["ref"] + "\n" + self.previous["ref"] + "\n")
        self.log = self.root / "calls"

    def run_cleanup(self, cache=True, **env):
        return subprocess.run(["bash", str(REPO / "deploy/cleanup-docker.sh"), str(self.retained),
                               *(["--build-cache"] if cache else [])], text=True, capture_output=True,
                              env=dict(os.environ, PATH=f"{self.root}:{os.environ['PATH']}",
                                       DOCKER_STATE=str(self.state), CALL_LOG=str(self.log), **env))

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def remaining(self):
        return {row["ref"] for row in json.loads(self.state.read_text())["images"]}

    def test_keeps_deployed_pair_used_images_and_aliases_instead_of_latest_builds(self):
        result = self.run_cleanup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.remaining(), {row["ref"] for row in [self.current, self.previous, self.running,
                                                                 self.stopped, self.alias, self.manual, self.infra]})
        self.assertEqual([a for a in self.calls() if a[:2] == ["builder", "prune"]],
                         [["builder", "prune", "--all", "--force"]])
        self.assertTrue(json.loads(self.state.read_text())["cache_pruned"])
        self.assertTrue(all(a[:2] in [["image", "ls"], ["container", "ls"], ["container", "inspect"],
                                     ["image", "rm"], ["builder", "prune"]] for a in self.calls()))
        self.assertTrue(all("--force" not in a and "-f" not in a for a in self.calls() if a[:2] == ["image", "rm"]))

    def test_first_success_can_have_only_one_retained_image(self):
        self.retained.write_text(self.current["ref"] + "\n")
        result = self.run_cleanup(cache=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(self.current["ref"], self.remaining())
        self.assertNotIn(self.previous["ref"], self.remaining())
        self.assertFalse(any(a[:2] == ["builder", "prune"] for a in self.calls()))

    def test_cache_only_mode_does_not_require_or_delete_any_images(self):
        result = subprocess.run(["bash", str(REPO / "deploy/cleanup-docker.sh"), "--build-cache"], text=True, capture_output=True,
                                env=dict(os.environ, PATH=f"{self.root}:{os.environ['PATH']}",
                                         DOCKER_STATE=str(self.state), CALL_LOG=str(self.log)))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [["builder", "prune", "--all", "--force"]])

    def test_unknown_history_only_prunes_build_cache(self):
        self.retained.unlink()
        before = self.remaining()
        result = self.run_cleanup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.remaining(), before)
        self.assertEqual(self.calls(), [["builder", "prune", "--all", "--force"]])
        self.assertIn("no successful deployment record", result.stdout)

    def test_corrupt_or_ambiguous_history_stops_before_mutation(self):
        for text in ["", "postgres:17-alpine\n", self.current["ref"] + "\n" + self.current["ref"] + "\n",
                     "\n".join(row["ref"] for row in [self.current, self.previous, self.old]) + "\n"]:
            with self.subTest(text=text):
                self.retained.write_text(text)
                result = self.run_cleanup()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.calls())

    def test_symlink_retention_file_is_rejected(self):
        original = self.root / "original"
        self.retained.rename(original)
        self.retained.symlink_to(original)
        result = self.run_cleanup()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.calls())

    def test_failed_container_snapshot_stops_before_image_deletion(self):
        result = self.run_cleanup(INSPECT_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(a[:2] == ["image", "rm"] for a in self.calls()))

    def test_image_removal_failure_is_not_forced_or_retried(self):
        result = self.run_cleanup(REMOVE_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len([a for a in self.calls() if a[:2] == ["image", "rm"]]), 1)
        self.assertFalse(any("--force" in a or "-f" in a for a in self.calls()))

    def test_cache_cleanup_failure_remains_visible_and_retained_images_survive(self):
        result = self.run_cleanup(PRUNE_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(self.current["ref"], self.remaining())
        self.assertIn(self.previous["ref"], self.remaining())


if __name__ == "__main__":
    unittest.main()
