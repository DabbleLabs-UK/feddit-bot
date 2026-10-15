#!/usr/bin/env python3
"""Supervise the Windows worker identity, never the WSL interop proxy."""

import base64
import datetime
import hashlib
import json
import ntpath
import os
from pathlib import Path
import re
import select
import signal
import socket
import subprocess
import sys
import time


QUARANTINE = 78
HEARTBEAT_MAX_AGE = 15
START_SECONDS = 60
STOP_SECONDS = 34 * 60
POLL_SECONDS = 5
NODE = r"C:\Program Files\nodejs\node.exe"
POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
NODE_WSL = "/mnt/c/Program Files/nodejs/node.exe"
STOP_HELPER = Path("/mnt/c/dev/inference-maintenance/release-0271-helper/worker-maintenance-bootstrap.ps1")
STOP_HELPER_SHA256 = "02277f3342dd0491717eebc8aca8cc8864fe6b23fd47267b18fbdff7113f904e"
SAFE_REASONS = frozenset(("PROCESS_IDENTITY_UNREADABLE", "WORKER_IDENTITY_MISMATCH", "STOP_HELPER_UNVERIFIED",
                          "LAUNCH_IDENTITY_UNCONFIRMED", "EXISTING_WORKER", "WORKER_OWNERSHIP_CHANGED",
                          "HEARTBEAT_UNVERIFIED", "GRACEFUL_STOP_UNCONFIRMED", "IDENTITY_SNAPSHOT_UNVERIFIED", "CHECK_FAILED"))

# No command lines, credentials, request IDs, prompts or job IDs enter health.
RECORD_FUNCTION = r"""
function Record($p) {
    @{ pid = [int]$p.ProcessId; startedAt = $p.CreationDate.ToUniversalTime().ToString('o');
       commandLine = $p.CommandLine; executable = $p.ExecutablePath }
}
"""


class UnsafeState(Exception):
    pass


def safe_reason(error):
    return str(error) if isinstance(error, UnsafeState) and str(error) in SAFE_REASONS else "CHECK_FAILED"


def health_record(identity, state, now, ready=False, heartbeat=None, reason=None):
    return {"version": 1, "supervisorPid": os.getpid(),
            "pid": identity["pid"] if identity else None,
            "startedAt": identity["startedAt"] if identity else None,
            "state": state, "ready": ready, "updatedAt": now,
            "maintenance": heartbeat.get("state") if heartbeat else None,
            "active": heartbeat.get("active") if heartbeat else None,
            "reason": reason if reason in SAFE_REASONS else None}


def publish_health(directory, status):
    temporary = directory / "health.json.tmp"
    temporary.write_text(json.dumps(status) + "\n", encoding="utf-8")
    temporary.replace(directory / "health.json")


def ps_quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def ps_command(script):
    prefix = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding; "
    encoded = base64.b64encode((prefix + script).encode("utf-16le")).decode("ascii")
    return [POWERSHELL, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]


def same_path(left, right):
    return isinstance(left, str) and ntpath.normcase(ntpath.normpath(left)) == ntpath.normcase(ntpath.normpath(right))


def script_path(record):
    command = record.get("commandLine")
    if not isinstance(command, str):
        return None
    match = re.fullmatch(r'\s*(?:"[^"]+"|\S+)\s+(?:"([^"]+)"|(\S+))\s*', command)
    return (match.group(1) or match.group(2)) if match else None


def candidates(records):
    # Unreadable Node identity might conceal another worker. Fail closed.
    if not isinstance(records, list) or any(not item.get("commandLine") or not item.get("startedAt")
                                            or not item.get("executable") for item in records):
        raise UnsafeState("PROCESS_IDENTITY_UNREADABLE")
    return [item for item in records if re.search(r'(^|[\\/\s"])worker\.js(?=["\s]|$)',
                                                 item["commandLine"], re.IGNORECASE)]


def validate_identity(record, expected):
    if (not isinstance(record, dict) or type(record.get("pid")) is not int or record["pid"] <= 0
            or not record.get("startedAt") or not same_path(record.get("executable"), NODE)
            or not same_path(script_path(record), expected)):
        raise UnsafeState("WORKER_IDENTITY_MISMATCH")
    return record


def same_identity(first, second):
    return all(first.get(key) == second.get(key) for key in ("pid", "startedAt", "commandLine", "executable"))


