import AppKit
import Foundation
import OxrailCredentialEnclave
import OxrailCredentialRegistry
import Security

package enum CredentialDemoErrorCode: String, Sendable {
    case unavailable = "UNAVAILABLE"
    case notAuthorized = "NOT_AUTHORIZED"
    case scopeMismatch = "SCOPE_MISMATCH"
    case expired = "EXPIRED"
    case revoked = "REVOKED"
    case internalError = "INTERNAL_ERROR"
}

public struct CredentialDemoResult: Equatable, Sendable {
    private enum Payload: Equatable, Sendable {
        case ready(String)
        case stored(String)
        case cancelled
        case error(CredentialDemoErrorCode)
    }

    private let payload: Payload

    package static func ready(_ reference: String) -> Self {
        validCredentialDemoReference(reference)
            ? Self(payload: .ready(reference))
            : .error(.internalError)
    }

    package static func stored(_ reference: String) -> Self {
        validCredentialDemoReference(reference)
            ? Self(payload: .stored(reference))
            : .error(.internalError)
    }

    package static let cancelled = Self(payload: .cancelled)

    package static func error(_ code: CredentialDemoErrorCode) -> Self {
        Self(payload: .error(code))
    }

    public static let invalidRequest = Self.error(.scopeMismatch)

    public var status: String {
        switch payload {
        case .ready: return "READY"
        case .stored: return "STORED"
        case .cancelled: return "CANCELLED"
        case .error: return "ERROR"
        }
    }

    public var credentialRef: String? {
        switch payload {
        case let .ready(reference), let .stored(reference): reference
        case .cancelled, .error: nil
        }
    }

    public var isFailure: Bool {
        if case .error = payload { return true }
        return false
    }

    public var jsonLine: String {
        switch payload {
        case let .ready(reference):
            #"{"schemaVersion":1,"status":"READY","credentialRef":"\#(reference)"}"#
        case let .stored(reference):
            #"{"schemaVersion":1,"status":"STORED","credentialRef":"\#(reference)"}"#
        case .cancelled:
            #"{"schemaVersion":1,"status":"CANCELLED"}"#
        case let .error(code):
            #"{"schemaVersion":1,"status":"ERROR","errorCode":"\#(code.rawValue)"}"#
        }
    }
}

package enum CredentialDemoDeleteResult {
    case removed
    case absent
    case failed
}

package protocol CredentialDemoKeychainClient: AnyObject {
    func add(reference: String, metadata: Data, secret: Data) -> Bool
    func metadata(reference: String) -> Data?
    func secret(reference: String) -> Data?
    func delete(reference: String) -> CredentialDemoDeleteResult
}

package protocol CredentialDemoPasteboardClient: AnyObject {
    func clearIfMatching(_ secret: Data) -> Bool
}

private struct CredentialDemoScopeBinding: Encodable {
    let credentialUseId: String
    let credentialKind: String
    let templateId: String
    let serviceId: String
    let provisioningOrigin: String
    let purposeId: String
    let consumerId: String
    let grantTtlSeconds: Int
    let generation: Int
    let registryVersion: Int
    let templateRegistryHash: String
    let consumerRegistryHash: String
    let registryManifestHash: String

    init(_ scope: CredentialReferenceScope) {
        credentialUseId = scope.credentialUseId
        credentialKind = scope.credentialKind
        templateId = scope.templateId
        serviceId = scope.serviceId
        provisioningOrigin = scope.provisioningOrigin
        purposeId = scope.purposeId
        consumerId = scope.consumerId
        grantTtlSeconds = scope.grantTtlSeconds
        generation = scope.generation
        registryVersion = scope.registryVersion
        templateRegistryHash = scope.templateRegistryHash
        consumerRegistryHash = scope.consumerRegistryHash
        registryManifestHash = scope.registryManifestHash
    }
}

private struct CredentialDemoMetadata {
    let issuedAt: Int
    let expiresAt: Int
    let scopeDigest: String

    var data: Data? {
        try? JSONSerialization.data(
            withJSONObject: [
                "schemaVersion": 1,
                "issuedAt": issuedAt,
                "expiresAt": expiresAt,
                "scopeDigest": scopeDigest,
            ],
            options: [.sortedKeys]
        )
    }

    init?(data: Data) {
        guard data.count <= 512,
              let object = try? JSONSerialization.jsonObject(with: data),
              let fields = object as? [String: Any],
              Set(fields.keys) == Set(["schemaVersion", "issuedAt", "expiresAt", "scopeDigest"]),
              fields["schemaVersion"] as? Int == 1,
              let issuedAt = fields["issuedAt"] as? Int,
              let expiresAt = fields["expiresAt"] as? Int,
              let scopeDigest = fields["scopeDigest"] as? String,
              issuedAt >= 0,
              expiresAt > issuedAt,
              isLowercaseCredentialDemoDigest(scopeDigest) else {
            return nil
        }
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.scopeDigest = scopeDigest
    }

