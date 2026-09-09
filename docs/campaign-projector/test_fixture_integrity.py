"""Stdlib-only synthetic fixture integrity, NOT a runtime projector/verifier.

Run this explicit file in the existing offline scorer CI job. No jsonschema,
production imports, environment/config reads, remote references or writes.
"""
import ast
import copy
import hashlib
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent
FIXTURES = ('v1-moneyline-zero.json', 'v2-spread-absent.json')
FRONTIER_KEYS = ('contractVersion', 'policyVersion', 'identity', 'sources')


def fixture(name):
    return json.loads((ROOT / 'fixtures' / name).read_text(encoding='utf-8'))


def canonical_fixture_frontier(value):
    """Port canonical.ts for fixture frontier types only (no floats/undefined).

    Object keys use JS UTF-16 ordering; strings are literal UTF-8 JSON. This
    deliberately refuses other types rather than claiming a general JS-number
    serializer. Only the fixture's four-field input frontier is hashed here.
    """
    if value is None or type(value) in (str, bool):
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if type(value) is int and abs(value) <= 9007199254740991:
        return str(value)
    if isinstance(value, list):
        return '[' + ','.join(canonical_fixture_frontier(v) for v in value) + ']'
    if isinstance(value, dict) and all(isinstance(k, str) for k in value):
        keys = sorted(value, key=lambda k: k.encode('utf-16-be'))
        return '{' + ','.join(
            canonical_fixture_frontier(k) + ':' + canonical_fixture_frontier(value[k])
            for k in keys
        ) + '}'
    raise ValueError('unsupported fixture frontier value')


def revision_key(document):
    frontier = {key: document[key] for key in FRONTIER_KEYS}
    return hashlib.sha256(canonical_fixture_frontier(frontier).encode('utf-8')).hexdigest()


def verify_fixture_revision(document):
    if revision_key(document) != document['revisionKey']:
        raise ValueError('fixture revisionKey mismatch')


class FixtureIntegrityTests(unittest.TestCase):
    def test_exact_fixture_inventory_and_revision_keys(self):
        self.assertEqual(tuple(p.name for p in sorted((ROOT / 'fixtures').glob('*.json'))), FIXTURES)
        for name in FIXTURES:
            with self.subTest(name=name):
                verify_fixture_revision(fixture(name))

    def test_revision_key_mutations_are_detected(self):
        for name in FIXTURES:
            for field in (*FRONTIER_KEYS, 'revisionKey'):
                with self.subTest(name=name, field=field):
                    d = copy.deepcopy(fixture(name))
                    if field == 'identity':
                        d[field]['runId'] += '-changed'
                    elif field == 'sources':
                        d[field]['manifest']['sha256'] = '0' * 64
                    else:
                        d[field] += '-changed'
                    with self.assertRaisesRegex(ValueError, 'fixture revisionKey mismatch'):
                        verify_fixture_revision(d)

    def test_frontier_is_order_independent_but_excludes_output_fields(self):
        d = fixture(FIXTURES[0])
        reordered = dict(reversed(list(d.items())))
        reordered['identity'] = dict(reversed(list(d['identity'].items())))
        reordered['sources'] = dict(reversed(list(d['sources'].items())))
        self.assertEqual(revision_key(d), revision_key(reordered))
        d['origin'] = 'unattested'
        d['spend']['totalUsdMicros'] = None
        self.assertEqual(revision_key(d), reordered['revisionKey'])
        # This exclusion is NOT approval of these incoherent output mutations.

    def test_canonical_fixture_subset(self):
        self.assertEqual(canonical_fixture_frontier({'z': None, 'a': [True, '\u00e9', 1]}),
                         '{"a":[true,"\u00e9",1],"z":null}')
        self.assertEqual(canonical_fixture_frontier({'\ue000': 1, '\U00010000': 2}),
                         '{"\U00010000":2,"\ue000":1}')
        for unsupported in (1.5, float('nan'), 9007199254740992):
            with self.assertRaisesRegex(ValueError, 'unsupported fixture frontier value'):
                canonical_fixture_frontier(unsupported)

    def test_contract_text_reads_explicitly_use_utf8(self):
        # Guards the four original call sites, including currently ASCII JSON,
        # and new reads. Platform defaults must never decode contract bytes.
        for name in ('test_contract.py', 'test_fixture_integrity.py'):
            source = (ROOT / name).read_text(encoding='utf-8')
            calls = [n for n in ast.walk(ast.parse(source))
                     if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                     and n.func.attr == 'read_text']
            self.assertTrue(calls, name)
            for call in calls:
                with self.subTest(file=name, line=call.lineno):
                    encodings = [k.value for k in call.keywords if k.arg == 'encoding']
                    self.assertEqual(len(encodings), 1)
                    self.assertIsInstance(encodings[0], ast.Constant)
                    self.assertEqual(ast.literal_eval(encodings[0]), 'utf-8')


if __name__ == '__main__':
    unittest.main()
