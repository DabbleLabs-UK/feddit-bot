#!/usr/bin/env python3
"""Offline, streaming, lossless v1 -> v2 durable-turn migration. No network calls."""
import argparse
import collections
import hashlib
import json
import os
import pathlib
import re
import sys

PREFIX = 'FEDDIT_TURN_STORE_V2\n'
ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')
MAX_RECORD = 64 * 1024 * 1024


def digest(file):
    h = hashlib.sha256()
    with pathlib.Path(file).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def ordered(value):
    # Nested key order participates in existing JSON.stringify request signatures.
    # Canonical sorting is for comparison only, never the durable payload.
    return json.dumps(value, ensure_ascii=True, sort_keys=False, separators=(',', ':'), allow_nan=False).encode()


class Reader:
    def __init__(self, file):
        self.handle = pathlib.Path(file).open(encoding='utf-8')
        self.buffer = ''
        self.eof = False
        self.decoder = json.JSONDecoder(object_pairs_hook=self.unique_object,
                                       parse_constant=self.invalid_constant)

    @staticmethod
    def invalid_constant(value):
        raise ValueError('Non-finite JSON value')

    @staticmethod
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate JSON property')
            result[key] = value
        return result

    def more(self):
        chunk = self.handle.read(65536)
        self.eof = not bool(chunk)
        self.buffer += chunk
        if len(self.buffer) > MAX_RECORD:
            raise ValueError('Individual legacy record exceeds migration safety bound')

    def peek(self):
        self.buffer = self.buffer.lstrip()
        while not self.buffer and not self.eof:
            self.more()
            self.buffer = self.buffer.lstrip()
        return self.buffer[:1]

    def expect(self, char):
        if self.peek() != char:
            raise ValueError('Malformed legacy envelope or array')
        self.buffer = self.buffer[1:]

    def value(self):
        self.peek()
        while True:
            try:
                value, end = self.decoder.raw_decode(self.buffer)
                # A primitive number could continue in the next chunk.
                if end == len(self.buffer) and not self.eof:
                    self.more()
                    continue
                self.buffer = self.buffer[end:]
                return value
            except json.JSONDecodeError:
                if self.eof:
                    raise ValueError('Incomplete or invalid legacy JSON') from None
                self.more()


def stream(file, envelope):
    reader = Reader(file)
    seen = set()
    try:
        reader.expect('{')
        while reader.peek() != '}':
            key = reader.value()
            if not isinstance(key, str) or key in seen:
                raise ValueError('Duplicate or invalid legacy envelope key')
            seen.add(key)
            reader.expect(':')
            if key == 'turns':
                reader.expect('[')
                if reader.peek() != ']':
                    while True:
                        yield reader.value()
                        if reader.peek() == ']':
                            break
                        reader.expect(',')
                reader.expect(']')
            else:
                envelope[key] = reader.value()
            if reader.peek() == '}':
                break
            reader.expect(',')
            if reader.peek() == '}':
                raise ValueError('Trailing legacy envelope comma')
        reader.expect('}')
        if reader.peek() or 'turns' not in seen or type(envelope.get('version')) is not int or envelope['version'] != 1:
            raise ValueError('Unsupported or trailing legacy envelope')
    finally:
        reader.handle.close()


def validate(turn):
    if not isinstance(turn, dict) or not isinstance(turn.get('id'), str) or not ID.fullmatch(turn['id']):
        raise ValueError('Invalid durable turn ID')
    if not isinstance(turn.get('profileId'), str) or not turn['profileId']:
        raise ValueError('Invalid durable turn profile')
    if not isinstance(turn.get('status'), str) or not turn['status']:
        raise ValueError('Invalid durable turn status')


def location(directory, turn):
    if turn['status'] in ('completed', 'failed'):
        shard = hashlib.sha256(turn['id'].encode()).hexdigest()[:2]
        return directory / 'history' / shard / (turn['id'] + '.json')
    return directory / 'live' / (turn['id'] + '.json')


