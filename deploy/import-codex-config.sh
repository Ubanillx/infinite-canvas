#!/usr/bin/env bash
set +x
set -Eeuo pipefail
umask 077

usage() {
    cat <<'HELP'
Usage: bash import-codex-config.sh [options]
  --source DIR      Host Codex home (default: $CODEX_HOME or $HOME/.codex)
  --project NAME    Compose project (default: $COMPOSE_PROJECT or infinite-canvas)
  --container NAME  Use a specific running application container
  --magpie-gateway  Configure the host Magpie user service and a private container key
  --sync-magpie-gateway  Refresh an existing gateway allowlist without importing config
  --restart         Restart the application after importing (interrupts active work)
  --help            Show this help

Copies config.toml, optional auth.json and the referenced model_catalog_json file.
Backs up overwritten container files and validates with the container Codex CLI.
Host files, container sessions and skills are not moved or deleted.
Run as the host user whose Codex configuration should be imported.
--magpie-gateway restarts Magpie, preserves loopback access, and allows only the
selected container IPv4 address remotely. Requires Linux, Python 3, flock and an active
current-user magpie.service. CI/CD calls --sync-magpie-gateway after recreating app.
Sync skips providers other than infinite_canvas_magpie and requires the original
Magpie service owner and managed key state; it never creates a replacement key.
HELP
}

source_home="${CODEX_HOME:-$HOME/.codex}"
project="${COMPOSE_PROJECT:-infinite-canvas}"
container=""
restart=false
magpie=false
sync_magpie=false
while (($#)); do
    case "$1" in
        --source|--project|--container)
            (($# >= 2)) && [[ -n "$2" ]] || { usage >&2; exit 2; }
            case "$1" in
                --source) source_home="$2" ;;
                --project) project="$2" ;;
                --container) container="$2" ;;
            esac
            shift 2 ;;
        --restart) restart=true; shift ;;
        --magpie-gateway) magpie=true; shift ;;
        --sync-magpie-gateway) sync_magpie=true; shift ;;
        --help|-h) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
done

if "$sync_magpie" && { "$magpie" || "$restart"; }; then
    echo '--sync-magpie-gateway cannot be combined with --magpie-gateway or --restart.' >&2
    exit 2
fi
files=(config.toml)
if ! "$sync_magpie"; then
    [[ -f "$source_home/config.toml" && -r "$source_home/config.toml" ]] || {
        echo "Cannot read $source_home/config.toml; use --source to select the host Codex home." >&2
        exit 1
    }
    if ! "$magpie" && [[ -e "$source_home/auth.json" || -L "$source_home/auth.json" ]]; then
        [[ -f "$source_home/auth.json" && -r "$source_home/auth.json" ]] || { echo 'Cannot read host auth.json.' >&2; exit 1; }
        files+=(auth.json)
    fi
