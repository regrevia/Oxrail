import Dispatch
import Foundation
import XCTest
@testable import OxrailCredentialRegistry

final class CredentialReferenceTests: XCTestCase {
    func testPublicObservationIsMinimalAndNeverActivates() {
        XCTAssertEqual(
            runEmbeddedCredentialReferenceLifecycleObservation().status,
            .matchedFixtureNonAuthorizing
        )
        let report = evaluateEmbeddedCredentialReferenceLifecycle {
            Data(repeating: 0x5a, count: $0)
        }

        XCTAssertEqual(report.schemaVersion, 1)
        XCTAssertEqual(report.authority, .fixtureOnlyNonAuthorizing)
        XCTAssertEqual(report.scope, .opaqueReferenceLifecycleOnly)
        XCTAssertEqual(report.status, .matchedFixtureNonAuthorizing)
        XCTAssertEqual(report.activation, .inactive)
        XCTAssertEqual(report.credentialKind, "API_KEY")
        XCTAssertEqual(report.consumerReadiness, "FIXTURE_ONLY")
        XCTAssertEqual(report.registryVersion, 1)
        XCTAssertEqual(report.templateRegistryHash?.count, 64)
        XCTAssertEqual(report.consumerRegistryHash?.count, 64)
        XCTAssertEqual(report.registryManifestHash?.count, 64)
        XCTAssertEqual(
            Set(Mirror(reflecting: report).children.compactMap { $0.label }),
            [
                "schemaVersion", "authority", "scope", "status", "activation",
                "credentialKind", "consumerReadiness", "registryVersion",
                "templateRegistryHash", "consumerRegistryHash", "registryManifestHash",
            ]
        )
    }

