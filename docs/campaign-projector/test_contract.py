"""Contract-only schema checks. Synthetic examples are NOT projected/live evidence.

Requires jsonschema 4.26.0. No production imports, remote refs, environment reads,
network calls, DB calls, filesystem writer, or executable projector.
"""
import copy
import hashlib
import json
from pathlib import Path
import unittest

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parent
SCHEMA = json.loads((ROOT / 'projection.schema.json').read_text())
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())


def fixture(name='v2-spread-absent.json'):
    return json.loads((ROOT / 'fixtures' / name).read_text())


def changed(document, path, value):
    result = copy.deepcopy(document)
    target = result
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = value
    return result


class ContractTests(unittest.TestCase):
    def test_schema_is_valid_and_refs_are_local(self):
        Draft202012Validator.check_schema(SCHEMA)
        def visit(value):
            if isinstance(value, dict):
                if '$ref' in value:
                    self.assertTrue(value['$ref'].startswith('#/'), value['$ref'])
                for item in value.values():
                    visit(item)
            elif isinstance(value, list):
                for item in value:
                    visit(item)
        visit(SCHEMA)

    def test_both_synthetic_versions_are_schema_valid(self):
        paths = sorted((ROOT / 'fixtures').glob('*.json'))
        self.assertEqual([p.name for p in paths], ['v1-moneyline-zero.json', 'v2-spread-absent.json'])
        for path in paths:
            with self.subTest(path=path.name):
                d = json.loads(path.read_text())
                VALIDATOR.validate(d)
                self.assertEqual(d['origin'], 'synthetic')
                self.assertTrue(all(not row['authorizesExecution'] for row in d['execution']))
                self.assertTrue(all(row['closeStatus'] == 'not_loaded' for row in d['scoring']))

    def test_fixture_bodies_and_hashes_are_internally_consistent(self):
        # Fixture integrity only: this does NOT verify a real artifact or manifest.
        for name in ['v1-moneyline-zero.json', 'v2-spread-absent.json']:
            for arm in fixture(name)['arms']:
                if arm['accepted'] is not None:
                    a = arm['accepted']
                    self.assertEqual(json.loads(a['persistedResponseBody']), a['parsedResponse'])
                    self.assertEqual(hashlib.sha256(a['persistedResponseBody'].encode()).hexdigest(), a['responseSha256'])

    def test_shape_negative_controls(self):
        d = fixture()
        cases = [
            ('unknown contract', ['contractVersion'], 'campaign-projector/v2'),
            ('unknown policy', ['policyVersion'], 'unreviewed'),
            ('day alias is not cohort identity', ['identity', 'cohortId'], '2026-09-09'),
            ('upper-case hash refused', ['identity', 'cohortId'], 'A' * 64),
            ('unknown market', ['identity', 'scopedMarkets'], ['runLine']),
            ('noncanonical market order', ['identity', 'scopedMarkets'], ['total', 'spread']),
            ('invalid blob URI', ['sources', 'manifest', 'uri'], 'not a URI'),
            ('absent is not zero', ['spend', 'totalUsdMicros'], 0),
            ('unattested with attestation', ['origin'], 'unattested'),
            ('synthetic never executable', ['execution', 0, 'state'], 'candidate'),
            ('no execution authority', ['execution', 0, 'authorizesExecution'], True),
            ('no invented close', ['scoring', 0, 'closeStatus'], 'loaded'),
            ('no invented eligibility', ['scoring', 0, 'entryEligibility'], 'eligible'),
            ('no derived ranking', ['serving', 0, 'ranking'], 'ranked'),
            ('unknown arm failure', ['arms', 1, 'terminalOutcome'], 'missing'),
            ('failed arm cannot accept', ['arms', 1, 'accepted'], d['arms'][0]['accepted']),
            ('valid arm needs accepted body', ['arms', 0, 'accepted'], None),
            ('attempt index is safe integer', ['arms', 0, 'accepted', 'attemptNumber'], 9007199254740992),
            ('unknown response schema', ['arms', 0, 'accepted', 'parsedResponse', 'schemaVersion'], 3),
            ('closed top-level fields', ['watchId'], 'forged-watch'),
        ]
        for label, path, value in cases:
            with self.subTest(case=label):
                self.assertFalse(VALIDATOR.is_valid(changed(d, path, value)), label)
        no_body = copy.deepcopy(d)
        del no_body['arms'][0]['accepted']['persistedResponseBody']
        self.assertFalse(VALIDATOR.is_valid(no_body), 'fingerprint-only reconstruction must not fit')

    def test_verified_zero_is_distinct_from_absent(self):
        d = fixture('v1-moneyline-zero.json')
        self.assertEqual(d['spend']['totalUsdMicros'], 0)
        for path in [['spend', 'assessment'], ['sources', 'spendSidecar'], ['sources', 'spendAssessment']]:
            with self.subTest(path=path):
                self.assertFalse(VALIDATOR.is_valid(changed(d, path, None)))
        self.assertIsNone(fixture()['spend']['totalUsdMicros'])

    def test_response_version_shapes_remain_distinct(self):
        v1 = fixture('v1-moneyline-zero.json')
        v2 = fixture()
        path = ['arms', 0, 'accepted', 'parsedResponse', 'games', 0, 'forecasts', 0]
        v1_forecast = v1['arms'][0]['accepted']['parsedResponse']['games'][0]['forecasts'][0]
        v2_forecast = v2['arms'][0]['accepted']['parsedResponse']['games'][0]['forecasts'][0]
        self.assertFalse(VALIDATOR.is_valid(changed(v1, path, v2_forecast)))
        self.assertFalse(VALIDATOR.is_valid(changed(v2, path, v1_forecast)))

    def test_schema_does_not_claim_relational_or_digest_validation(self):
        d = fixture()
        # Explicitly record the JSON Schema boundary: these need later owner verifiers.
        d['revisionKey'] = '0' * 64
        d['execution'][0]['decisionIndex'] = 100
        VALIDATOR.validate(d)
        self.assertIn('Not verified by JSON Schema', (ROOT / 'CONTRACT.md').read_text())


if __name__ == '__main__':
    unittest.main()
