#!/usr/bin/env python3
"""Fault injection only: no Windows processes, services or inference touched."""

import copy
import base64
import datetime
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import shutil
import time
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("supervised_worker", ROOT / "deploy/dell/supervised-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def iso(value):
    return datetime.datetime.fromtimestamp(value, datetime.timezone.utc).isoformat()


class FakeHost:
    def __init__(self):
        self.now = 1800000000
        self.expected = r"\\wsl.localhost\Ubuntu\home\user\releases\release-a\worker.js"
        self.record = {"pid": 1234, "startedAt": iso(self.now - 2), "executable": worker.NODE,
                       "commandLine": '"' + worker.NODE + '" "' + self.expected + '"'}
        self.workers = []
        self.launches = 0
        self.stops = 0
        self.cleaned = 0
        self.notices = []
        self.health = []
        self.ready = True
        self.stop_error = False
        self.heartbeat_state = "running"
        self.active = 0
        self.beat = None
        self.on_sleep = lambda: self.workers.clear()
        self.on_probe = lambda: None
        self.inventory_error = False
        self.launch_error = False
        self.readiness_calls = 0

    def inventory(self):
        if self.inventory_error:
            raise OSError("private host error must not leak")
        return copy.deepcopy(self.workers)

    def heartbeat(self):
        if self.beat is not None:
            return self.beat
        return {"version": 1, "pid": 1234, "updatedAt": iso(self.now),
                "state": self.heartbeat_state, "active": self.active, "requestId": "private-window"}

    def readiness(self):
        self.readiness_calls += 1
        self.on_probe()
        return self.ready

    def launch(self):
        self.launches += 1
        self.workers = [copy.deepcopy(self.record)]
        if self.launch_error:
            raise worker.UnsafeState("launch acknowledgement missing")
        return copy.deepcopy(self.record)

    def graceful_stop(self, identity):
        assert worker.same_identity(identity, self.record)
        self.stops += 1

    def stop_failed(self):
        return self.stop_error

    def clean_proxy(self):
        assert not self.workers, "never clean a proxy while a native worker might exist"
        self.cleaned += 1

    def publish(self, status):
        self.health.append(status)

    def notify(self, message):
        self.notices.append(message)

    def sleep(self, seconds):
        self.now += seconds
        self.on_sleep()
        assert self.now < 1800003000, "test did not terminate"


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.host = FakeHost()
        self.supervisor = worker.Supervisor(self.host, clock=lambda: self.host.now, sleep=self.host.sleep)

    def run_supervisor(self):
        return self.supervisor.run()

    def assert_quarantined(self):
        self.assertEqual(self.run_supervisor(), 78)
        self.assertEqual(self.host.health[-1]["state"], "quarantined")
        self.assertFalse(self.host.health[-1]["ready"])
        self.assertEqual(self.host.cleaned, 0)

    def test_native_missing_while_wrapper_alive_restarts(self):
        self.assertEqual(self.run_supervisor(), 1)
        self.assertEqual(self.host.launches, 1)
        self.assertEqual(self.host.cleaned, 1)
        self.assertEqual(self.host.stops, 0)
        self.assertEqual(sum(message.startswith("READY=1") for message in self.host.notices), 1)

    def test_child_missing_before_first_ready(self):
        original_launch = self.host.launch
        def launch():
            record = original_launch()
            self.host.workers.clear()
            return record
        self.host.launch = launch
        self.assertEqual(self.run_supervisor(), 1)
        self.assertEqual(self.host.cleaned, 1)
        self.assertEqual(self.host.notices, [])

    def test_stale_heartbeat_never_ready_or_killed(self):
        self.host.beat = self.host.heartbeat()
        self.host.beat["updatedAt"] = iso(self.host.now - 60)
        self.host.on_sleep = lambda: None
        self.assert_quarantined()
        self.assertFalse(any(message.startswith("READY=1") for message in self.host.notices))
        self.assertEqual(self.host.stops, 0)

    def test_heartbeat_for_other_pid_never_ready(self):
        self.host.beat = self.host.heartbeat()
        self.host.beat["pid"] = 9999
        self.host.on_sleep = lambda: None
        self.assert_quarantined()
        self.assertEqual(self.host.stops, 0)

    def test_heartbeat_predating_process_birth_is_rejected(self):
        status = self.host.heartbeat()
        status["updatedAt"] = iso(self.host.now - 3)
        self.assertFalse(worker.valid_heartbeat(status, self.host.record, self.host.now))

    def test_reused_pid_is_quarantined(self):
        self.host.on_sleep = lambda: self.host.workers[0].update(startedAt=iso(self.host.now))
        self.assert_quarantined()
        self.assertEqual(self.host.stops, 0)

    def test_owned_pid_with_changed_command_is_not_mistaken_for_absence(self):
        self.host.on_sleep = lambda: self.host.workers[0].update(commandLine='node.exe other.js')
        self.assert_quarantined()
        self.assertEqual(self.host.stops, 0)

    def test_prior_release_prevents_duplicate_launch(self):
        old = copy.deepcopy(self.host.record)
        old["commandLine"] = old["commandLine"].replace("release-a", "release-old")
        self.host.workers = [old]
        self.assert_quarantined()
        self.assertEqual(self.host.launches, 0)
        self.assertEqual(self.host.readiness_calls, 0)

    def test_existing_same_release_is_not_adopted(self):
        self.host.workers = [self.host.record]
        self.assert_quarantined()
        self.assertEqual(self.host.launches, 0)

    def test_ambiguous_node_identity_blocks_launch(self):
        self.host.workers = [{"pid": 2222, "commandLine": None}]
        self.assert_quarantined()
        self.assertEqual(self.host.launches, 0)

    def test_mismatched_launched_release_is_quarantined(self):
        self.host.record["commandLine"] = self.host.record["commandLine"].replace("release-a", "release-other")
        self.assert_quarantined()
        self.assertEqual(self.host.stops, 0)

    def test_unverified_runtime_never_launches(self):
        self.host.ready = False
        self.assertEqual(self.run_supervisor(), 1)
        self.assertEqual(self.host.launches, 0)
        self.assertEqual(self.host.notices, [])

    def test_host_unreachable_quarantines_without_launch(self):
        self.host.inventory_error = True
        self.assert_quarantined()
        self.assertEqual(self.host.launches, 0)

    def test_launch_acknowledgement_failure_prevents_retry_or_kill(self):
        self.host.launch_error = True
        self.assert_quarantined()
        self.assertEqual(self.host.launches, 1)
        self.assertEqual(self.host.stops, 0)

    def test_healthy_busy_and_maintenance_states_remain_ready(self):
        for state, active in (("running", 1), ("draining", 1), ("held", 0)):
            with self.subTest(state=state):
                self.setUp()
                self.host.heartbeat_state = state
                self.host.active = active
                self.assertEqual(self.run_supervisor(), 1)
                self.assertTrue(any(item["ready"] for item in self.host.health))
                self.assertEqual(self.host.stops, 0)

    def test_provider_drift_uses_guarded_stop_and_waits_for_native_exit(self):
        def change():
            if self.host.stops:
                self.host.workers.clear()
            else:
                self.host.ready = False
        self.host.on_sleep = change
        self.assertEqual(self.run_supervisor(), 1)
        self.assertEqual(self.host.stops, 1)
        self.assertEqual(self.host.cleaned, 1)
        self.assertTrue(any(message.startswith("STOPPING=1") for message in self.host.notices))

    def test_explicit_stop_allows_busy_job_to_finish(self):
        self.host.active = 1
        sleeps = 0
        def drain():
            nonlocal sleeps
            sleeps += 1
            self.supervisor.stopping = True
            if sleeps >= 4:
                self.host.workers.clear()
        self.host.on_sleep = drain
        self.assertEqual(self.run_supervisor(), 0)
        self.assertEqual(self.host.stops, 1)
        self.assertEqual(self.host.cleaned, 1)
        self.assertGreaterEqual(sum(item["state"] == "stopping" for item in self.host.health), 2)

    def test_failed_guarded_stop_never_kills_worker(self):
        def stop():
            self.supervisor.stopping = True
            self.host.stop_error = True
        self.host.on_sleep = stop
        self.assert_quarantined()
        self.assertEqual(self.host.stops, 1)

    def test_duplicate_appearing_during_probe_never_becomes_ready(self):
        def duplicate():
            if self.host.launches:
                self.host.workers.append({**self.host.record, "pid": 5678})
        self.host.on_probe = duplicate
        self.assert_quarantined()
        self.assertFalse(any(message.startswith("READY=1") for message in self.host.notices))

    def test_host_visibility_lost_after_ready_never_kills_or_duplicates(self):
        self.host.on_sleep = lambda: setattr(self.host, "inventory_error", True)
        self.assert_quarantined()
        self.assertEqual(self.host.stops, 0)
        self.assertEqual(self.host.launches, 1)

    def test_health_contains_only_operational_fields(self):
        self.run_supervisor()
        for item in self.host.health:
            self.assertEqual(set(item), {"version", "supervisorPid", "pid", "startedAt", "state", "ready",
                                         "updatedAt", "maintenance", "active", "reason"})
        rendered = json.dumps(self.host.health)
        self.assertNotIn("private-", rendered)
        self.assertNotIn("commandLine", rendered)
        self.assertNotIn("release-a", rendered)

    def test_failure_reason_is_specific_and_whitelisted(self):
        self.host.workers = [self.host.record]
        self.assert_quarantined()
        self.assertEqual(self.host.health[-1]["reason"], "EXISTING_WORKER")
        self.assertEqual(worker.safe_reason(OSError("private credential")), "CHECK_FAILED")
        self.assertEqual(worker.safe_reason(worker.UnsafeState("private credential")), "CHECK_FAILED")

    def test_probe_timeout_becomes_unready(self):
        host = object.__new__(worker.Host)
        host.release = ROOT
        with patch.object(worker.Host, "windows_path", return_value="probe.js"), \
                patch.object(worker.subprocess, "run", side_effect=subprocess.TimeoutExpired("node", 25)):
            self.assertFalse(host.readiness())

    @unittest.skipUnless(shutil.which("powershell.exe"), "Windows PowerShell parser is unavailable")
    def test_native_scripts_parse_without_execution(self):
        host = object.__new__(worker.Host)
        host.expected = self.host.expected
        host.snapshot_path = None
        native = copy.deepcopy(self.host.record)
        commands = []
        class Proxy:
            def __init__(self):
                self.stdout = io.BytesIO((json.dumps(native) + "\n").encode())
        def capture(command, **_options):
            commands.append(base64.b64decode(command[-1]).decode("utf-16le"))
            return Proxy()
        with patch.object(host, "verify_helper"), patch.object(worker.subprocess, "Popen", side_effect=capture), \
                patch.object(worker.select, "select", return_value=([True], [], [])), \
                patch.object(host, "windows_path", return_value=r"C:\dev\helper.ps1"):
            self.assertEqual(host.launch(), native)
            host.graceful_stop(native)
            host.snapshot_path = Path("snapshot.json")
            host.last_observation = ((12, "2026-01-01T00:00:00Z"), 1, time.time())
            host.last_snapshot_processes = []
            self.assertEqual(host.launch(), native)
        def inventory(command, **_options):
            commands.append(base64.b64decode(command[-1]).decode("utf-16le"))
            return subprocess.CompletedProcess(command, 0, stdout='{"processes":[]}')
        with patch.object(worker.subprocess, "run", side_effect=inventory):
            host.snapshot_path = None
            self.assertEqual(host.inventory(), [])
        commands.append((ROOT / "deploy/dell/identity-probe.ps1").read_text())
        parser = r"""
$ErrorActionPreference='Stop'
$scripts = ConvertFrom-Json ([Console]::In.ReadToEnd())
foreach ($script in $scripts) {
    $tokens=$null; $errors=$null
    $null = [System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { $errors | ForEach-Object { $_.Message }; exit 1 }
}
$utc = [datetimeoffset]::Parse('2026-10-15T18:00:00Z').UtcDateTime
$offset = [datetimeoffset]::Parse('2026-10-15T19:00:00+01:00').UtcDateTime
if ($utc -ne $offset) { throw 'UTC birth comparison is not timezone-independent' }
$unix = [datetimeoffset]::Parse('1970-01-01T01:00:00+01:00').ToUnixTimeMilliseconds() / 1000.0
if ($unix -ne 0) { throw 'Epoch calculation is not timezone-independent' }
$now = [datetimeoffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0
$roundTrip = [datetimeoffset]::Parse([datetime]::UtcNow.ToString('o')).ToUnixTimeMilliseconds() / 1000.0
if ([math]::Abs($now - $roundTrip) -gt 1) { throw 'UTC epoch and formatted UTC disagree' }
Write-Output '5 native scripts parsed without execution'
"""
        result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand",
                                 base64.b64encode(parser.encode("utf-16le")).decode("ascii")],
                                input=json.dumps(commands), capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("5 native scripts parsed", result.stdout)

    @unittest.skipUnless(shutil.which("powershell.exe"), "Windows PowerShell is unavailable")
    def test_native_snapshot_replaces_repeatedly_on_windows_powershell(self):
        replacement = next(line.strip() for line in (ROOT / "deploy/dell/identity-probe.ps1").read_text().splitlines()
                           if line.strip().startswith("[System.IO.File]::Replace("))
        fixture_root = ROOT / "artifacts" / "reliability"
        fixture_root.mkdir(parents=True, exist_ok=True)
        script = "$ErrorActionPreference='Stop'; $directory=Join-Path " + worker.ps_quote(str(fixture_root)) + " ('native-replace-'+[guid]::NewGuid()); "
        script += r"""
New-Item -ItemType Directory -Path $directory | Out-Null
$temporaryPath=Join-Path $directory 'new.json'
$snapshotPath=Join-Path $directory 'identity.json'
try {
    [IO.File]::WriteAllText($snapshotPath,'0')
    foreach($sequence in @(1,2,3)) {
        [IO.File]::WriteAllText($temporaryPath,[string]$sequence)
""" + replacement + r"""
        if([IO.File]::ReadAllText($snapshotPath) -cne [string]$sequence){throw 'Atomic snapshot did not advance'}
    }
    'native-atomic-replace-passed'
} finally {
    if(Test-Path -LiteralPath $temporaryPath){Remove-Item -LiteralPath $temporaryPath}
    if(Test-Path -LiteralPath $snapshotPath){Remove-Item -LiteralPath $snapshotPath}
    Remove-Item -LiteralPath $directory
}
"""
        result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand",
                                 base64.b64encode(script.encode("utf-16le")).decode("ascii")],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("native-atomic-replace-passed", result.stdout)

    def snapshot_fixture(self, transform=lambda value: value):
        host = object.__new__(worker.Host)
        host.last_observation = None
        elapsed = [0.0]
        baseline = self.host.now
        def now():
            return baseline + elapsed[0]
        def sleep(seconds):
            elapsed[0] += seconds
        class Snapshot:
            def read_text(_self, **_options):
                value = {"version": 1, "probePid": 789, "probeStartedAt": iso(baseline - 60), "sequence": 3,
                         "observedAt": iso(now()), "completedAt": iso(now()), "processes": []}
                return json.dumps(transform(value))
        host.snapshot_path = Snapshot()
        def read():
            return host.snapshot_inventory(clock=now, monotonic=lambda: elapsed[0], sleep=sleep)
        return host, read, now

    def test_elevated_snapshot_requires_scan_newer_than_request(self):
        _, read, _ = self.snapshot_fixture(lambda value: {**value, "observedAt": iso(self.host.now - 1)})
        with self.assertRaisesRegex(worker.UnsafeState, "IDENTITY_SNAPSHOT_UNVERIFIED"):
            read()

    def test_elevated_snapshot_stale_or_unreadable_is_quarantined(self):
        for transform in (lambda value: {**value, "observedAt": iso(self.host.now - 30)}, lambda _value: {}):
            with self.subTest(transform=transform):
                _, read, _ = self.snapshot_fixture(transform)
                with self.assertRaisesRegex(worker.UnsafeState, "IDENTITY_SNAPSHOT_UNVERIFIED"):
                    read()

    def test_elevated_snapshot_sequence_cannot_replay(self):
        host, read, now = self.snapshot_fixture()
        self.assertEqual(read(), [])
        self.assertEqual(host.last_observation[1], 3)
        with self.assertRaisesRegex(worker.UnsafeState, "IDENTITY_SNAPSHOT_UNVERIFIED"):
            read()
        self.assertGreater(now(), self.host.now)

    def test_elevated_snapshot_retains_unknown_identity_barrier(self):
        _, read, _ = self.snapshot_fixture(lambda value: {**value, "processes": [{"pid": 123, "commandLine": None}]})
        with self.assertRaisesRegex(worker.UnsafeState, "PROCESS_IDENTITY_UNREADABLE"):
            read()

    def test_elevated_snapshot_accepts_fresh_native_identity(self):
        _, read, _ = self.snapshot_fixture(lambda value: {**value, "processes": [self.host.record]})
        self.assertEqual(read(), [self.host.record])

    def test_unit_keeps_quarantine_and_non_destructive_stop(self):
        unit = (ROOT / "deploy/dell/feddit-worker.service").read_text()
        for setting in ("Type=notify", "NotifyAccess=main", "RestartPreventExitStatus=78", "KillMode=process",
                        "SendSIGKILL=no", "TimeoutStopSec=35min", "FEDDIT_MAINTENANCE_DIR"):
            self.assertIn(setting, unit)

    def test_probe_metadata_contract_and_failure_modes(self):
        script = r"""
const assert = require('node:assert/strict');
const tokenizer = require('./lib/hosted-tokenizer');
const original = tokenizer.verifyModel;
let verified = 0;
tokenizer.verifyModel = (show, tags) => { assert.equal(show.marker, 'show'); assert.equal(tags.marker, 'tags'); verified++; };
const { verifyReadiness } = require('./deploy/dell/readiness-probe');
const env = { SHARED_OLLAMA_ARBITER_URL: 'http://127.0.0.1:11435' };
const calls = [];
let version = '0.34.1', arbiter = true, fail = false;
async function fake(url, options) {
  calls.push([url, options.method]);
  if (fail) throw new Error('private network error');
  if (url.endsWith('/api/version')) return { ok: true, json: async () => ({ version }) };
  if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ marker: 'tags' }) };
  if (url.endsWith('/api/show')) {
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { model: tokenizer.MODEL });
    return { ok: true, json: async () => ({ marker: 'show' }) };
  }
  assert.ok(url.endsWith('/health'));
  return { ok: true, json: async () => ({ ok: arbiter, active: 'busy', profile: { num_ctx: 3072, num_thread: 4 } }) };
}
(async () => {
  assert.deepEqual(await verifyReadiness(fake, env), { ready: true, version: '0.34.1' });
  assert.equal(verified, 1);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(([url]) => !/generate|chat|acquire|pull/.test(url)));
  version = '0.40.0'; calls.length = 0;
  assert.equal((await verifyReadiness(fake, env)).reason, 'OLLAMA_VERSION_MISMATCH');
  assert.equal(calls.length, 1);
  version = '0.34.1'; arbiter = false;
  assert.equal((await verifyReadiness(fake, env)).reason, 'ARBITER_UNVERIFIED');
  arbiter = true; tokenizer.verifyModel = original;
  assert.equal((await verifyReadiness(fake, env)).reason, 'TOKENIZER_UNVERIFIED');
  fail = true;
  assert.equal((await verifyReadiness(fake, env)).reason, 'METADATA_UNAVAILABLE');
  calls.length = 0;
  for (const overrides of [{ OLLAMA_BASE: 'http://127.0.0.1:9999' }, { SHARED_OLLAMA_ARBITER_URL: '' },
                           { SHARED_OLLAMA_ARBITER_URL: 'http://127.0.0.1:9999' }, { FEDDIT_WORKER_MODELS: 'another-model' }]) {
    assert.equal((await verifyReadiness(fake, { ...env, ...overrides })).reason, 'PROVIDER_CONFIGURATION_UNVERIFIED');
  }
  assert.equal(calls.length, 0);
  console.log('readiness-probe: metadata-only contract and 9 readiness outcomes passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("9 readiness outcomes passed", result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
