import CryptoKit
import Foundation
import XCTest
@testable import OxrailCredentialEnclave
@testable import OxrailCredentialRegistry

final class CredentialPresentationCheckpointTests: XCTestCase {
    func testCoreGoldenTicketProducesOnlyAnInertPromptContext() throws {
        let data = try fixtureData()
        let checkpoint = try XCTUnwrap(
            checkpointCredentialPresentation(candidateJSON: data, observedAt: 2_000)
        )

        XCTAssertEqual(checkpoint.schemaVersion, 1)
        XCTAssertEqual(checkpoint.authority, .fixtureOnlyNonAuthorizing)
        XCTAssertEqual(checkpoint.activation, "INACTIVE")
        XCTAssertEqual(checkpoint.authorization, "NOT_AUTHORIZED")
        XCTAssertEqual(checkpoint.hostSuspension, "UNVERIFIED")
        XCTAssertEqual(checkpoint.presentation, "NOT_PRESENTED")
        XCTAssertEqual(checkpoint.credentialUseId, "fixture.publish.api-key")
        XCTAssertEqual(checkpoint.leaseExpiresAt, 10_000)
        XCTAssertEqual(
            checkpoint.promptContextHash,
            "19535252dec48e898f58062f0846d2585d798463b15557654afee5ca8261827b"
        )
        XCTAssertEqual(checkpoint.scope.generation, 1)
        XCTAssertEqual(checkpoint.scope.registryVersion, 1)
        XCTAssertNotEqual(
            checkpoint.promptContextHash,
            checkpointCredentialPresentation(candidateJSON: data, observedAt: 2_001)?.promptContextHash
        )
        XCTAssertEqual(
            Set(Mirror(reflecting: checkpoint).children.compactMap { $0.label }),
            [
                "schemaVersion", "authority", "activation", "authorization",
                "hostSuspension", "presentation", "credentialUseId",
                "leaseExpiresAt", "promptContextHash", "scope",
            ]
        )

        let reflected = String(reflecting: checkpoint)
        for forbidden in [
            "oct1_e71d5fd94af10421216517dc3214de847ef35dd4aefd2d1849ce32f041b90787",
            "d83d1be9ce6f4aa29ce48316f25af01ab7de34c00d971d1fb621bfaca3eabbbd",
            "session-binding", "task-binding", "document-binding",
        ] {
            XCTAssertFalse(reflected.contains(forbidden), forbidden)
        }
    }

    func testEveryEmbeddedRegistryBindingDriftRejectsAConsistentTicketId() throws {
        var unchanged = try XCTUnwrap(
            JSONSerialization.jsonObject(with: fixtureData()) as? [String: Any]
        )
        let originalTicketId = try XCTUnwrap(unchanged["ticketId"] as? String)
        try replaceTicketId(&unchanged)
        XCTAssertEqual(unchanged["ticketId"] as? String, originalTicketId)

        for (name, key, value) in registryMutations() {
            XCTAssertNil(
                checkpointCredentialPresentation(
                    candidateJSON: try candidate(rehashTicketId: true) { $0[key] = value },
                    observedAt: 2_000
                ),
                name
            )
        }
    }

