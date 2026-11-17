import Foundation
import Security

public enum ProbeStatus: String {
    case passed = "PASSED"
    case failed = "FAILED"
    case cleanupFailed = "CLEANUP_FAILED"
    case usage = "USAGE"
}

public struct ProbeResult: Equatable {
    public static let schemaVersion = 1
    public static let probe = "KEYCHAIN_ROUND_TRIP"

    public let status: ProbeStatus
    public let probeId: String?

    public static let usage = ProbeResult(status: .usage, probeId: nil)

    public var jsonLine: String {
        if status == .cleanupFailed, let probeId {
            return #"{"schemaVersion":\#(Self.schemaVersion),"probe":"\#(Self.probe)","status":"CLEANUP_FAILED","probeId":"\#(probeId)"}"#
        }
        return #"{"schemaVersion":\#(Self.schemaVersion),"probe":"\#(Self.probe)","status":"\#(status.rawValue)"}"#
    }
}

struct ProbeLocator {
    let service: String
    let account: String
}

enum ProbeDeleteResult: Equatable {
    case removed
    case absent
    case failed
}

protocol ProbeKeychainClient {
    func addProbe(_ locator: ProbeLocator, data: Data) -> Bool
    func readProbe(_ locator: ProbeLocator) -> Data?
    func deleteProbe(_ locator: ProbeLocator) -> ProbeDeleteResult
}

private struct SecurityKeychainClient: ProbeKeychainClient {
    func addProbe(_ locator: ProbeLocator, data: Data) -> Bool {
        var query = baseQuery(locator)
        query[kSecAttrLabel as String] = "Oxrail fixture-only extended probe"
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        query[kSecValueData as String] = data
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    func readProbe(_ locator: ProbeLocator) -> Data? {
        var query = baseQuery(locator)
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnData as String] = true

        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else {
            return nil
        }
        return result as? Data
    }

    func deleteProbe(_ locator: ProbeLocator) -> ProbeDeleteResult {
        switch SecItemDelete(baseQuery(locator) as CFDictionary) {
        case errSecSuccess:
            return .removed
        case errSecItemNotFound:
            return .absent
        default:
            return .failed
        }
    }

    private func baseQuery(_ locator: ProbeLocator) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: locator.service,
            kSecAttrAccount as String: locator.account,
        ]
    }
}

struct KeychainProbe {
    let keychain: any ProbeKeychainClient
    let randomBytes: (Int) -> Data?

    func run() -> ProbeResult {
        guard let idBytes = randomBytes(16), idBytes.count == 16 else {
            return ProbeResult(status: .failed, probeId: nil)
        }

        let probeId = idBytes.map { String(format: "%02x", $0) }.joined()
        let locator = ProbeLocator(
            service: "dev.oxrail.fixture-only.keychain-probe",
            account: probeId
        )
        var cleanup: ProbeDeleteResult?

        let roundTripPassed: Bool = {
            defer { cleanup = keychain.deleteProbe(locator) }

            guard let expected = randomBytes(32), expected.count == 32,
                  keychain.addProbe(locator, data: expected),
                  let actual = keychain.readProbe(locator) else {
                return false
            }
            return timingSafeEqual(expected, actual)
        }()

        if cleanup == .failed {
            return ProbeResult(status: .cleanupFailed, probeId: probeId)
        }
        return ProbeResult(status: roundTripPassed ? .passed : .failed, probeId: nil)
    }
}

private func systemRandomBytes(count: Int) -> Data? {
    var bytes = [UInt8](repeating: 0, count: count)
    let status = bytes.withUnsafeMutableBytes { buffer in
        SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
    }
    guard status == errSecSuccess else {
        return nil
    }
    return Data(bytes)
}

private func timingSafeEqual(_ lhs: Data, _ rhs: Data) -> Bool {
    guard lhs.count == rhs.count else { return false }
    return zip(lhs, rhs).reduce(UInt8(0)) { difference, pair in
        difference | (pair.0 ^ pair.1)
    } == 0
}

/// Runs only the fixture-only Keychain round trip. It does not activate Credential protection.
public func runExtendedKeychainProbe() -> ProbeResult {
    KeychainProbe(keychain: SecurityKeychainClient(), randomBytes: systemRandomBytes).run()
}