def timestamp(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def valid_heartbeat(status, identity, now):
    try:
        age = now - timestamp(status["updatedAt"])
        return (status.get("version") == 1 and type(status.get("pid")) is int
                and status["pid"] == identity["pid"] and -2 <= age <= HEARTBEAT_MAX_AGE
                and timestamp(status["updatedAt"]) >= timestamp(identity["startedAt"])
                and status.get("state") in ("running", "draining", "held")
                and type(status.get("active")) is int and status["active"] in (0, 1))
    except (KeyError, TypeError, ValueError, AttributeError):
        return False


class Host:
    def __init__(self, release, state):
        self.release = release
        self.state = state
        self.proxy = None
        self.stop_proxy = None
        self.expected = self.windows_path(release / "worker.js")
        self.heartbeat_path = Path(self.linux_path(os.environ["FEDDIT_MAINTENANCE_DIR"])) / "feddit-status.json"
        snapshot = os.environ.get("FEDDIT_IDENTITY_SNAPSHOT")
        self.snapshot_path = Path(self.linux_path(snapshot)) if snapshot else None
        self.last_observation = None

    @staticmethod
    def windows_path(path):
        return subprocess.check_output(["wslpath", "-w", str(path)], text=True, timeout=5).strip()

    @staticmethod
    def linux_path(path):
        return subprocess.check_output(["wslpath", "-u", path], text=True, timeout=5).strip()

    def inventory(self):
        if self.snapshot_path is not None:
            return self.snapshot_inventory()
        script = RECORD_FUNCTION + "@{ processes = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { Record $_ }) } | ConvertTo-Json -Depth 4 -Compress"
        result = subprocess.run(ps_command(script), capture_output=True, text=True, timeout=15, check=True)
        return json.loads(result.stdout.lstrip("\ufeff"))["processes"]

    def snapshot_inventory(self, clock=time.time, monotonic=time.monotonic, sleep=time.sleep):
        # An old but not-yet-expired absence is insufficient for launch or
        # cleanup. Require a new scan that began after this inventory request.
        requested_at = clock()
        deadline = monotonic() + 10
        while monotonic() < deadline:
            try:
                snapshot = json.loads(self.snapshot_path.read_text(encoding="utf-8"))
                observed = timestamp(snapshot["observedAt"])
                completed = timestamp(snapshot["completedAt"])
                probe = (snapshot["probePid"], snapshot["probeStartedAt"])
                sequence = snapshot["sequence"]
                last = self.last_observation
                fresh = (snapshot.get("version") == 1 and type(sequence) is int and sequence > 0
                         and type(probe[0]) is int and probe[0] > 0
                         and timestamp(probe[1]) <= observed <= completed <= clock() + 2
                         and requested_at <= observed and 0 <= clock() - observed < 10
                         and (last is None or observed > last[2] and (probe != last[0] or sequence > last[1])))
                if fresh:
                    # Validate all identities before accepting the observation.
                    candidates(snapshot["processes"])
                    self.last_observation = (probe, sequence, observed)
                    self.last_snapshot_processes = snapshot["processes"]
                    return snapshot["processes"]
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                pass
            sleep(0.25)
        raise UnsafeState("IDENTITY_SNAPSHOT_UNVERIFIED")

    def heartbeat(self):
        try:
            return json.loads(self.heartbeat_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def readiness(self):
        try:
            probe = self.windows_path(self.release / "deploy/dell/readiness-probe.js")
            result = subprocess.run([NODE_WSL, probe], capture_output=True, text=True, timeout=25)
            data = json.loads(result.stdout.lstrip("\ufeff"))
            return result.returncode == 0 and data.get("ready") is True and data.get("version") == "0.34.1"
        except (OSError, ValueError, subprocess.SubprocessError):
            return False

    def verify_helper(self):
        if hashlib.sha256(STOP_HELPER.read_bytes()).hexdigest() != STOP_HELPER_SHA256:
            raise UnsafeState("STOP_HELPER_UNVERIFIED")

    def launch(self):
        self.verify_helper()
        guard = r"""
    if (@($nodes | Where-Object { -not $_.CommandLine -or $_.CommandLine -match '(?i)(^|[\\/\s"])worker\.js(?=["\s]|$)' }).Count -gt 0) { exit 78 }
"""
        if self.snapshot_path is not None:
            if self.last_observation is None or not 0 <= time.time() - self.last_observation[2] < 10:
                raise UnsafeState("IDENTITY_SNAPSHOT_UNVERIFIED")
            proof = base64.b64encode(json.dumps({"observedAt": self.last_observation[2],
                                                 "processes": self.last_snapshot_processes}).encode()).decode("ascii")
            guard = "\n$proof = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(" + ps_quote(proof) + ")))\n" + r"""
    $now = [datetimeoffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0
    if ($now - $proof.observedAt -lt 0 -or $now - $proof.observedAt -ge 10) { exit 78 }
    foreach ($node in $nodes) {
        $known = @($proof.processes | Where-Object { $_.pid -eq $node.ProcessId -and [datetimeoffset]::Parse([string]$_.startedAt).UtcDateTime -eq $node.CreationDate.ToUniversalTime() })
        if ($known.Count -ne 1 -or $known[0].commandLine -ne '[verified-other-node]') { exit 78 }
        if ($node.CommandLine -and $node.CommandLine -match '(?i)(^|[\\/\s"])worker\.js(?=["\s]|$)') { exit 78 }
    }
"""
        # Hold a Windows mutex across launch/exit as well as the WSL flock. The
        # child gets a separate hidden console; the guarded Ctrl+C helper will
        # refuse any console shared with another process.
        script = RECORD_FUNCTION + r"""
$mutex = New-Object System.Threading.Mutex($false, 'Local\FedditWorkerSupervisor-v1')
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) { exit 78 }
try {
    $nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")
""" + guard + "\n$p = Start-Process -FilePath " + ps_quote(NODE) + " -ArgumentList " + ps_quote('"' + self.expected + '"') + " -WorkingDirectory " + ps_quote(ntpath.dirname(self.expected)) + " -WindowStyle Hidden -PassThru\n" + r"""
    $native = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)"
    if (-not $native -or $p.HasExited -or [math]::Abs(($native.CreationDate.ToUniversalTime() - $p.StartTime.ToUniversalTime()).TotalMilliseconds) -ge 1) { exit 1 }
    Record $native | ConvertTo-Json -Compress
    [Console]::Out.Flush()
    $birth = $native.CreationDate
    do {
        Start-Sleep -Seconds 1
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)"
    } while ($current -and $current.CreationDate -eq $birth)
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
"""
        self.proxy = subprocess.Popen(ps_command(script), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        # A launch timeout is ambiguous, never evidence of an absent worker.
        if not select.select([self.proxy.stdout], [], [], 20)[0]:
            raise UnsafeState("LAUNCH_IDENTITY_UNCONFIRMED")
        line = self.proxy.stdout.readline(16384)
        return json.loads(line.decode("utf-8-sig"))

    def graceful_stop(self, identity):
        self.verify_helper()
        helper = self.windows_path(STOP_HELPER)
        script = "& " + ps_quote(helper) + " -TargetPid " + str(identity["pid"])
        script += " -ExpectedCommandLine " + ps_quote(identity["commandLine"])
        script += " -ExpectedCreatedAtUtc " + ps_quote(identity["startedAt"])
        script += " -Send -WaitExitSeconds " + str(STOP_SECONDS)
        self.stop_proxy = subprocess.Popen(ps_command(script), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def stop_failed(self):
        return self.stop_proxy is not None and self.stop_proxy.poll() not in (None, 0)

    def clean_proxy(self):
        # Called only after a successful fresh Windows inventory proves native
        # absence. Popen owns these exact WSL PIDs; never signal a Windows PID.
        for child in (self.proxy, self.stop_proxy):
            if child is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=2)

    def publish(self, status):
        publish_health(self.state, status)

    @staticmethod
    def notify(message):
        address = os.environ.get("NOTIFY_SOCKET")
        if address:
            with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as channel:
                channel.connect("\0" + address[1:] if address.startswith("@") else address)
                channel.sendall(message.encode("ascii"))


class Supervisor:
    def __init__(self, host, clock=time.time, sleep=time.sleep):
        self.host = host
        self.clock = clock
        self.sleep = sleep
        self.identity = None
        self.stopping = False
        self.ready_sent = False

    def health(self, state, ready=False, heartbeat=None, reason=None):
        self.host.publish(health_record(self.identity, state, self.clock(), ready, heartbeat, reason))

    def inspect(self):
        records = self.host.inventory()
        workers = candidates(records)
        if self.identity is None:
            if workers:
                raise UnsafeState("EXISTING_WORKER")
            return False
        if not workers:
            if any(record.get("pid") == self.identity["pid"] for record in records):
                raise UnsafeState("WORKER_OWNERSHIP_CHANGED")
            return False
        if len(workers) != 1 or not same_identity(workers[0], self.identity):
            raise UnsafeState("WORKER_OWNERSHIP_CHANGED")
        validate_identity(workers[0], self.host.expected)
        return True

    def run(self):
        try:
            self.health("starting")
            self.inspect()
            if self.stopping:
                return 0
            if not self.host.readiness():
                self.health("runtime_unready")
                return 1
            # Recheck after metadata calls, then launch under the Windows mutex.
            self.inspect()
            if self.stopping:
                return 0
            self.identity = validate_identity(self.host.launch(), self.host.expected)
            started = self.clock()
            stop_started = None
            exit_code = 0
            while True:
                if not self.inspect():
                    self.health("stopped" if stop_started else "native_missing")
                    self.host.clean_proxy()
                    return exit_code if stop_started else 1
                heartbeat = self.host.heartbeat()
                fresh = valid_heartbeat(heartbeat, self.identity, self.clock())
                if not fresh:
                    if not self.ready_sent and stop_started is None and self.clock() - started < START_SECONDS:
                        self.health("awaiting_heartbeat")
                        self.sleep(POLL_SECONDS)
                        continue
                    raise UnsafeState("HEARTBEAT_UNVERIFIED")
                if stop_started is None:
                    runtime_ready = self.host.readiness()
                    # The probe can take time: recheck the native identity and
                    # current heartbeat before asserting READY or sending Ctrl+C.
                    if not self.inspect():
                        self.health("native_missing")
                        self.host.clean_proxy()
                        return 1
                    heartbeat = self.host.heartbeat()
                    if not valid_heartbeat(heartbeat, self.identity, self.clock()):
                        raise UnsafeState("HEARTBEAT_UNVERIFIED")
                    if self.stopping or not runtime_ready:
                        exit_code = 0 if self.stopping else 1
                        self.health("stopping", heartbeat=heartbeat)
                        self.host.notify("STOPPING=1\nSTATUS=Waiting for guarded Windows worker exit")
                        self.host.graceful_stop(self.identity)
                        stop_started = self.clock()
                    else:
                        self.health("ready", ready=True, heartbeat=heartbeat)
                        if not self.ready_sent:
                            self.host.notify("READY=1\nSTATUS=Windows worker identity, heartbeat and runtime verified")
                            self.ready_sent = True
                else:
                    self.health("stopping", heartbeat=heartbeat)
                    if self.host.stop_failed() or self.clock() - stop_started >= STOP_SECONDS:
                        raise UnsafeState("GRACEFUL_STOP_UNCONFIRMED")
                self.sleep(POLL_SECONDS)
        except Exception as error:
            # Ownership or host visibility may be uncertain. Leave every native
            # process and its proxy intact and prohibit automatic replacement.
            self.health("quarantined", reason=safe_reason(error))
            self.host.notify("STATUS=Quarantined: worker ownership or runtime inspection unverified")
            return QUARANTINE


def main():
    import fcntl
    os.umask(0o077)
    root = Path.home() / ".local/lib/feddit-bot"
    state = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "feddit-worker"
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / "supervisor.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return QUARANTINE
        publish_health(state, health_record(None, "starting", time.time()))
        try:
            release = (root / "current").resolve(strict=True)
            if release.parent != root / "releases" or not (release / "worker.js").is_file():
                raise UnsafeState("WORKER_IDENTITY_MISMATCH")
            host = Host(release, state)
            supervisor = Supervisor(host)
            def stop(_signal, _frame):
                supervisor.stopping = True
            signal.signal(signal.SIGTERM, stop)
            signal.signal(signal.SIGINT, stop)
            return supervisor.run()
        except Exception as error:
            publish_health(state, health_record(None, "quarantined", time.time(), reason=safe_reason(error)))
            return QUARANTINE


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Do not log subprocess input, command lines, environment or exceptions.
        print("Worker supervisor startup is unverified; quarantined.", file=sys.stderr)
        sys.exit(QUARANTINE)