    func testTicketDigestCommitsRegistryHandoffAndIssuedAt() throws {
        let original = try JSONDecoder().decode(CredentialTicketV2.self, from: fixtureData())
        let originalId = try XCTUnwrap(credentialTicketIdentifier(for: original))
        XCTAssertEqual(originalId, original.ticketId)

        for (name, key, value) in registryMutations() {
            let changed = try JSONDecoder().decode(
                CredentialTicketV2.self,
                from: candidate { $0[key] = value }
            )
            XCTAssertNotEqual(
                try XCTUnwrap(credentialTicketIdentifier(for: changed)),
                originalId,
                name
            )
        }
        let handoffMutations: [(String, String, Any)] = [
            ("anchor", "activationAnchorHash", String(repeating: "a", count: 64)),
            ("lease epoch", "leaseEpoch", 2),
            ("acquired", "acquiredAt", 1_199),
            ("expiry", "expiresAt", 10_001),
        ]
        for (name, key, value) in handoffMutations {
            let data = try candidate { ticket in
                replaceHandoff(&ticket, key: key, value: value)
            }
            let changed = try JSONDecoder().decode(CredentialTicketV2.self, from: data)
            XCTAssertNotEqual(
                try XCTUnwrap(credentialTicketIdentifier(for: changed)),
                originalId,
                name
            )
            XCTAssertNil(
                checkpointCredentialPresentation(
                    candidateJSON: data,
                    observedAt: 2_000
                ),
                name
            )
        }
        let changedIssuedAtData = try candidate { $0["issuedAt"] = 2_001 }
        let changedIssuedAt = try JSONDecoder().decode(
            CredentialTicketV2.self,
            from: changedIssuedAtData
        )
        XCTAssertNotEqual(
            try XCTUnwrap(credentialTicketIdentifier(for: changedIssuedAt)),
            originalId
        )
        XCTAssertNil(
            checkpointCredentialPresentation(
                candidateJSON: changedIssuedAtData,
                observedAt: 2_001
            )
        )
    }

    func testMalformedShapesAndInvalidTimeWindowsAreRejected() throws {
        for data in [Data(), Data("{".utf8), Data("[]".utf8), Data(repeating: 0x20, count: 16_385)] {
            XCTAssertNil(
                checkpointCredentialPresentation(candidateJSON: data, observedAt: 2_000)
            )
        }
        XCTAssertNil(
            checkpointCredentialPresentation(
                candidateJSON: try candidate { $0["title"] = "agent supplied" },
                observedAt: 2_000
            )
        )
        for (key, value) in [
            ("schemaVersion", 1 as Any),
            ("authority", "AUTHORIZING" as Any),
            ("ticketId", "oct1_invalid" as Any),
        ] {
            XCTAssertNil(
                checkpointCredentialPresentation(
                    candidateJSON: try candidate { $0[key] = value },
                    observedAt: 2_000
                )
            )
        }
        XCTAssertNil(
            checkpointCredentialPresentation(
                candidateJSON: try candidate { $0.removeValue(forKey: "ticketId") },
                observedAt: 2_000
            )
        )
        XCTAssertNil(
            checkpointCredentialPresentation(
                candidateJSON: try candidate { ticket in
                    replaceHandoff(&ticket, key: "tabId", value: 42)
                },
                observedAt: 2_000
            )
        )
        XCTAssertNil(
            checkpointCredentialPresentation(
                candidateJSON: try candidate { ticket in
                    var handoff = ticket["handoff"] as! [String: Any]
                    handoff.removeValue(forKey: "leaseEpoch")
                    ticket["handoff"] = handoff
                },
                observedAt: 2_000
            )
        )
        XCTAssertNil(
            checkpointCredentialPresentation(
                candidateJSON: try candidate(rehashTicketId: true) { ticket in
                    replaceHandoff(&ticket, key: "leaseEpoch", value: 0)
                },
                observedAt: 2_000
            )
        )
        XCTAssertNil(
            checkpointCredentialPresentation(
                candidateJSON: try candidate(rehashTicketId: true) { ticket in
                    replaceHandoff(
                        &ticket,
                        key: "activationAnchorHash",
                        value: String(repeating: "A", count: 64)
                    )
                },
                observedAt: 2_000
            )
        )
        XCTAssertNil(
            checkpointCredentialPresentation(
                candidateJSON: try candidate(rehashTicketId: true) { ticket in
                    replaceHandoff(
                        &ticket,
                        key: "leaseEpoch",
                        value: 9_007_199_254_740_992
                    )
                },
                observedAt: 2_000
            )
        )
        XCTAssertNil(
            checkpointCredentialPresentation(
                candidateJSON: try candidate(rehashTicketId: true) { ticket in
                    ticket["issuedAt"] = 2_000
                    replaceHandoff(&ticket, key: "acquiredAt", value: 2_000)
                    replaceHandoff(&ticket, key: "expiresAt", value: 2_000)
                },
                observedAt: 2_000
            )
        )
        XCTAssertNil(
            checkpointCredentialPresentation(
                candidateJSON: try candidate(rehashTicketId: true) { ticket in
                    replaceHandoff(&ticket, key: "acquiredAt", value: 2_001)
                },
                observedAt: 2_001
            )
        )

        let data = try fixtureData()
        XCTAssertNil(checkpointCredentialPresentation(candidateJSON: data, observedAt: -1))
        XCTAssertNil(checkpointCredentialPresentation(candidateJSON: data, observedAt: 1_999))
        XCTAssertNotNil(checkpointCredentialPresentation(candidateJSON: data, observedAt: 10_000))
        XCTAssertNil(checkpointCredentialPresentation(candidateJSON: data, observedAt: 10_001))
    }