    func testIssueCreatesDistinctOpaqueUrlSafeReferencesAndRejectsRandomFailure() throws {
        let scope = try XCTUnwrap(embeddedCredentialReferenceScope())
        let store = FixtureCredentialReferenceStore()
        var nextByte: UInt8 = 0x11
        let random: (Int) -> Data? = { count in
            defer { nextByte &+= 1 }
            return Data(repeating: nextByte, count: count)
        }

        let first = try XCTUnwrap(store.issue(scope: scope, now: 10, randomBytes: random))
        let second = try XCTUnwrap(store.issue(scope: scope, now: 10, randomBytes: random))
        XCTAssertNotEqual(first, second)
        for reference in [first, second] {
            XCTAssertEqual(reference.count, 50)
            XCTAssertNotNil(reference.wholeMatch(of: #/^ocref1_[A-Za-z0-9_-]{43}$/#))
        }

        for bytes in [nil, Data(repeating: 0, count: 31), Data(repeating: 0, count: 33)] {
            let candidate = FixtureCredentialReferenceStore()
            XCTAssertNil(candidate.issue(scope: scope, now: 10) { _ in bytes })
        }
        let overflow = FixtureCredentialReferenceStore()
        XCTAssertNil(overflow.issue(scope: scope, now: Int.max) { Data(repeating: 0, count: $0) })
        XCTAssertNil(store.issue(scope: scope, now: -1, randomBytes: random))
    }

    func testIssueRequiresTheExactEmbeddedRegistryBinding() throws {
        let scope = try XCTUnwrap(embeddedCredentialReferenceScope())
        for (name, mutate) in scopeMutations() {
            var changed = scope
            mutate(&changed)
            let store = FixtureCredentialReferenceStore()
            XCTAssertNil(
                store.issue(scope: changed, now: 0) { Data(repeating: 0x33, count: $0) },
                name
            )
        }
    }

    func testUseRequiresEveryBoundFieldWithoutSpendingOnMismatch() throws {
        let scope = try XCTUnwrap(embeddedCredentialReferenceScope())
        for (name, mutate) in scopeMutations() {
            let store = FixtureCredentialReferenceStore()
            let reference = try XCTUnwrap(
                store.issue(scope: scope, now: 100) { Data(repeating: 0x44, count: $0) }
            )
            var changed = scope
            mutate(&changed)
            XCTAssertEqual(
                store.evaluateAndSpend(reference, expectedScope: changed, now: 100),
                .denied,
                name
            )
            XCTAssertEqual(
                store.evaluateAndSpend(reference, expectedScope: scope, now: 100),
                .matchedNonAuthorizing,
                name
            )
        }
    }

    func testTtlBoundariesRevocationAndOneShotReplayAreDenied() throws {
        let scope = try XCTUnwrap(embeddedCredentialReferenceScope())

        let beforeIssue = FixtureCredentialReferenceStore()
        let beforeIssueRef = try XCTUnwrap(
            beforeIssue.issue(scope: scope, now: 100) { Data(repeating: 0x51, count: $0) }
        )
        XCTAssertEqual(
            beforeIssue.evaluateAndSpend(beforeIssueRef, expectedScope: scope, now: 99),
            .denied
        )

        let beforeExpiry = FixtureCredentialReferenceStore()
        let beforeExpiryRef = try XCTUnwrap(
            beforeExpiry.issue(scope: scope, now: 100) { Data(repeating: 0x52, count: $0) }
        )
        XCTAssertEqual(
            beforeExpiry.evaluateAndSpend(
                beforeExpiryRef,
                expectedScope: scope,
                now: 100 + scope.grantTtlSeconds - 1
            ),
            .matchedNonAuthorizing
        )
        XCTAssertEqual(
            beforeExpiry.evaluateAndSpend(beforeExpiryRef, expectedScope: scope, now: 100),
            .denied
        )

        let atExpiry = FixtureCredentialReferenceStore()
        let atExpiryRef = try XCTUnwrap(
            atExpiry.issue(scope: scope, now: 100) { Data(repeating: 0x53, count: $0) }
        )
        XCTAssertEqual(
            atExpiry.evaluateAndSpend(
                atExpiryRef,
                expectedScope: scope,
                now: 100 + scope.grantTtlSeconds
            ),
            .denied
        )
        XCTAssertEqual(
            atExpiry.evaluateAndSpend(atExpiryRef, expectedScope: scope, now: 100),
            .denied
        )

        let revoked = FixtureCredentialReferenceStore()
        let revokedRef = try XCTUnwrap(
            revoked.issue(scope: scope, now: 100) { Data(repeating: 0x54, count: $0) }
        )
        XCTAssertTrue(revoked.revoke(revokedRef))
        XCTAssertFalse(revoked.revoke(revokedRef))
        XCTAssertEqual(
            revoked.evaluateAndSpend(revokedRef, expectedScope: scope, now: 100),
            .denied
        )
    }

    func testRandomCollisionAndMalformedOrUnknownReferencesAreDenied() throws {
        let scope = try XCTUnwrap(embeddedCredentialReferenceScope())
        let store = FixtureCredentialReferenceStore()
        let random: (Int) -> Data? = { Data(repeating: 0x61, count: $0) }
        let reference = try XCTUnwrap(store.issue(scope: scope, now: 0, randomBytes: random))

        XCTAssertNil(store.issue(scope: scope, now: 0, randomBytes: random))
        for candidate in ["", "ocref1_short", String(repeating: "a", count: 50)] {
            XCTAssertEqual(
                store.evaluateAndSpend(candidate, expectedScope: scope, now: 0),
                .denied
            )
            XCTAssertFalse(store.revoke(candidate))
        }
        XCTAssertEqual(
            store.evaluateAndSpend(reference, expectedScope: scope, now: 0),
            .matchedNonAuthorizing
        )
    }

    func testObservationFailsClosedWhenRandomnessIsUnavailableOrMalformed() {
        for bytes in [nil, Data(repeating: 0, count: 31), Data(repeating: 0, count: 33)] {
            let report = evaluateEmbeddedCredentialReferenceLifecycle { _ in bytes }
            XCTAssertEqual(report.status, .inactive)
            XCTAssertEqual(report.activation, .inactive)
        }
    }

    func testOnlyOneConcurrentClaimCanSpendAReference() throws {
        let scope = try XCTUnwrap(embeddedCredentialReferenceScope())
        let store = FixtureCredentialReferenceStore()
        let reference = try XCTUnwrap(
            store.issue(scope: scope, now: 100) { Data(repeating: 0x71, count: $0) }
        )
        let resultLock = NSLock()
        var accepted = 0

        DispatchQueue.concurrentPerform(iterations: 32) { _ in
            if store.evaluateAndSpend(reference, expectedScope: scope, now: 100) ==
                .matchedNonAuthorizing {
                resultLock.lock()
                accepted += 1
                resultLock.unlock()
            }
        }
        XCTAssertEqual(accepted, 1)
    }
}

private func scopeMutations() -> [(String, (inout CredentialReferenceScope) -> Void)] {
    [
        ("credential use", { $0.credentialUseId = "fixture.other" }),
        ("credential kind", { $0.credentialKind = "PASSWORD" }),
        ("template", { $0.templateId = "fixture.other.v1" }),
        ("service", { $0.serviceId = "other-service" }),
        ("origin", { $0.provisioningOrigin = "https://other.example.test" }),
        ("purpose", { $0.purposeId = "other-purpose" }),
        ("consumer", { $0.consumerId = "fixture.other" }),
        ("ttl", { $0.grantTtlSeconds += 1 }),
        ("generation", { $0.generation += 1 }),
        ("registry version", { $0.registryVersion += 1 }),
        ("template hash", { $0.templateRegistryHash = String(repeating: "a", count: 64) }),
        ("consumer hash", { $0.consumerRegistryHash = String(repeating: "b", count: 64) }),
        ("manifest hash", { $0.registryManifestHash = String(repeating: "c", count: 64) }),
    ]
}