    init(issuedAt: Int, expiresAt: Int, scopeDigest: String) {
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.scopeDigest = scopeDigest
    }
}

package final class CredentialDemoVault: CredentialSecretSink {
    private let keychain: any CredentialDemoKeychainClient
    private let pasteboard: any CredentialDemoPasteboardClient
    private let randomBytes: (Int) -> Data?
    private let now: () -> Int

    package init(
        keychain: any CredentialDemoKeychainClient,
        pasteboard: any CredentialDemoPasteboardClient,
        randomBytes: @escaping (Int) -> Data?,
        now: @escaping () -> Int
    ) {
        self.keychain = keychain
        self.pasteboard = pasteboard
        self.randomBytes = randomBytes
        self.now = now
    }

    package func storeFixtureSecret(_ secret: Data) -> CredentialDemoResult {
        guard isSyntheticCredentialDemoSecret(secret),
              let scope = embeddedCredentialReferenceScope(),
              let scopeDigest = credentialDemoScopeDigest(scope) else {
            return .error(.notAuthorized)
        }
        let issuedAt = now()
        let (expiresAt, overflow) = issuedAt.addingReportingOverflow(scope.grantTtlSeconds)
        guard issuedAt >= 0, !overflow, expiresAt > issuedAt,
              let metadata = CredentialDemoMetadata(
                  issuedAt: issuedAt,
                  expiresAt: expiresAt,
                  scopeDigest: scopeDigest
              ).data else {
            return .error(.internalError)
        }

        for _ in 0 ..< 3 {
            guard let bytes = randomBytes(32), bytes.count == 32 else {
                return .error(.unavailable)
            }
            let reference = "ocref1_" + credentialDemoBase64Url(bytes)
            guard validCredentialDemoReference(reference) else {
                return .error(.internalError)
            }
            if !keychain.add(reference: reference, metadata: metadata, secret: secret) {
                continue
            }
            guard pasteboard.clearIfMatching(secret) else {
                _ = keychain.delete(reference: reference)
                return .error(.unavailable)
            }
            return .stored(reference)
        }
        return .error(.unavailable)
    }

    package func store(_ secret: Data, scope: CredentialReferenceScope) -> String? {
        guard scope == embeddedCredentialReferenceScope() else { return nil }
        return storeFixtureSecret(secret).credentialRef
    }

    package func status(_ reference: String) -> CredentialDemoResult {
        validated(reference)
    }

    package func consume(_ reference: String) -> CredentialDemoResult {
        let validation = validated(reference)
        guard validation == .ready(reference) else { return validation }
        guard var secret = keychain.secret(reference: reference) else {
            return .error(.revoked)
        }
        defer { secret.resetBytes(in: 0 ..< secret.count) }
        guard isSyntheticCredentialDemoSecret(secret) else {
            _ = keychain.delete(reference: reference)
            return .error(.scopeMismatch)
        }
        return .ready(reference)
    }

    package func revoke(_ reference: String) -> CredentialDemoResult {
        guard validCredentialDemoReference(reference) else {
            return .error(.scopeMismatch)
        }
        switch keychain.delete(reference: reference) {
        case .removed: return .cancelled
        case .absent: return .error(.revoked)
        case .failed: return .error(.unavailable)
        }
    }

    private func validated(_ reference: String) -> CredentialDemoResult {
        guard validCredentialDemoReference(reference) else {
            return .error(.scopeMismatch)
        }
        guard let metadataData = keychain.metadata(reference: reference) else {
            return .error(.revoked)
        }
        guard let metadata = CredentialDemoMetadata(data: metadataData),
              let scope = embeddedCredentialReferenceScope(),
              let expectedDigest = credentialDemoScopeDigest(scope),
              metadata.scopeDigest == expectedDigest else {
            _ = keychain.delete(reference: reference)
            return .error(.scopeMismatch)
        }
        let observedAt = now()
        guard observedAt >= metadata.issuedAt else {
            return .error(.scopeMismatch)
        }
        if observedAt >= metadata.expiresAt {
            _ = keychain.delete(reference: reference)
            return .error(.expired)
        }
        return .ready(reference)
    }
}

private final class SecurityCredentialDemoKeychainClient: CredentialDemoKeychainClient {
    private let service = "dev.oxrail.fixture-only.credential-demo"