    private func fixtureData() throws -> Data {
        let url = try XCTUnwrap(
            Bundle.module.url(
                forResource: "credential-ticket-v2",
                withExtension: "json",
                subdirectory: "Fixtures"
            )
        )
        return try Data(contentsOf: url)
    }

    private func candidate(
        rehashTicketId: Bool = false,
        _ mutate: (inout [String: Any]) -> Void
    ) throws -> Data {
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: fixtureData()) as? [String: Any]
        )
        mutate(&object)
        if rehashTicketId {
            try replaceTicketId(&object)
        }
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private func registryMutations() -> [(String, String, Any)] {
        [
            ("credential use", "credentialUseId", "fixture.other"),
            ("credential kind", "credentialKind", "PASSWORD"),
            ("template", "templateId", "fixture.other.v1"),
            ("service", "serviceId", "other-service"),
            ("origin", "provisioningOrigin", "https://other.example.test"),
            ("purpose", "purposeId", "other-purpose"),
            ("consumer", "consumerId", "fixture.other"),
            ("ttl", "grantTtlSeconds", 3_601),
            ("generation", "generation", 2),
            ("registry version", "registryVersion", 2),
            ("template hash", "templateRegistryHash", String(repeating: "a", count: 64)),
            ("consumer hash", "consumerRegistryHash", String(repeating: "b", count: 64)),
            ("manifest hash", "registryManifestHash", String(repeating: "c", count: 64)),
        ]
    }
}

private let registryEntryKeys = [
    "credentialUseId", "credentialKind", "templateId", "serviceId",
    "provisioningOrigin", "purposeId", "consumerId", "grantTtlSeconds",
    "generation", "registryVersion", "templateRegistryHash",
    "consumerRegistryHash", "registryManifestHash",
]

private func replaceTicketId(_ ticket: inout [String: Any]) throws {
    var entry: [String: Any] = ["schemaVersion": 1, "readiness": "FIXTURE_ONLY"]
    for key in registryEntryKeys {
        entry[key] = try XCTUnwrap(ticket[key])
    }
    let payload: [String: Any] = [
        "entry": entry,
        "handoff": try XCTUnwrap(ticket["handoff"]),
        "issuedAt": try XCTUnwrap(ticket["issuedAt"]),
    ]
    let encoded = try JSONSerialization.data(
        withJSONObject: payload,
        options: [.sortedKeys, .withoutEscapingSlashes]
    )
    var input = Data("oxrail-credential-fixture-ticket-v2".utf8)
    input.append(0)
    input.append(encoded)
    let digest = SHA256.hash(data: input).map { String(format: "%02x", $0) }.joined()
    ticket["ticketId"] = "oct1_\(digest)"
}

private func replaceHandoff(
    _ ticket: inout [String: Any],
    key: String,
    value: Any
) {
    var handoff = ticket["handoff"] as! [String: Any]
    handoff[key] = value
    ticket["handoff"] = handoff
}
