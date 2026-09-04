import Foundation
import XCTest
@testable import OxrailKeychainProbe

final class KeychainProbeTests: XCTestCase {
    func testSuccessfulRoundTripDeletesProbe() {
        let keychain = FakeKeychain()
        let result = makeProbe(keychain: keychain).run()

        XCTAssertEqual(result, ProbeResult(status: .passed, probeId: nil))
        XCTAssertEqual(keychain.addCount, 1)
        XCTAssertEqual(keychain.readCount, 1)
        XCTAssertEqual(keychain.deleteCount, 1)
    }

    func testEveryFailureAfterLocatorAttemptsCleanup() {
        let addFailure = FakeKeychain(addSucceeds: false)
        XCTAssertEqual(makeProbe(keychain: addFailure).run().status, .failed)
        XCTAssertEqual(addFailure.deleteCount, 1)

        let readFailure = FakeKeychain(readSucceeds: false)
        XCTAssertEqual(makeProbe(keychain: readFailure).run().status, .failed)
        XCTAssertEqual(readFailure.deleteCount, 1)

        let mismatch = FakeKeychain(returnedData: Data(repeating: 0xff, count: 32))
        XCTAssertEqual(makeProbe(keychain: mismatch).run().status, .failed)
        XCTAssertEqual(mismatch.deleteCount, 1)

        let missingSecretRandom = FakeKeychain()
        var randomCall = 0
        let result = KeychainProbe(keychain: missingSecretRandom) { count in
            randomCall += 1
            return randomCall == 1 ? Data(repeating: 0x01, count: count) : nil
        }.run()
        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(missingSecretRandom.deleteCount, 1)
    }

    func testCleanupFailureReturnsOnlyNonSecretLocator() throws {
        let keychain = FakeKeychain(deleteResult: .failed)
        let result = makeProbe(keychain: keychain).run()
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(result.jsonLine.utf8)) as? [String: Any]
        )

        XCTAssertEqual(result.status, .cleanupFailed)
        XCTAssertEqual(Set(object.keys), ["schemaVersion", "probe", "status", "probeId"])
        XCTAssertEqual(object["schemaVersion"] as? Int, 1)
        XCTAssertEqual(object["probe"] as? String, "KEYCHAIN_ROUND_TRIP")
        XCTAssertEqual(object["status"] as? String, "CLEANUP_FAILED")
        XCTAssertEqual((object["probeId"] as? String)?.count, 32)
        XCTAssertEqual(keychain.deleteCount, 1)
    }

    func testAlreadyAbsentAfterSuccessfulRoundTripIsClean() {
        let keychain = FakeKeychain(deleteResult: .absent)

        XCTAssertEqual(makeProbe(keychain: keychain).run().status, .passed)
        XCTAssertEqual(keychain.deleteCount, 1)
    }

    func testSerializationHasNoSecretBearingFields() throws {
        let results = [
            ProbeResult(status: .passed, probeId: nil),
            ProbeResult(status: .failed, probeId: nil),
            ProbeResult(status: .cleanupFailed, probeId: String(repeating: "a", count: 32)),
            ProbeResult.usage,
        ]

        for result in results {
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(result.jsonLine.utf8)) as? [String: Any]
            )
            let expectedKeys: Set<String> = result.status == .cleanupFailed
                ? ["schemaVersion", "probe", "status", "probeId"]
                : ["schemaVersion", "probe", "status"]
            XCTAssertEqual(Set(object.keys), expectedKeys)
            XCTAssertEqual(object["schemaVersion"] as? Int, 1)
            XCTAssertEqual(object["probe"] as? String, "KEYCHAIN_ROUND_TRIP")
            for forbidden in ["data", "message", "value", "persistentRef"] {
                XCTAssertNil(object[forbidden])
                XCTAssertFalse(result.jsonLine.contains(forbidden))
            }
        }
    }
}

private final class FakeKeychain: ProbeKeychainClient {
    private let addSucceeds: Bool
    private let readSucceeds: Bool
    private let returnedData: Data?
    private let deleteResult: ProbeDeleteResult
    private var storedData: Data?

    var addCount = 0
    var readCount = 0
    var deleteCount = 0

    init(
        addSucceeds: Bool = true,
        readSucceeds: Bool = true,
        returnedData: Data? = nil,
        deleteResult: ProbeDeleteResult = .removed
    ) {
        self.addSucceeds = addSucceeds
        self.readSucceeds = readSucceeds
        self.returnedData = returnedData
        self.deleteResult = deleteResult
    }

    func addProbe(_ locator: ProbeLocator, data: Data) -> Bool {
        addCount += 1
        storedData = data
        return addSucceeds
    }

    func readProbe(_ locator: ProbeLocator) -> Data? {
        readCount += 1
        guard readSucceeds else { return nil }
        return returnedData ?? storedData
    }

    func deleteProbe(_ locator: ProbeLocator) -> ProbeDeleteResult {
        deleteCount += 1
        return deleteResult
    }
}

private func makeProbe(keychain: FakeKeychain) -> KeychainProbe {
    KeychainProbe(keychain: keychain) { Data(repeating: UInt8($0), count: $0) }
}