    func add(reference: String, metadata: Data, secret: Data) -> Bool {
        var query = baseQuery(reference)
        query[kSecAttrLabel as String] = "Oxrail synthetic credential demo"
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        query[kSecAttrGeneric as String] = metadata
        query[kSecValueData as String] = secret
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    func metadata(reference: String) -> Data? {
        var query = baseQuery(reference)
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnAttributes as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let attributes = result as? [String: Any] else {
            return nil
        }
        return attributes[kSecAttrGeneric as String] as? Data
    }

    func secret(reference: String) -> Data? {
        var query = baseQuery(reference)
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else {
            return nil
        }
        return result as? Data
    }

    func delete(reference: String) -> CredentialDemoDeleteResult {
        switch SecItemDelete(baseQuery(reference) as CFDictionary) {
        case errSecSuccess: return .removed
        case errSecItemNotFound: return .absent
        default: return .failed
        }
    }

    private func baseQuery(_ reference: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: reference,
            kSecAttrSynchronizable as String: false,
        ]
    }
}

private final class SystemCredentialDemoPasteboardClient: CredentialDemoPasteboardClient {
    func clearIfMatching(_ secret: Data) -> Bool {
        guard let string = NSPasteboard.general.string(forType: .string) else {
            return true
        }
        var candidate = Data(string.utf8)
        defer { candidate.resetBytes(in: 0 ..< candidate.count) }
        guard timingSafeCredentialDemoEqual(secret, candidate) else { return true }
        NSPasteboard.general.clearContents()
        guard let remaining = NSPasteboard.general.string(forType: .string) else {
            return true
        }
        var remainingData = Data(remaining.utf8)
        defer { remainingData.resetBytes(in: 0 ..< remainingData.count) }
        return !timingSafeCredentialDemoEqual(secret, remainingData)
    }
}

@MainActor
public func presentCredentialDemo() -> CredentialDemoResult {
    let vault = liveCredentialDemoVault()
    guard let surface = CredentialPromptSurface(
        credentialUseId: "fixture.publish.api-key",
        sink: vault
    ) else {
        return .error(.unavailable)
    }
    surface.alert.informativeText += "\nTrial only: enter oxrail_test_ followed by at least 16 letters or digits. Never enter a real credential."
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    application.activate(ignoringOtherApps: true)
    let response = surface.alert.runModal()
    let result = response == .alertFirstButtonReturn ? surface.submit() : surface.cancel()
    surface.alert.window.orderOut(nil)
    switch result {
    case let .stored(reference): return .stored(reference)
    case .cancelled: return .cancelled
    case .error(.unavailable): return .error(.unavailable)
    case .error(.internalError): return .error(.internalError)
    }
}

public func credentialDemoStatus(_ reference: String) -> CredentialDemoResult {
    liveCredentialDemoVault().status(reference)
}

public func consumeCredentialDemo(_ reference: String) -> CredentialDemoResult {
    liveCredentialDemoVault().consume(reference)
}

public func revokeCredentialDemo(_ reference: String) -> CredentialDemoResult {
    liveCredentialDemoVault().revoke(reference)
}

private func liveCredentialDemoVault() -> CredentialDemoVault {
    CredentialDemoVault(
        keychain: SecurityCredentialDemoKeychainClient(),
        pasteboard: SystemCredentialDemoPasteboardClient(),
        randomBytes: credentialDemoRandomBytes,
        now: { Int(Date().timeIntervalSince1970) }
    )
}

private func credentialDemoScopeDigest(_ scope: CredentialReferenceScope) -> String? {
    credentialRegistryDigest(
        domain: "oxrail-credential-demo-scope-v1",
        value: CredentialDemoScopeBinding(scope)
    )
}

private func credentialDemoRandomBytes(_ count: Int) -> Data? {
    guard count == 32 else { return nil }
    var bytes = [UInt8](repeating: 0, count: count)
    let status = bytes.withUnsafeMutableBytes {
        SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!)
    }
    return status == errSecSuccess ? Data(bytes) : nil
}

private func credentialDemoBase64Url(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

private func validCredentialDemoReference(_ reference: String) -> Bool {
    reference.wholeMatch(of: #/^ocref1_[A-Za-z0-9_-]{43}$/#) != nil
}

private func isSyntheticCredentialDemoSecret(_ secret: Data) -> Bool {
    let prefix = Array("oxrail_test_".utf8)
    guard secret.starts(with: prefix),
          secret.count >= prefix.count + 16,
          secret.count <= prefix.count + 128 else {
        return false
    }
    return secret.dropFirst(prefix.count).allSatisfy {
        ($0 >= 48 && $0 <= 57) ||
            ($0 >= 65 && $0 <= 90) ||
            ($0 >= 97 && $0 <= 122) ||
            $0 == 45 || $0 == 95
    }
}

private func isLowercaseCredentialDemoDigest(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy {
        ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102)
    }
}

private func timingSafeCredentialDemoEqual(_ lhs: Data, _ rhs: Data) -> Bool {
    guard lhs.count == rhs.count else { return false }
    return zip(lhs, rhs).reduce(UInt8(0)) { difference, pair in
        difference | (pair.0 ^ pair.1)
    } == 0
}