fi
if [[ -z "$container" ]]; then
    ids="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=app)"
    [[ -n "$ids" ]] || { echo "No running app container for project $project; use --project or --container." >&2; exit 1; }
    mapfile -t containers <<< "$ids"
    ((${#containers[@]} == 1)) || { echo 'Multiple app containers found; select one with --container.' >&2; exit 1; }
    container="${containers[0]}"
fi
container="$(docker inspect --format '{{if .State.Running}}{{.Id}}{{end}}' "$container")"
[[ -n "$container" ]] || { echo 'Container is not running.' >&2; exit 1; }

stage=""
magpie_backup=""
magpie_complete=false
cleanup() {
    local status=$?
    trap - EXIT INT TERM
    if [[ -n "$magpie_backup" ]] && ! "$magpie_complete"; then
        magpie_gateway rollback || echo "Magpie rollback failed; keep the private backup: $magpie_backup" >&2
    fi
    if [[ -n "$stage" ]]; then
        docker exec "$container" sh -eu -c '
            home="$(realpath "${CODEX_HOME:-$HOME/.codex}")"
            stage="$(realpath "$1")"
            test "${stage%/*}" = "$home"
            case "${stage##*/}" in .config-import.*) rm -rf -- "$stage" ;; *) exit 1 ;; esac
        ' sh "$stage" >/dev/null 2>&1 || true
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

magpie_gateway() {
    python3 - "$1" "$container" "$stage" "$magpie_backup" <<'PY'
import ipaddress
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile

action, container, stage, backup_arg = sys.argv[1:]
marker = "# Managed by infinite-canvas Codex import.\n"
unit = "magpie.service"
state_dir = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "infinite-canvas"
state_file = state_dir / "magpie-gateway.json"
drop_dir = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "systemd/user/magpie.service.d"
drop_file = drop_dir / "zz-infinite-canvas-gateway.conf"

class SetupError(Exception):
    pass

def require(ok, message):
    if not ok:
        raise SetupError(message)

def run(args, *, data=None, env=None, check=True):
    result = subprocess.run(args, input=data, text=True, capture_output=True, env=env)
    require(not check or result.returncode == 0, "Command failed: " + " ".join(args[:3]) + "; command output suppressed to protect credentials.")
    return result.stdout.strip()

def show(prop):
    return run(["systemctl", "--user", "show", unit, "--property=" + prop, "--value"])

def private_dir(path):
    require(not path.is_symlink(), "Refusing a symlink directory: " + str(path))
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(path.is_dir() and path.stat().st_uid == os.getuid(), "Directory must belong to the current user: " + str(path))
    path.chmod(0o700)

def regular(path):
    require(not path.is_symlink() and (not path.exists() or (path.is_file() and path.stat().st_uid == os.getuid())), "Refusing a symlink, foreign-owned or non-file target: " + str(path))

def write(path, text):
    regular(path)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as f:
        temp = Path(f.name)
        try:
            os.chmod(temp, 0o600)
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)

def snapshot(path):
    regular(path)
    return path.read_text() if path.exists() else None

def restore(path, text):
    if text is None:
        regular(path)
        path.unlink(missing_ok=True)
    else:
        write(path, text)

def network():
    networks = json.loads(run(["docker", "inspect", "--format", "{{json .NetworkSettings.Networks}}", container]))
    require(len(networks) == 1, "Magpie setup requires exactly one application bridge network; refusing to guess a route.")
    name, addresses = next(iter(networks.items()))
    require(run(["docker", "network", "inspect", "--format", "{{.Driver}}", name]) == "bridge", "Magpie setup supports a Docker bridge network only.")
    client, gateway = (ipaddress.IPv4Address(addresses[k]) for k in ("IPAddress", "Gateway"))
    require(all(not (a.is_loopback or a.is_unspecified or a.is_multicast) for a in (client, gateway)), "Invalid Docker bridge IPv4 addresses.")
    return {"network": name, "client": str(client), "gateway": str(gateway)}

def process_env():
    pid = int(show("MainPID"))
    require(pid > 0 and show("ActiveState") == "active", "An active current-user magpie.service is required. Stop any manually started Magpie, run `magpie daemon install`, then retry; do not use sudo.")
    require(Path("/proc", str(pid)).stat().st_uid == os.getuid(), "Magpie service must run as the current user.")
    require(Path(os.readlink(f"/proc/{pid}/exe")).resolve() == Path(shutil.which("magpie")).resolve(), "The running service and the magpie command must use the same executable; restart the service after updating Magpie.")
    entries = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    return dict(e.decode().split("=", 1) for e in entries if b"=" in e)

def key_rows():
    rows = run(["magpie", "gateway-key", "list"]).splitlines()
    return [line.split() for line in rows[1:] if len(line.split()) >= 3]

def verify_unit(addr, allowed):
    require(not show("EnvironmentFiles"), "EnvironmentFile overrides are not supported; refusing to widen the listener without a verified allowlist.")
    env = dict(value.split("=", 1) for value in shlex.split(show("Environment")) if "=" in value)
    require(env.get("MAGPIE_ADDR") == addr and env.get("MAGPIE_ALLOW_IPS") == allowed, "Another systemd override supersedes the managed listener or allowlist; no restart was performed.")

def configure(addr, allowed):
    require(network() == tx["network"], "The application IP changed during setup; retry with the current container.")
    write(drop_file, marker + '[Service]\nEnvironment="MAGPIE_ADDR=' + addr + '"\nEnvironment="MAGPIE_ALLOW_IPS=' + allowed + '"\n')
    run(["systemctl", "--user", "daemon-reload"])
    verify_unit(addr, allowed)
    # Magpie supplies its own startup/readiness wait. Do not add a separate retry policy.
    run(["magpie", "daemon", "restart"], env={**os.environ, "MAGPIE_ADDR": addr}, check=False)
    env = process_env()
    require(env.get("MAGPIE_ADDR") == addr and env.get("MAGPIE_ALLOW_IPS") == allowed, "The Magpie process did not adopt the managed listener and allowlist.")

def probe(expected, authenticated):
    code = '''const fs = require("node:fs");
const p = JSON.parse(fs.readFileSync(process.argv[1] + "/magpie-gateway.json", "utf8"));
try {
  const response = await fetch(p.base_url + "/models", { redirect: "manual", headers: process.argv[3] === "yes" ? { Authorization: "Bearer " + p.key } : {} });
  await response.body?.cancel();
  process.stdout.write(String(response.status));
} catch { process.stdout.write("unreachable"); }'''
    status = run(["docker", "exec", container, "bun", "-e", code, stage, str(expected), "yes" if authenticated else "no"])
    require(status == str(expected), f"Magpie container probe expected HTTP {expected}, got {status if status.isdigit() else 'unreachable'}. Check Magpie version, firewall and gateway authentication; rollback follows.")

try:
    require(sys.platform == "linux" and os.getuid() != 0, "Run Magpie setup on Linux as its non-root host user, not with sudo.")
    require(shutil.which("magpie") is not None, "magpie must be available on the host PATH.")
    if action == "lock":
        private_dir(state_dir)
        lock_file = state_dir / "magpie-gateway.lock"
        regular(lock_file)
        fd = os.open(lock_file, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        print(lock_file)
    elif action in ("begin", "begin-sync"):
        env = process_env()
        require(env.get("HOME") == os.environ.get("HOME") and env.get("XDG_CONFIG_HOME", str(Path.home() / ".config")) == os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config")), "The Magpie service uses another HOME/XDG_CONFIG_HOME; run with that user's configuration.")
        require(not env.get("MAGPIE_TLS_CERT") and not env.get("MAGPIE_TLS_KEY"), "Existing Magpie TLS configuration is not changed automatically.")
        require(not show("EnvironmentFiles"), "Magpie EnvironmentFile overrides are unsupported; no host changes were made.")
        private_dir(state_dir)
        private_dir(drop_dir)
        previous_drop = snapshot(drop_file)
        require(previous_drop is None or previous_drop.startswith(marker), "The target drop-in is not owned by this script; refusing to overwrite it.")
        previous_state = snapshot(state_file)
        identity = json.loads(previous_state) if previous_state is not None else None
        if action == "begin-sync":
            require(identity is not None and previous_drop is not None, "Initialize --magpie-gateway as the Magpie service owner first; CI sync requires that same user and managed key state.")
        if identity is not None:
            require(all(isinstance(identity.get(k), str) and identity[k] for k in ("id", "name", "key")), "Invalid managed Magpie key state; restore its private backup before retrying.")
            require(any(row[:3] == [identity["id"], identity["name"], "enabled"] for row in key_rows()), "The managed gateway key was revoked, renamed or disabled; refusing to recreate it silently.")
        backup = Path(tempfile.mkdtemp(prefix="magpie-backup-", dir=state_dir))
        tx = {"network": network(), "previous_drop": previous_drop, "previous_state": previous_state, "identity": identity, "new_key": identity is None, "service_changed": False, "service_env": {k: env.get(k) for k in ("MAGPIE_ADDR", "MAGPIE_ALLOW_IPS")}}
        write(backup / "transaction.json", json.dumps(tx))
        print(backup)
    else:
        backup = Path(backup_arg)
        require(backup.resolve().parent == state_dir.resolve() and backup.name.startswith("magpie-backup-") and not backup.is_symlink(), "Invalid Magpie backup directory.")
        tx = json.loads((backup / "transaction.json").read_text())
        if action == "prepare":
            if tx["new_key"]:
                tx["identity"] = {"name": "infinite-canvas-" + secrets.token_hex(8)}
                write(backup / "transaction.json", json.dumps(tx))
                key = run(["magpie", "gateway-key", "add", tx["identity"]["name"]])
                require(key and key.isascii() and not any(c.isspace() for c in key), "Magpie did not return a valid gateway key; command output is suppressed.")
                matches = [row for row in key_rows() if row[1] == tx["identity"]["name"]]
                require(len(matches) == 1 and matches[0][2] == "enabled", "Cannot identify the newly created gateway key.")
                tx["identity"].update(id=matches[0][0], key=key)
                write(backup / "transaction.json", json.dumps(tx))
            payload = {"base_url": "http://" + tx["network"]["gateway"] + ":3425/v1", "key": tx["identity"]["key"]}
            run(["docker", "exec", "-i", container, "sh", "-eu", "-c", 'umask 077; cat > "$1/magpie-gateway.json"', "sh", stage], data=json.dumps(payload))
        elif action == "activate":
            # Prove the allowlist is enforced before exposing any LAN-facing listener.
            tx["service_changed"] = True
            write(backup / "transaction.json", json.dumps(tx))
            configure(tx["network"]["gateway"] + ":3425", "127.0.0.1")
            probe(403, True)
            configure(tx["network"]["gateway"] + ":3425", tx["network"]["client"] + "/32")
            probe(401, False)
            probe(200, True)
            configure("0.0.0.0:3425", tx["network"]["client"] + "/32")
            probe(401, False)
            probe(200, True)
            print("Magpie checks passed: excluded IP denied, missing key denied, application key accepted.")
        elif action == "commit":
            require(network() == tx["network"], "The application IP changed during setup; retry with the current container.")
            write(state_file, json.dumps(tx["identity"]))
            print("Magpie private backup: " + str(backup))
            print("Magpie allows the selected application IP only: " + tx["network"]["client"] + "/32 (host-local access is retained).")
        elif action == "rollback":
            failures = []
            try:
                restore(state_file, tx["previous_state"])
                if tx["service_changed"]:
                    restore(drop_file, tx["previous_drop"])
                    run(["systemctl", "--user", "daemon-reload"])
                    run(["magpie", "daemon", "restart"], check=False)
                    env = process_env()
                    require(all(env.get(k) == v for k, v in tx["service_env"].items()), "The service did not restore its previous network environment.")
            except Exception:
                failures.append("service/key-state restore")
            try:
                if tx["new_key"] and tx["identity"]:
                    matches = [row for row in key_rows() if row[1] == tx["identity"]["name"]]
                    require(len(matches) <= 1, "Ambiguous newly created gateway key.")
                    if matches:
                        run(["magpie", "gateway-key", "remove", matches[0][0]])
            except Exception:
                failures.append("new-key revocation (name: " + tx["identity"]["name"] + ")")
            require(not failures, "Magpie rollback needs manual recovery: " + ", ".join(failures) + "; private backup: " + str(backup))
            print("Magpie service configuration and managed key state restored; backup: " + str(backup), file=sys.stderr)
        else:
            raise SetupError("Unknown Magpie setup action.")
except Exception as error:
    print(str(error) if isinstance(error, SetupError) else "Magpie setup failed; no command output or credential details are shown. Keep the private backup for recovery.", file=sys.stderr)
    sys.exit(1)
PY
}

check_magpie_container() {
docker exec -e "MAGPIE_SYNC_STAGE=$stage" "$container" bun -e '
    const fs = require("node:fs");
    const path = require("node:path");
    try {
        const file = path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "config.toml");
        const config = fs.existsSync(file) ? Bun.TOML.parse(fs.readFileSync(file, "utf8")) : {};
        if (config.model_provider !== "infinite_canvas_magpie") {
            if (process.env.MAGPIE_SYNC_STAGE) throw new Error();
            console.log("unmanaged"); process.exit(0);
        }
        if (process.env.MAGPIE_SYNC_STAGE) {
            const gateway = JSON.parse(fs.readFileSync(path.join(process.env.MAGPIE_SYNC_STAGE, "magpie-gateway.json"), "utf8"));
            const provider = config.model_providers?.infinite_canvas_magpie;
            if (config.profile || provider?.base_url !== gateway.base_url || provider?.experimental_bearer_token !== gateway.key || provider?.requires_openai_auth !== false) throw new Error();
        }
        console.log("managed");
    } catch {
        console.error("Container Magpie configuration does not match the managed gateway. Run --magpie-gateway as the Magpie service owner to initialize or repair it.");
        process.exit(1);
    }
'
}
if "$sync_magpie"; then
    provider_mode="$(check_magpie_container)"
    if [[ "$provider_mode" == unmanaged ]]; then
        echo 'Magpie gateway sync skipped: app does not use the managed Magpie provider.'
        exit 0
    fi
    magpie=true
fi

# Use the container user so imported credentials remain readable without root/chown.
stage="$(docker exec "$container" sh -eu -c '
    umask 077
    home="${CODEX_HOME:-$HOME/.codex}"
    test -d "$home" && test -w "$home" || { echo "Container CODEX_HOME must exist and be writable." >&2; exit 1; }
    home="$(realpath "$home")"
    mktemp -d "$home/.config-import.XXXXXX"
')"
if ! "$sync_magpie"; then
    tar -C "$source_home" -chf - -- "${files[@]}" | docker exec -i "$container" tar -xf - -C "$stage"

    catalog_source="$(docker exec -e "CODEX_IMPORT_STAGE=$stage" "$container" bun -e '
    try {
        const text = require("node:fs").readFileSync(process.env.CODEX_IMPORT_STAGE + "/config.toml", "utf8");
        const catalog = Bun.TOML.parse(text).model_catalog_json;
        if (catalog !== undefined && (typeof catalog !== "string" || !catalog)) throw new Error();
        process.stdout.write(catalog || "");
    } catch { console.error("Cannot read model_catalog_json from host config.toml; no container files were replaced."); process.exit(1); }
    ')"
    if [[ -n "$catalog_source" ]]; then
        [[ "$catalog_source" == /* ]] || catalog_source="$source_home/$catalog_source"
        [[ -f "$catalog_source" && -r "$catalog_source" ]] || {
            echo 'The host model_catalog_json file is missing or unreadable; fix the host configuration before importing.' >&2
            exit 1
        }
        docker exec -i "$container" sh -eu -c 'umask 077; cat > "$1/imported-model-catalog.json"' sh "$stage" < "$catalog_source"
    fi
fi

if "$magpie"; then
    command -v python3 >/dev/null || { echo 'Magpie setup requires Python 3 on the host.' >&2; exit 1; }
    command -v flock >/dev/null || { echo 'Magpie setup requires flock on the host.' >&2; exit 1; }
    magpie_lock_path="$(magpie_gateway lock)"
    exec {magpie_lock_fd}<>"$magpie_lock_path"
    flock -n "$magpie_lock_fd" || { echo 'Another Magpie gateway import is running; no host changes were made.' >&2; exit 1; }
    if "$sync_magpie"; then
        magpie_backup="$(magpie_gateway begin-sync)"
    else
        magpie_backup="$(magpie_gateway begin)"
    fi
    magpie_gateway prepare
fi

if "$sync_magpie"; then
    check_magpie_container >/dev/null
    echo 'Synchronizing Magpie gateway for the current application container.'
    magpie_gateway activate
    magpie_gateway commit
    magpie_complete=true
    exit 0
fi

# Parse with the runtime already shipped in the image; never print source contents.
apply_config() {
docker exec -e "CODEX_IMPORT_STAGE=$stage" -e "CODEX_IMPORT_MAGPIE=$magpie" -e "CODEX_IMPORT_PHASE=$1" "$container" bun -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const { spawnSync } = require("node:child_process");
    const { isDeepStrictEqual } = require("node:util");
    const stage = process.env.CODEX_IMPORT_STAGE;
    const home = path.dirname(stage);
    const catalogName = "imported-model-catalog.json";
    const files = [catalogName, "auth.json", "config.toml"].filter(name => fs.existsSync(path.join(stage, name)));
    const fail = message => { console.error(message); process.exit(1); };
    if (process.env.CODEX_IMPORT_PHASE === "prepare") {
        let config;
        try {
            const configPath = path.join(stage, "config.toml");
            const text = fs.readFileSync(configPath, "utf8");
            config = Bun.TOML.parse(text);
            if (files.includes(catalogName)) {
                const destination = path.join(home, catalogName);
                const updated = text.replace(/^[ \t]*model_catalog_json[ \t]*=[^\r\n]*/m, `model_catalog_json = ${JSON.stringify(destination)}`);
                const parsed = Bun.TOML.parse(updated);
                // Verify the targeted text edit changes no other TOML value.
                if (!isDeepStrictEqual(parsed, { ...config, model_catalog_json: destination })) {
                    fail("Cannot safely rewrite model_catalog_json; use a single-line top-level assignment. No container files were replaced.");
                }
                fs.writeFileSync(configPath, updated, { mode: 0o600 });
                config = parsed;
            }
            if (files.includes("auth.json")) {
                const auth = JSON.parse(fs.readFileSync(path.join(stage, "auth.json"), "utf8"));
                if (!auth || typeof auth !== "object" || Array.isArray(auth)) throw new Error();
            }
            if (process.env.CODEX_IMPORT_MAGPIE === "true") {
                if (config.model_provider !== "magpie" || config.profile) fail("Magpie gateway setup requires the top-level magpie provider without a default profile; host configuration is unchanged.");
                const local = new URL(config.model_providers?.magpie?.base_url);
                if (local.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(local.hostname) || local.port !== "3425" || local.username || local.password) fail("Magpie gateway setup requires a host-local HTTP magpie provider on port 3425.");
                const gateway = JSON.parse(fs.readFileSync(path.join(stage, "magpie-gateway.json"), "utf8"));
                const providerId = "infinite_canvas_magpie";
                if (config.model_providers?.[providerId]) fail("The reserved infinite_canvas_magpie provider already exists in the host config; refusing to overwrite it.");
                const provider = { name: "Magpie (Infinite Canvas)", base_url: gateway.base_url, wire_api: "responses", supports_websockets: false, requires_openai_auth: false, experimental_bearer_token: gateway.key };
                const current = fs.readFileSync(configPath, "utf8");
                let updated = current.replace(/^[ \t]*model_provider[ \t]*=[^\r\n]*/m, `model_provider = ${JSON.stringify(providerId)}`);
                updated += `\n[model_providers.${providerId}]\n` + Object.entries(provider).map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join("");
                const parsed = Bun.TOML.parse(updated);
                if (!isDeepStrictEqual(parsed, { ...config, model_provider: providerId, model_providers: { ...config.model_providers, [providerId]: provider } })) fail("Cannot safely configure the container Magpie provider; no live files were replaced.");
                fs.writeFileSync(configPath, updated, { mode: 0o600 });
                config = parsed;
            }
        } catch { fail("Invalid config.toml or auth.json; no container files were replaced."); }
        if (config.cli_auth_credentials_store === "keyring") {
            fail("OS keyring credentials cannot be copied. Configure file-based Codex authentication on the host first.");
        }
        const envNames = new Set();
        for (const provider of Object.values(config.model_providers || {})) {
            for (const name of [provider?.env_key, ...Object.values(provider?.env_http_headers || {})]) {
                if (typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) envNames.add(name);
            }
        }
        const missing = [...envNames].filter(name => !process.env[name]?.trim());
        if (missing.length) console.warn(`Warning: provider environment variables missing in container: ${missing.join(", ")}. Host shell exports are not copied.`);
        if (!files.includes("auth.json") && process.env.CODEX_IMPORT_MAGPIE !== "true") console.warn("Warning: host auth.json is absent; existing container auth.json is unchanged. Host environment and OS keyring credentials are not copied.");

        // Validate staged files with the shipped CLI, before touching the live config.
        const overrides = files.includes(catalogName) ? ["-c", `model_catalog_json=${JSON.stringify(path.join(stage, catalogName))}`] : [];
        const validation = spawnSync("codex", ["app-server", "--print-startup-config", ...overrides], {
            env: { ...process.env, CODEX_HOME: stage },
            cwd: "/app/canvas-agent",
            encoding: "utf8",
        });
        if (validation.error || validation.status !== 0) {
            fail("Container Codex could not load the staged configuration. Check referenced files, credentials and CLI version compatibility. No container files were replaced.");
        }
        process.exit(0);
    }

    const previous = new Set();
    let backup;
    try {
        for (const name of files) {
            const stat = fs.lstatSync(path.join(home, name), { throwIfNoEntry: false });
            if (stat && !stat.isFile()) fail(`Refusing to replace a symlink or non-file: ${name}`);
            if (stat) previous.add(name);
            fs.chmodSync(path.join(stage, name), 0o600);
        }
        backup = fs.mkdtempSync(path.join(home, `config-backup-${new Date().toISOString().replace(/[:.]/g, "-")}-`));
        fs.chmodSync(backup, 0o700);
        for (const name of previous) {
            fs.copyFileSync(path.join(home, name), path.join(backup, name), fs.constants.COPYFILE_EXCL);
            fs.chmodSync(path.join(backup, name), 0o600);
        }
    } catch { fail("Could not prepare a private backup; no container files were replaced."); }

    const installed = [];
    try {
        for (const name of files) {
            fs.renameSync(path.join(stage, name), path.join(home, name));
            installed.push(name);
        }
    } catch {
        let restored = true;
        for (const name of installed.reverse()) {
            try {
                if (previous.has(name)) {
                    fs.copyFileSync(path.join(backup, name), path.join(home, name));
                    fs.chmodSync(path.join(home, name), 0o600);
                } else fs.unlinkSync(path.join(home, name));
            } catch { restored = false; }
        }
        fail(`Import failed; ${restored ? "replaced files were restored" : "automatic restore failed; restore manually"}. Backup: ${backup}`);
    }
    console.log(`Imported: ${files.join(", ")} -> ${home}\nContainer backup: ${backup}\nHost files were preserved.`);
'
}

apply_config prepare
if "$magpie"; then
    magpie_gateway activate
    magpie_gateway commit
fi
apply_config install
magpie_complete=true

if "$restart"; then
    docker restart "$container"
    echo 'Application restarted. Open a new Codex conversation to verify the provider and authentication.'
else
    printf 'Restart the app when no tasks are running: docker restart %q\n' "$container"
fi
