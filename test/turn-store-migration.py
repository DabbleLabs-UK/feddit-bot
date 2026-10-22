import contextlib
import importlib.util
import io
import json
import pathlib
import shutil
import sys
import tempfile
import unittest
import hashlib
import subprocess
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('migration', pathlib.Path(__file__).parents[1] / 'bin/migrate-durable-turns.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='feddit-migration-')
        self.base = pathlib.Path(self.temp.name)
        self.source = self.base / 'turns.json'
        self.backup = self.base / 'verified-backup.json'
        self.stage = self.base / 'staged'
        self.turns = [
            {'id': 't_active', 'profileId': 'p_a', 'status': 'created', 'input': {'firstContactVersion': 2},
             'profile': {'persona': 'Unicode \u00e9, escaped " } ] \\ text ' * 12000},
             'once': {'effect': 123}, 'publication': {'state': 'attempting'},
             'generations': [{'jobId': 'j_one', 'attemptFence': 'frozen-fixture', 'request': {'prompt': 'unchanged'}}]},
            {'id': 't_uncertain', 'profileId': 'p_b', 'status': 'publication-uncertain',
             'publication': {'state': 'uncertain'}, 'checkpoints': {'vote-effect-post:2': {'state': 'attempting'}}},
            {'id': 't_old', 'profileId': 'p_c', 'status': 'completed', 'finishedAt': 1,
             'publication': {'state': 'response-received', 'response': {'ok': True, 'status': 201}},
             'checkpoints': {'vote-effect-post:2': {'state': 'response-received'}}},
        ]
        self.write_source()

    def tearDown(self):
        self.temp.cleanup()

    def write_source(self):
        self.source.write_text(json.dumps({'version': 1, 'turns': self.turns, 'extra': {'preserved': True}}, ensure_ascii=False), encoding='utf-8')
        shutil.copyfile(self.source, self.backup)

    def call(self, operation, stage=None):
        args = ['migrate', operation, '--source', str(self.source)]
        if operation != 'inspect':
            args += ['--staged', str(stage or self.stage)]
        if operation == 'activate':
            args += ['--backup', str(self.backup)]
        with patch.object(sys, 'argv', args), contextlib.redirect_stdout(io.StringIO()) as output:
            migration.main()
        return json.loads(output.getvalue())

    def test_lossless_restart_and_incompatible_rollback_fence(self):
        before = self.call('inspect')
        prepared = self.call('prepare')
        self.assertEqual(before, prepared)
        self.assertEqual(prepared['count'], 3)
        self.assertEqual(self.call('verify'), prepared)
        self.call('activate')
        self.assertTrue(self.source.read_text().startswith(migration.PREFIX))
        with self.assertRaises(json.JSONDecodeError):
            json.loads(self.source.read_text())
        final = pathlib.Path(str(self.source) + '.d')
        for turn in self.turns:
            self.assertEqual(json.loads(migration.location(final, turn).read_text()), turn)
        manifest = json.loads((final / 'migration.json').read_text())
        self.assertEqual(manifest['legacyEnvelope']['extra'], {'preserved': True})
        verifier = pathlib.Path(__file__).parents[1] / 'bin/verify-durable-turns.js'
        checked = subprocess.run(['node', str(verifier), str(self.source)], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(checked.stdout)['count'], 3)
        self.assertEqual(len(json.loads(checked.stdout)['active']), 1)
        with self.assertRaisesRegex(ValueError, 'changed|already migrated'):
            self.call('activate', final)

    def test_modified_source_and_wrong_backup_cannot_be_activated(self):
        self.call('prepare')
        self.source.write_text(self.source.read_text(encoding='utf-8') + ' ', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Source changed'):
            self.call('activate')
        shutil.copyfile(self.backup, self.source)
        self.backup.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'backup'):
            self.call('activate')

    def test_corrupt_staged_record_fails_before_authority_switch(self):
        self.call('prepare')
        migration.location(self.stage, self.turns[0]).write_text('{}')
        with self.assertRaises(ValueError):
            self.call('activate')
        self.assertEqual(migration.digest(self.source), migration.digest(self.backup))

    def test_duplicate_ids_or_keys_or_bad_envelope_rejected(self):
        for value in [json.dumps({'version': 1, 'turns': [self.turns[1], self.turns[1]]}),
                      '{"version":1,"turns":[],"turns":[]}',
                      '{"version":1,"turns":[{"id":"t_a","id":"t_b"}]}',
                      '{"version":1,"turns":[],}',
                      '{"version":1,"turns":[]} trailing',
                      '{"version":99,"turns":[]}', '{"version":1}']:
            with self.subTest(value=value[:80]):
                self.source.write_text(value)
                with self.assertRaises(ValueError):
                    self.call('inspect')

    def test_interrupted_activation_is_explicitly_recoverable(self):
        self.call('prepare')
        with patch.object(migration.os, 'replace', side_effect=OSError('fixture crash before marker commit')):
            with self.assertRaises(OSError):
                self.call('activate')
        final = pathlib.Path(str(self.source) + '.d')
        self.assertTrue(final.exists())
        self.assertEqual(migration.digest(self.source), migration.digest(self.backup))
        # The uncommitted temporary marker is not authority. Preserve it as crash evidence.
        pathlib.Path(str(self.source) + '.migration-tmp').rename(self.base / 'interrupted-marker')
        self.call('activate', final)
        self.assertTrue(self.source.read_text().startswith(migration.PREFIX))

    def test_frozen_request_property_order_and_javascript_signature_survive(self):
        request = {'prompt': 'fixture', 'temperature': 0.5, 'decisionBudget': {'version': 2, 'inputTokens': 2000, 'contextTokens': 3072, 'outputTokens': 640, 'safetyTokens': 64}}
        self.turns[0]['generations'][0]['request'] = request
        signature = hashlib.sha256(migration.ordered(request)).hexdigest()
        self.turns[0]['generations'][0]['signature'] = signature
        self.write_source()
        self.call('prepare')
        file = migration.location(self.stage, self.turns[0])
        migrated = json.loads(file.read_text())
        self.assertEqual(list(migrated['generations'][0]['request']), list(request))
        self.assertEqual(list(migrated['generations'][0]['request']['decisionBudget']), list(request['decisionBudget']))
        result = subprocess.run(['node', '-e', "const fs=require('fs'),crypto=require('crypto');const t=JSON.parse(fs.readFileSync(process.argv[1]));process.stdout.write(crypto.createHash('sha256').update(JSON.stringify(t.generations[0].request)).digest('hex'));", str(file)], capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, signature)


if __name__ == '__main__':
    unittest.main()
