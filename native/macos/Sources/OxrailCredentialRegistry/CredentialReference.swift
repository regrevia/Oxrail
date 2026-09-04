import Foundation
import Security

public enum CredentialReferenceLifecycleScope: String, Sendable {
    case opaqueReferenceLifecycleOnly = "OPAQUE_REFERENCE_LIFECYCLE_ONLY"
}

public struct CredentialReferenceLifecycleReport: Equatable, Sendable {
    public let schemaVersion = 1
    public let authority = CredentialRegistryAuthority.fixtureOnlyNonAuthorizing
    public let scope = CredentialReferenceLifecycleScope.opaqueReferenceLifecycleOnly
    public let status: CredentialRegistryStatus
    public let activation = CredentialRegistryActivation.inactive
    public let credentialKind = "API_KEY"
    public let consumerReadiness = "FIXTURE_ONLY"
    public let registryVersion: Int?
    public let templateRegistryHash: String?
    public let consumerRegistryHash: String?
    public let registryManifestHash: String?

    fileprivate init(
        status: CredentialRegistryStatus,
        registryVersion: Int? = nil,
        templateRegistryHash: String? = nil,
        consumerRegistryHash: String? = nil,
        registryManifestHash: String? = nil
    ) {
        self.status = status
        self.registryVersion = registryVersion
        self.templateRegistryHash = templateRegistryHash
        self.consumerRegistryHash = consumerRegistryHash
        self.registryManifestHash = registryManifestHash
    }
}

struct CredentialReferenceScope: Equatable {
    var credentialUseId: String
    var credentialKind: String
    var templateId: String
    var serviceId: String
    var provisioningOrigin: String
    var purposeId: String
    var consumerId: String
    var grantTtlSeconds: Int
    var generation: Int
    var registryVersion: Int
    var templateRegistryHash: String
    var consumerRegistryHash: String
    var registryManifestHash: String
}

enum FixtureCredentialReferenceUse: Equatable {
    case matchedNonAuthorizing
    case denied
}

private enum FixtureCredentialReferenceState {
    case active
    case expired
    case revoked
    case spent
}

private struct FixtureCredentialReferenceRecord {
    let scope: CredentialReferenceScope
    let issuedAt: Int
    let expiresAt: Int
    var state: FixtureCredentialReferenceState
}

final class FixtureCredentialReferenceStore: @unchecked Sendable {
    private let lock = NSLock()
    private var records: [String: FixtureCredentialReferenceRecord] = [:]

    func issue(
        scope: CredentialReferenceScope,
        now: Int,
        randomBytes: (Int) -> Data?
    ) -> String? {
        guard let embeddedScope = embeddedCredentialReferenceScope(),
              scope == embeddedScope,
              now >= 0 else { return nil }
        let (expiresAt, overflow) = now.addingReportingOverflow(scope.grantTtlSeconds)
        guard !overflow,
              expiresAt > now,
              let bytes = randomBytes(32),
              bytes.count == 32 else {
            return nil
        }

        let reference = "ocref1_" + base64Url(bytes)
        guard validCredentialReference(reference) else { return nil }

        lock.lock()
        defer { lock.unlock() }
        guard records[reference] == nil else { return nil }
        records[reference] = FixtureCredentialReferenceRecord(
            scope: scope,
            issuedAt: now,
            expiresAt: expiresAt,
            state: .active
        )
        return reference
    }

    func evaluateAndSpend(
        _ reference: String,
        expectedScope: CredentialReferenceScope,
        now: Int
    ) -> FixtureCredentialReferenceUse {
        guard validCredentialReference(reference),
              now >= 0,
              let embeddedScope = embeddedCredentialReferenceScope(),
              expectedScope == embeddedScope else {
            return .denied
        }

        lock.lock()
        defer { lock.unlock() }
        guard var record = records[reference],
              record.state == .active,
              record.scope == embeddedScope,
              record.scope == expectedScope else {
            return .denied
        }
        if now >= record.expiresAt {
            record.state = .expired
            records[reference] = record
            return .denied
        }
        guard now >= record.issuedAt else { return .denied }
        record.state = .spent
        records[reference] = record
        return .matchedNonAuthorizing
    }

