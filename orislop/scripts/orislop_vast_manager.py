#!/usr/bin/env python3
"""Detached lifecycle manager for the private Orislop Vast detector."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from typing import Any, Callable, Iterator, Mapping, Sequence
import urllib.error
import urllib.request


DEFAULT_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_DIR = DEFAULT_ROOT / "apps" / "detector-bridge"
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))
from deployment_runtime import GIB, calculate_storage_plan  # noqa: E402


DIRECT_ACK = "I_UNDERSTAND_PORT_4317_MUST_NOT_BE_PUBLIC"
PUBLIC_ACK = "I_UNDERSTAND_PUBLIC_PORT_REQUIRES_AUTH"


class FriendlyError(RuntimeError):
    """An operator-facing error whose text is safe to print."""


def truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def load_pin(root: Path) -> dict[str, Any]:
    path = root / "PINNED_TEST_RELEASE.json"
    try:
        pin = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise FriendlyError("This package is incomplete: PINNED_TEST_RELEASE.json is missing or invalid.") from error
    required = {
        "modelRepository",
        "modelRevision",
        "modelManifestSha256",
        "modelBytes",
        "extensionId",
    }
    if not required.issubset(pin):
        raise FriendlyError("This package is incomplete: the pinned release receipt lacks required fields.")
    return pin


def state_paths(env: Mapping[str, str]) -> dict[str, Path]:
    root = Path(env.get("ORISLOP_STATUS_ROOT", "/run/orislop-vast")).expanduser()
    return {
        "root": root,
        "pid": root / "manager.pid",
        "lock": root / "manager.lock",
        "status": root / "status.json",
        "log": Path(env.get("ORISLOP_LOG_FILE", "/var/log/orislop-vast.log")).expanduser(),
    }


def pid_alive(pid: int) -> bool:
    if pid <= 1:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError, OSError):
        return False


def read_pid(path: Path) -> int | None:
    try:
        value = path.read_text(encoding="ascii").strip()
    except OSError:
        return None
    return int(value) if value.isdigit() else None


def pid_matches_orislop(pid: int) -> bool:
    command_path = Path(f"/proc/{pid}/cmdline")
    if not command_path.is_file():
        return True
    try:
        command = command_path.read_bytes().replace(b"\0", b" ").decode("utf-8", errors="replace")
    except OSError:
        return False
    return "vast-production-run.sh" in command or "vast_supervisor.py" in command


def recover_stale_pid(
    path: Path,
    *,
    alive: Callable[[int], bool] = pid_alive,
    owned: Callable[[int], bool] | None = None,
) -> tuple[int | None, bool]:
    """Return a live PID and remove only an invalid/stale manager receipt."""

    pid = read_pid(path)
    if pid is not None and alive(pid) and (owned is None or owned(pid)):
        return pid, False
    if path.exists():
        path.unlink(missing_ok=True)
        return None, True
    return None, False


@contextmanager
def exclusive_lock(path: Path) -> Iterator[None]:
    """Hold a non-blocking Linux flock while mutating lifecycle receipts."""

    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    try:
        try:
            import fcntl
        except ImportError as error:
            raise FriendlyError("The Vast lifecycle manager requires Linux file locking.") from error
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise FriendlyError("Another Orislop start, stop, or restart command is already running.") from error
        yield
    finally:
        handle.close()


def atomic_write(path: Path, text: str, *, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    if mode is not None:
        temporary.chmod(mode)
    os.replace(temporary, path)


def write_phase(status_path: Path, phase: str, **details: Any) -> None:
    payload = {
        "phase": phase,
        "state": phase if phase in {"failed", "ready", "stopped"} else "starting",
        "updated_at_epoch": int(time.time()),
        **details,
    }
    atomic_write(status_path, json.dumps(payload, indent=2, sort_keys=True) + "\n", mode=0o600)


def require_new_hf_token(env: Mapping[str, str]) -> str:
    token = env.get("HF_TOKEN", "").strip()
    if not token:
        raise FriendlyError(
            "Hugging Face access is not configured. Export a newly rotated HF_TOKEN and run again. "
            "The launcher never opens a hidden prompt."
        )
    if token.lower() in {"replace_me", "changeme", "token"}:
        raise FriendlyError("HF_TOKEN is a placeholder. Export a newly rotated Hugging Face read token.")
    return token


def build_child_environment(base: Mapping[str, str], root: Path, pin: Mapping[str, Any]) -> dict[str, str]:
    require_new_hf_token(base)
    child = dict(base)
    child.update({
        "ORISLOP_APP_ROOT": str(root),
        "ORISLOP_COMPLETE_STACK_REPO": str(pin["modelRepository"]),
        "ORISLOP_COMPLETE_STACK_REVISION": str(pin["modelRevision"]),
        "ORISLOP_EXPECTED_MANIFEST_SHA256": str(pin["modelManifestSha256"]),
        "ORISLOP_EXPECTED_RELEASE_BYTES": str(pin["modelBytes"]),
        "ORISLOP_ALLOWED_EXTENSION_ORIGINS": f"chrome-extension://{pin['extensionId']}",
        "ORISLOP_DETECTOR_PORT": child.get("ORISLOP_DETECTOR_PORT", "4317"),
        "ORISLOP_REQUIRE_CLOUDFLARE": "0",
        "ORISLOP_REQUIRE_FULL_MODEL_STACK": "1",
        "ORISLOP_TEMPORAL_ENABLED": "1",
        "ORISLOP_AV_JOINT_ENABLED": "1",
    })
    public = truthy(child.get("ORISLOP_PUBLIC_MAPPED_MODE"))
    if public:
        if child.get("ORISLOP_PUBLIC_MAPPED_ACK", "") != PUBLIC_ACK:
            raise FriendlyError(
                f"Public mapped-port mode requires ORISLOP_PUBLIC_MAPPED_ACK={PUBLIC_ACK}."
            )
        tokens = [part.strip() for part in child.get("ORISLOP_API_TOKENS", "").split(",") if part.strip()]
        if not tokens or any(len(token) < 32 for token in tokens):
            raise FriendlyError("Public mapped-port mode requires a private API token of at least 32 characters.")
        child.update({
            "ORISLOP_DETECTOR_HOST": "0.0.0.0",
            "ORISLOP_REQUIRE_API_AUTH": "1",
            "ORISLOP_VAST_DIRECT_TESTING_ACK": PUBLIC_ACK,
        })
    else:
        child.update({
            "ORISLOP_DETECTOR_HOST": "127.0.0.1",
            "ORISLOP_REQUIRE_API_AUTH": "0",
            "ORISLOP_VAST_DIRECT_TESTING_ACK": DIRECT_ACK,
            "ORISLOP_PUBLIC_MAPPED_MODE": "0",
            "ORISLOP_VISUAL_ROLLOUT_MODE": "testing",
            "ORISLOP_CLOUD_HEAVY_ROLLOUT": "strict-testing",
            "ORISLOP_PRIVATE_STRICT_AUTOMATIC_HIDES": "1",
        })
    return child


def requirements_stamp_exists(root: Path, env: Mapping[str, str]) -> bool:
    requirements = root / "apps" / "detector-bridge" / "requirements.txt"
    venv = Path(env.get("ORISLOP_VENV", "/opt/orislop-venv"))
    if not requirements.is_file():
        return False
    digest = hashlib.sha256(requirements.read_bytes()).hexdigest()
    return (venv / f".orislop-requirements-{digest}").is_file()


def verified_model_bytes(root: Path, env: Mapping[str, str], pin: Mapping[str, Any]) -> int:
    scripts = root / "scripts"
    if str(scripts) not in sys.path:
        sys.path.insert(0, str(scripts))
    try:
        from materialize_complete_stack import verified_existing_bytes
    except ImportError:
        return 0
    destination = Path(env.get("ORISLOP_COMPLETE_STACK_ROOT", "/models/orislop-complete-stack"))
    return verified_existing_bytes(destination, str(pin["modelManifestSha256"]))


def storage_preflight(root: Path, env: Mapping[str, str], pin: Mapping[str, Any]) -> dict[str, Any]:
    model_root = Path(env.get("ORISLOP_MODEL_ROOT", "/models")).expanduser()
    model_root.mkdir(parents=True, exist_ok=True)
    dependencies = 0 if requirements_stamp_exists(root, env) else int(
        float(env.get("ORISLOP_STORAGE_DEPENDENCIES_GIB", "6")) * GIB
    )
    plan = calculate_storage_plan(
        release_bytes=int(pin["modelBytes"]),
        verified_bytes=verified_model_bytes(root, env, pin),
        dependencies_bytes=dependencies,
        scratch_bytes=int(float(env.get("ORISLOP_VIDEO_SCRATCH_GIB", "4")) * GIB),
        safety_reserve_bytes=int(float(env.get("ORISLOP_STORAGE_SAFETY_GIB", "5")) * GIB),
    )
    import shutil
    free = shutil.disk_usage(model_root).free
    plan["disk_free_bytes"] = free
    plan["disk_free_gib"] = round(free / GIB, 2)
    plan["required_free_gib"] = round(plan["required_free_bytes"] / GIB, 2)
    if free < plan["required_free_bytes"]:
        raise FriendlyError(
            f"This instance has {free / GIB:.1f} GiB free, but the current manifest-aware plan needs "
            f"{plan['required_free_bytes'] / GIB:.1f} GiB (downloads, temporary materialization, "
            "missing dependencies, video scratch space, and safety reserve). Vast disks cannot be "
            "resized after creation; rent a new instance with 80 GiB minimum and 100 GiB preferred."
        )
    return plan


def request_ready(port: int) -> tuple[int, dict[str, Any]]:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/ready",
        headers={"Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.loads(error.read().decode("utf-8"))
        except json.JSONDecodeError:
            return error.code, {"ok": False, "state": "starting"}


def wait_for_readiness(paths: Mapping[str, Path], pid: int, port: int, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    previous = ""
    while time.monotonic() < deadline:
        if not pid_alive(pid):
            status = read_json(paths["status"])
            detail = status.get("detail") or status.get("error") or "See the detailed log."
            raise FriendlyError(f"Orislop stopped before it became ready. {detail}")
        status = read_json(paths["status"])
        phase = str(status.get("phase") or "starting")
        if phase != previous:
            print(f"[orislop-vast] phase={phase}", flush=True)
            previous = phase
        try:
            _, payload = request_ready(port)
            if payload.get("state") == "failed":
                raise FriendlyError(str(payload.get("detail") or "Model loading failed; see the detailed log."))
            if payload.get("ok") is True and payload.get("state") == "ready":
                return payload
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError):
            pass
        time.sleep(2)
    raise FriendlyError(
        "Orislop is still starting after the wait deadline. It was left running; use status, logs, and readiness commands to monitor it."
    )


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def powershell_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def tunnel_command(*, dynamic_ip: str, ssh_port: int, username: str, identity_file: str) -> str:
    script = ".\\scripts\\start-extension-test-tunnel.ps1"
    return " ".join([
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", powershell_quote(script),
        "-DynamicIP", powershell_quote(dynamic_ip),
        "-SshPort", str(ssh_port),
        "-Username", powershell_quote(username),
        "-IdentityFile", powershell_quote(identity_file),
        "-LocalPort", "4317",
        "-RemotePort", "4317",
    ])


def print_endpoints(env: Mapping[str, str]) -> None:
    port = int(env.get("ORISLOP_DETECTOR_PORT", "4317"))
    print(f"[orislop-vast] local endpoint: http://127.0.0.1:{port}")
    ip = env.get("ORISLOP_VAST_IP", "VAST_DYNAMIC_IP")
    ssh_port = int(env.get("ORISLOP_VAST_SSH_PORT", "VAST_SSH_PORT") if env.get("ORISLOP_VAST_SSH_PORT", "").isdigit() else 22)
    username = env.get("ORISLOP_VAST_SSH_USER", "root")
    key = env.get("ORISLOP_VAST_SSH_KEY_WINDOWS", "C:\\path\\to\\private-key")
    print("[orislop-vast] Windows tunnel command:")
    print(tunnel_command(dynamic_ip=ip, ssh_port=ssh_port, username=username, identity_file=key))


def start(root: Path, env: Mapping[str, str], *, wait_seconds: float) -> int:
    pin = load_pin(root)
    child = build_child_environment(env, root, pin)
    paths = state_paths(child)
    paths["root"].mkdir(parents=True, exist_ok=True)
    paths["log"].parent.mkdir(parents=True, exist_ok=True)
    with exclusive_lock(paths["lock"]):
        live_pid, recovered = recover_stale_pid(paths["pid"], owned=pid_matches_orislop)
        if live_pid is not None:
            raise FriendlyError(f"Orislop is already running with PID {live_pid}; duplicate launch was blocked.")
        if recovered:
            print("[orislop-vast] recovered a stale PID receipt", flush=True)
        plan = storage_preflight(root, child, pin)
        write_phase(paths["status"], "environment-validation", storage=plan)
        runner = root / "scripts" / "vast-production-run.sh"
        if not runner.is_file():
            raise FriendlyError("This package is incomplete: vast-production-run.sh is missing.")
        log_handle = paths["log"].open("ab", buffering=0)
        try:
            process = subprocess.Popen(
                ["bash", str(runner), str(root)],
                env=child,
                stdin=subprocess.DEVNULL,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                close_fds=True,
            )
        finally:
            log_handle.close()
        atomic_write(paths["pid"], f"{process.pid}\n", mode=0o600)
    print(f"[orislop-vast] detached PID {process.pid}; logs={paths['log']}", flush=True)
    payload = wait_for_readiness(
        paths,
        process.pid,
        int(child.get("ORISLOP_DETECTOR_PORT", "4317")),
        wait_seconds,
    )
    print(json.dumps(payload, indent=2, sort_keys=True))
    print_endpoints(child)
    return 0


def stop(env: Mapping[str, str], *, timeout: float = 45) -> int:
    paths = state_paths(env)
    with exclusive_lock(paths["lock"]):
        pid, _ = recover_stale_pid(paths["pid"], owned=pid_matches_orislop)
        if pid is None:
            print("[orislop-vast] Orislop is already stopped.")
            return 0
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and pid_alive(pid):
            time.sleep(0.5)
        if pid_alive(pid):
            raise FriendlyError(
                f"PID {pid} did not stop after {timeout:.0f}s. It was not force-killed; inspect the logs before using an explicit OS-level kill."
            )
        paths["pid"].unlink(missing_ok=True)
        write_phase(paths["status"], "stopped")
    print("[orislop-vast] stopped")
    return 0


def show_status(env: Mapping[str, str]) -> int:
    paths = state_paths(env)
    pid, stale = recover_stale_pid(paths["pid"], owned=pid_matches_orislop)
    payload = read_json(paths["status"])
    payload.update({"manager_pid": pid, "manager_state": "running" if pid else "stopped", "stale_pid_recovered": stale})
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if pid else 3


def show_logs(env: Mapping[str, str], *, lines: int, follow: bool) -> int:
    path = state_paths(env)["log"]
    if not path.is_file():
        raise FriendlyError(f"No log exists yet at {path}.")
    with path.open("r", encoding="utf-8", errors="replace") as source:
        content = source.readlines()
        for line in content[-lines:]:
            print(line, end="")
        if not follow:
            return 0
        while True:
            line = source.readline()
            if line:
                print(line, end="", flush=True)
            else:
                time.sleep(0.5)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    sub = parser.add_subparsers(dest="command", required=True)
    start_parser = sub.add_parser("start")
    start_parser.add_argument("--wait-seconds", type=float, default=float(os.environ.get("ORISLOP_START_WAIT_SECONDS", "3600")))
    sub.add_parser("stop")
    restart_parser = sub.add_parser("restart")
    restart_parser.add_argument("--wait-seconds", type=float, default=float(os.environ.get("ORISLOP_START_WAIT_SECONDS", "3600")))
    sub.add_parser("status")
    sub.add_parser("readiness")
    logs_parser = sub.add_parser("logs")
    logs_parser.add_argument("--lines", type=int, default=100)
    logs_parser.add_argument("--follow", action="store_true")
    tunnel = sub.add_parser("tunnel-command")
    tunnel.add_argument("--ip", required=True)
    tunnel.add_argument("--ssh-port", type=int, required=True)
    tunnel.add_argument("--username", default="root")
    tunnel.add_argument("--identity-file", required=True)
    phase = sub.add_parser("_write-phase")
    phase.add_argument("phase")
    phase.add_argument("--detail", default="")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = Path(args.root).expanduser().resolve()
    env = dict(os.environ)
    try:
        if args.command == "start":
            return start(root, env, wait_seconds=args.wait_seconds)
        if args.command == "stop":
            return stop(env)
        if args.command == "restart":
            stop(env)
            return start(root, env, wait_seconds=args.wait_seconds)
        if args.command == "status":
            return show_status(env)
        if args.command == "readiness":
            status, payload = request_ready(int(env.get("ORISLOP_DETECTOR_PORT", "4317")))
            print(json.dumps(payload, indent=2, sort_keys=True))
            return 0 if status == 200 and payload.get("state") == "ready" else 4
        if args.command == "logs":
            return show_logs(env, lines=max(1, args.lines), follow=args.follow)
        if args.command == "tunnel-command":
            print(tunnel_command(
                dynamic_ip=args.ip,
                ssh_port=args.ssh_port,
                username=args.username,
                identity_file=args.identity_file,
            ))
            return 0
        if args.command == "_write-phase":
            write_phase(state_paths(env)["status"], args.phase, detail=args.detail)
            return 0
        raise FriendlyError(f"Unknown command: {args.command}")
    except FriendlyError as error:
        print(f"[orislop-vast] {error}", file=sys.stderr, flush=True)
        return 2
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(
            f"[orislop-vast] The operation could not be completed safely: {error}. See the detailed log for debugging.",
            file=sys.stderr,
            flush=True,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