def flush_dir(directory):
    if os.name == 'nt':
        return
    fd = os.open(str(directory), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_new(file, data):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with file.open('xb') as handle:
        os.chmod(file, 0o600)
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    flush_dir(file.parent)


def inspect(source, destination=None):
    before = digest(source)
    envelope = {}
    records = {}
    statuses = collections.Counter()
    publications = collections.Counter()
    vote_effects = collections.Counter()
    contracts = collections.Counter()
    max_bytes = 0
    for turn in stream(source, envelope):
        validate(turn)
        if turn['id'] in records:
            raise ValueError('Duplicate durable turn ID')
        data = ordered(turn)
        records[turn['id']] = {'sha256': hashlib.sha256(canonical(turn)).hexdigest(),
                               'orderedSha256': hashlib.sha256(data).hexdigest(),
                               'status': turn['status'], 'bytes': len(data)}
        max_bytes = max(max_bytes, len(data))
        statuses[turn['status']] += 1
        publications[(turn.get('publication') or {}).get('state', 'none')] += 1
        contracts[str((turn.get('input') or {}).get('firstContactVersion', 0))] += 1
        for key, value in (turn.get('checkpoints') or {}).items():
            if key.startswith('vote-effect-') and isinstance(value, dict):
                vote_effects[value.get('state', 'unknown')] += 1
        if destination:
            write_new(location(destination, turn), data + b'\n')
    if digest(source) != before:
        raise ValueError('Source changed during inspection; no activation allowed')
    return {'format': 'per-record', 'version': 2, 'sourceSha256': before,
            'sourceBytes': pathlib.Path(source).stat().st_size, 'legacyEnvelope': envelope,
            'count': len(records), 'statuses': dict(statuses),
            'publicationStates': dict(publications), 'voteEffectStates': dict(vote_effects),
            'firstContactVersions': dict(contracts), 'maxRecordBytes': max_bytes,
            'recordCatalogueSha256': hashlib.sha256(canonical(records)).hexdigest(),
            'records': records}


def verify(directory, manifest):
    actual = {}
    for file in directory.glob('live/*.json'):
        turn = json.loads(file.read_text(encoding='utf-8'))
        validate(turn)
        if location(directory, turn) != file:
            raise ValueError('Unexpected record location in staged migration')
        actual[turn['id']] = {'sha256': hashlib.sha256(canonical(turn)).hexdigest(),
                              'orderedSha256': hashlib.sha256(ordered(turn)).hexdigest(),
                              'status': turn['status'], 'bytes': len(ordered(turn))}
    for file in directory.glob('history/*/*.json'):
        turn = json.loads(file.read_text(encoding='utf-8'))
        validate(turn)
        if turn['id'] in actual or location(directory, turn) != file:
            raise ValueError('Duplicate or misplaced staged record')
        actual[turn['id']] = {'sha256': hashlib.sha256(canonical(turn)).hexdigest(),
                              'orderedSha256': hashlib.sha256(ordered(turn)).hexdigest(),
                              'status': turn['status'], 'bytes': len(ordered(turn))}
    if actual != manifest['records']:
        raise ValueError('Migration record/content verification failed')
    return True


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument('operation', choices=['inspect', 'prepare', 'verify', 'activate'])
    args.add_argument('--source', required=True, type=pathlib.Path)
    args.add_argument('--staged', type=pathlib.Path)
    args.add_argument('--backup', type=pathlib.Path)
    options = args.parse_args()
    source = options.source.resolve()
    if options.operation == 'inspect':
        manifest = inspect(source)
    elif options.operation == 'prepare':
        if not options.staged:
            raise ValueError('--staged required')
        directory = options.staged.resolve()
        directory.mkdir(mode=0o700, parents=False, exist_ok=False)
        (directory / 'live').mkdir(mode=0o700)
        (directory / 'history').mkdir(mode=0o700)
        manifest = inspect(source, directory)
        write_new(directory / 'migration.json', canonical(manifest) + b'\n')
        verify(directory, manifest)
        flush_dir(directory / 'live')
        flush_dir(directory / 'history')
        flush_dir(directory)
    else:
        if not options.staged:
            raise ValueError('--staged required')
        directory = options.staged.resolve()
        manifest = json.loads((directory / 'migration.json').read_text())
        verify(directory, manifest)
        if options.operation == 'activate':
            if not options.backup or digest(options.backup) != manifest['sourceSha256']:
                raise ValueError('Verified exact legacy backup required')
            if digest(source) != manifest['sourceSha256']:
                raise ValueError('Source changed or already migrated; refuse overwrite')
            final = pathlib.Path(str(source) + '.d')
            if directory != final:
                if final.exists():
                    raise ValueError('Destination exists; inspect interrupted migration explicitly')
                os.rename(directory, final)
                flush_dir(final.parent)
            marker = {'version': 2, 'format': 'per-record', 'directory': final.name}
            temp = pathlib.Path(str(source) + '.migration-tmp')
            write_new(temp, (PREFIX + json.dumps(marker) + '\n').encode())
            os.replace(temp, source)
            flush_dir(source.parent)
    print(json.dumps({key: value for key, value in manifest.items()
                      if key not in ('records', 'legacyEnvelope')}, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Durable migration stopped: ' + type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)