    @discardableResult
    func revoke(_ reference: String) -> Bool {
        guard validCredentialReference(reference) else { return false }
        lock.lock()
        defer { lock.unlock() }
        guard var record = records[reference],
              record.state == .active else {
            return false
        }
        record.state = .revoked
        records[reference] = record
        return true
    }
}

func embeddedCredentialReferenceScope() -> CredentialReferenceScope? {
    let bundle = embeddedFixtureCredentialRegistry()
    guard evaluateCredentialRegistry(bundle).status == .matchedFixtureNonAuthorizing,
          bundle.templateRegistry.templates.count == 1,
          bundle.consumerRegistry.consumers.count == 1,
          let template = bundle.templateRegistry.templates.first,
          let consumer = bundle.consumerRegistry.consumers.first,
          template.consumerId == consumer.consumerId,
          template.serviceId == consumer.serviceId,
          template.provisioningOrigin == consumer.tlsOrigin else {
        return nil
    }
    return CredentialReferenceScope(
        credentialUseId: template.credentialUseId,
        credentialKind: template.credentialKind,
        templateId: template.templateId,
        serviceId: template.serviceId,
        provisioningOrigin: template.provisioningOrigin,
        purposeId: template.purposeId,
        consumerId: template.consumerId,
        grantTtlSeconds: template.grantTtlSeconds,
        generation: template.generation,
        registryVersion: bundle.manifest.registryVersion,
        templateRegistryHash: bundle.manifest.templateRegistryHash,
        consumerRegistryHash: bundle.manifest.consumerRegistryHash,
        registryManifestHash: bundle.registryManifestHash
    )
}

func evaluateEmbeddedCredentialReferenceLifecycle(
    randomBytes: (Int) -> Data?
) -> CredentialReferenceLifecycleReport {
    guard let scope = embeddedCredentialReferenceScope() else {
        return CredentialReferenceLifecycleReport(status: .inactive)
    }
    let store = FixtureCredentialReferenceStore()
    guard let reference = store.issue(scope: scope, now: 0, randomBytes: randomBytes),
          store.evaluateAndSpend(reference, expectedScope: scope, now: 0) == .matchedNonAuthorizing,
          store.evaluateAndSpend(reference, expectedScope: scope, now: 0) == .denied else {
        return CredentialReferenceLifecycleReport(status: .inactive)
    }
    return CredentialReferenceLifecycleReport(
        status: .matchedFixtureNonAuthorizing,
        registryVersion: scope.registryVersion,
        templateRegistryHash: scope.templateRegistryHash,
        consumerRegistryHash: scope.consumerRegistryHash,
        registryManifestHash: scope.registryManifestHash
    )
}

private func base64Url(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

private func validCredentialReference(_ reference: String) -> Bool {
    let prefix = "ocref1_"
    guard reference.hasPrefix(prefix) else { return false }
    let suffix = reference.dropFirst(prefix.count).utf8
    return suffix.count == 43 && suffix.allSatisfy {
        ($0 >= 48 && $0 <= 57) ||
            ($0 >= 65 && $0 <= 90) ||
            ($0 >= 97 && $0 <= 122) ||
            $0 == 45 || $0 == 95
    }
}

private func systemCredentialReferenceRandomBytes(count: Int) -> Data? {
    guard count == 32 else { return nil }
    var bytes = [UInt8](repeating: 0, count: count)
    let status = bytes.withUnsafeMutableBytes { buffer in
        SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
    }
    return status == errSecSuccess ? Data(bytes) : nil
}

/// Checks only the in-memory fixture reference lifecycle. It never carries a credential or authority.
public func runEmbeddedCredentialReferenceLifecycleObservation() -> CredentialReferenceLifecycleReport {
    evaluateEmbeddedCredentialReferenceLifecycle(randomBytes: systemCredentialReferenceRandomBytes)
}
