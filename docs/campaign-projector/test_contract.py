"""Contract-only schema checks. Synthetic examples are NOT projected/live evidence.

Requires jsonschema 4.26.0. No production imports, remote refs, environment reads,
network calls, DB calls, filesystem writer, or executable projector.
"""
import copy
import hashlib
import json
from pathlib import Path
import unittest

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent
SCHEMA = json.loads((ROOT / 'projection.schema.json').read_text(encoding='utf-8'))
VALIDATOR = Draft202012Validator(SCHEMA)


def fixture(name='v2-spread-absent.json'):
    return json.loads((ROOT / 'fixtures' / name).read_text(encoding='utf-8'))


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
                d = json.loads(path.read_text(encoding='utf-8'))
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
            ('attempt 3 exceeds the frozen repair cap', ['arms', 0, 'accepted', 'attemptNumber'], 3),
            ('large attempt is outside enum 1/2', ['arms', 0, 'accepted', 'attemptNumber'], 9007199254740992),
            ('manifest network alias is not a serving key', ['identity', 'network'], 'polygon-amoy'),
            ('empty network is refused', ['identity', 'network'], ''),
            ('synthetic requires origin attestation', ['sources', 'originAttestation'], None),
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

    def test_spend_branches_and_breach_unknown_total(self):
        # Shape examples, not assessments of real provider attempts. A confirmed
        # breach and an unpriceable sibling must fit without downgrading or zero.
        cases = [
            ('absent', 'not_present', None),
            ('unverified', 'not_assessed', None),
            ('verified', 'verified', 0),
            ('verified', 'verified', 9007199254740991),
            ('unknown', 'cost_unknown', None),
            ('breach', 'reservation_breach', None),
            ('breach', 'reservation_breach', 1),
            ('breach', 'reservation_breach', 9007199254740991),
            ('invalid', 'binding_or_integrity_failure', None),
        ]
        reasons = {reason for _, reason, _ in cases}
        for state, reason, total in cases:
            with self.subTest(state=state, total=total):
                d = fixture('v1-moneyline-zero.json')
                d['spend'].update(state=state, reason=reason, totalUsdMicros=total)
                if state in ('absent', 'unverified'):
                    d['spend']['assessment'] = None
                    d['sources']['spendAssessment'] = None
                if state == 'absent':
                    d['sources']['spendSidecar'] = None
                VALIDATOR.validate(d)
                for wrong in reasons - {reason}:
                    self.assertFalse(VALIDATOR.is_valid(changed(d, ['spend', 'reason'], wrong)))
                candidate = changed(d, ['origin'], 'campaign')
                candidate['execution'][0]['state'] = 'candidate'
                self.assertEqual(VALIDATOR.is_valid(candidate), state == 'verified')
                if state == 'breach':
                    for bad in (0, -1, 1.5, 9007199254740992, True, '1'):
                        self.assertFalse(VALIDATOR.is_valid(changed(d, ['spend', 'totalUsdMicros'], bad)))
                    self.assertFalse(VALIDATOR.is_valid(changed(d, ['spend', 'assessment'], None)))
                    self.assertFalse(VALIDATOR.is_valid(changed(d, ['sources', 'spendAssessment'], None)))
                if state in ('unknown', 'invalid', 'absent', 'unverified'):
                    self.assertFalse(VALIDATOR.is_valid(changed(d, ['spend', 'totalUsdMicros'], 0)))

    def test_network_and_attempt_policy_bounds(self):
        for network in ('polygon', 'amoy'):
            for attempt in (1, 2):
                with self.subTest(network=network, attempt=attempt):
                    d = changed(fixture(), ['identity', 'network'], network)
                    d['arms'][0]['accepted']['attemptNumber'] = attempt
                    VALIDATOR.validate(d)

    def test_campaign_and_synthetic_require_attestation(self):
        for origin in ('campaign', 'synthetic'):
            d = changed(fixture(), ['origin'], origin)
            VALIDATOR.validate(d)
            self.assertFalse(VALIDATOR.is_valid(changed(d, ['sources', 'originAttestation'], None)))
        d = changed(fixture(), ['origin'], 'unattested')
        d['sources']['originAttestation'] = None
        VALIDATOR.validate(d)

    def test_uri_validation_is_lexical_not_full_rfc_validation(self):
        # URI syntax/dereferencing remains an owner gate, not an optional-extra
        # dependent promise from JSON Schema. This malformed IPv6 passes lexical shape.
        self.assertNotIn('format', SCHEMA['$defs']['blob']['properties']['uri'])
        VALIDATOR.validate(changed(fixture(), ['sources', 'manifest', 'uri'], 'http://[not-a-valid-uri'))
        for uri in ('not a URI', 'https://has whitespace', ':missing-scheme', 'urn:'):
            self.assertFalse(VALIDATOR.is_valid(changed(fixture(), ['sources', 'manifest', 'uri'], uri)))

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
        self.assertIn('Not verified by JSON Schema', (ROOT / 'CONTRACT.md').read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
