import Foundation
import XCTest
@testable import OxrailCredentialDemo

final class CredentialDemoTests: XCTestCase {
    private let reference = "ocref1_" + String(repeating: "A", count: 43)
    private let synthetic = Data("oxrail_test_0123456789abcdef".utf8)

    func testPublicResultsContainOnlyTheExistingFixedCredentialContract() {
        XCTAssertEqual(
            CredentialDemoResult.stored(reference).jsonLine,
            "{\"schemaVersion\":1,\"status\":\"STORED\",\"credentialRef\":\"\(reference)\"}"
        )
        XCTAssertEqual(
            CredentialDemoResult.ready(reference).jsonLine,
            "{\"schemaVersion\":1,\"status\":\"READY\",\"credentialRef\":\"\(reference)\"}"
        )
        XCTAssertEqual(
            CredentialDemoResult.cancelled.jsonLine,
            "{\"schemaVersion\":1,\"status\":\"CANCELLED\"}"
        )
        XCTAssertEqual(
            CredentialDemoResult.error(.unavailable).jsonLine,
            "{\"schemaVersion\":1,\"status\":\"ERROR\",\"errorCode\":\"UNAVAILABLE\"}"
        )
        XCTAssertFalse(CredentialDemoResult.stored("not-a-reference").jsonLine.contains("not-a-reference"))
    }

    func testSyntheticSecretStoresBehindAnOpaqueReferenceAndClearsMatchingPasteboard() {
        let keychain = FakeKeychain()
        let pasteboard = FakePasteboard(value: synthetic)
        let vault = makeVault(keychain: keychain, pasteboard: pasteboard)

        let result = vault.storeFixtureSecret(synthetic)

        XCTAssertEqual(result.status, "STORED")
        XCTAssertFalse(result.jsonLine.contains("oxrail_test_"))
        XCTAssertEqual(keychain.items.count, 1)
        XCTAssertEqual(keychain.items.values.first?.secret, synthetic)
        XCTAssertNil(pasteboard.value)
    }

    func testRealLookingAndMalformedValuesNeverReachKeychainOrOutput() {
        for candidate in [
            "sk-live-secret-must-not-enter-demo",
            "github_pat_secret_must_not_enter_demo",
            "oxrail_test_short",
            "oxrail_test_bad value 0123456789",
        ] {
            let keychain = FakeKeychain()
            let pasteboard = FakePasteboard(value: Data(candidate.utf8))
            let result = makeVault(keychain: keychain, pasteboard: pasteboard)
                .storeFixtureSecret(Data(candidate.utf8))

            XCTAssertEqual(result, .error(.notAuthorized), candidate)
            XCTAssertTrue(keychain.items.isEmpty, candidate)
            XCTAssertFalse(result.jsonLine.contains(candidate), candidate)
            XCTAssertEqual(pasteboard.value, Data(candidate.utf8), candidate)
        }
    }

    func testPasteboardCleanupFailureRemovesTheNewKeychainItem() {
        let keychain = FakeKeychain()
        let pasteboard = FakePasteboard(value: synthetic, cleanupSucceeds: false)
        let vault = makeVault(keychain: keychain, pasteboard: pasteboard)

        XCTAssertEqual(vault.storeFixtureSecret(synthetic), .error(.unavailable))
        XCTAssertTrue(keychain.items.isEmpty)
        XCTAssertEqual(pasteboard.value, synthetic)
    }

    func testStatusConsumeExpiryAndRevokeNeverReturnTheSecret() throws {
        let keychain = FakeKeychain()
        let vault = makeVault(keychain: keychain, pasteboard: FakePasteboard())
        let stored = vault.storeFixtureSecret(synthetic)
        let ref = try XCTUnwrap(stored.credentialRef)

        for result in [vault.status(ref), vault.consume(ref)] {
            XCTAssertEqual(result, .ready(ref))
            XCTAssertFalse(result.jsonLine.contains("oxrail_test_"))
        }
        XCTAssertEqual(vault.revoke(ref), .cancelled)
        XCTAssertEqual(vault.status(ref), .error(.revoked))

        let expiredKeychain = FakeKeychain()
        var now = 1_000
        let expiredVault = makeVault(
            keychain: expiredKeychain,
            pasteboard: FakePasteboard(),
            now: { now }
        )
        let expiredRef = try XCTUnwrap(expiredVault.storeFixtureSecret(synthetic).credentialRef)
        now += 3_600
        XCTAssertEqual(expiredVault.consume(expiredRef), .error(.expired))
        XCTAssertTrue(expiredKeychain.items.isEmpty)
    }

    private func makeVault(
        keychain: FakeKeychain,
        pasteboard: FakePasteboard,
        now: @escaping () -> Int = { 1_000 }
    ) -> CredentialDemoVault {
        CredentialDemoVault(
            keychain: keychain,
            pasteboard: pasteboard,
            randomBytes: { count in Data(repeating: 0, count: count) },
            now: now
        )
    }
}

private final class FakeKeychain: CredentialDemoKeychainClient {
    struct Item {
        let metadata: Data
        let secret: Data
    }

    var items: [String: Item] = [:]

    func add(reference: String, metadata: Data, secret: Data) -> Bool {
        guard items[reference] == nil else { return false }
        items[reference] = Item(metadata: metadata, secret: secret)
        return true
    }

    func metadata(reference: String) -> Data? { items[reference]?.metadata }

    func secret(reference: String) -> Data? { items[reference]?.secret }

    func delete(reference: String) -> CredentialDemoDeleteResult {
        items.removeValue(forKey: reference) == nil ? .absent : .removed
    }
}

private final class FakePasteboard: CredentialDemoPasteboardClient {
    var value: Data?
    let cleanupSucceeds: Bool

    init(value: Data? = nil, cleanupSucceeds: Bool = true) {
        self.value = value
        self.cleanupSucceeds = cleanupSucceeds
    }

    func clearIfMatching(_ secret: Data) -> Bool {
        guard value == secret else { return true }
        guard cleanupSucceeds else { return false }
        value = nil
        return true
    }
}
