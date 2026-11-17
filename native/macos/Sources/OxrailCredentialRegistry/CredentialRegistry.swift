import CryptoKit
import Foundation

public enum CredentialRegistryAuthority: String, Sendable {
    case fixtureOnlyNonAuthorizing = "FIXTURE_ONLY_NON_AUTHORIZING"
}

public enum CredentialRegistryScope: String, Sendable {
    case registryStructureOnly = "REGISTRY_STRUCTURE_ONLY"
}

public enum CredentialRegistryStatus: String, Sendable {
    case matchedFixtureNonAuthorizing = "MATCHED_FIXTURE_NON_AUTHORIZING"
    case inactive = "INACTIVE"
}

public enum CredentialRegistryActivation: String, Sendable {
    case inactive = "INACTIVE"
}

public struct CredentialRegistryReport: Equatable, Sendable {
    public let schemaVersion = 1
    public let authority = CredentialRegistryAuthority.fixtureOnlyNonAuthorizing
    public let scope = CredentialRegistryScope.registryStructureOnly
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

struct CredentialTemplate: Encodable, Equatable {
    var schemaVersion: Int
    var credentialUseId: String
    var credentialKind: String
    var templateId: String
    var serviceId: String
    var provisioningOrigin: String
    var purposeId: String
    var consumerId: String
    var grantTtlSeconds: Int
    var generation: Int
    var secureFieldClass: String
    var windowTitle: String
    var siteLabel: String
    var purposeLabel: String
    var fieldLabel: String
    var submitLabel: String
    var cancelLabel: String
    var pasteboardWarning: String
}

struct CredentialTemplateRegistry: Encodable, Equatable {
    var schemaVersion: Int
    var registryVersion: Int
    var readiness: String
    var templates: [CredentialTemplate]
}

struct CredentialConsumer: Encodable, Equatable {
    var schemaVersion: Int
    var consumerId: String
    var serviceId: String
    var tlsOrigin: String
    var path: String
    var method: String
    var credentialPlacement: String
    var followsRedirects: Bool
    var requestShape: String
    var outputSchema: String
}

struct CredentialConsumerRegistry: Encodable, Equatable {
    var schemaVersion: Int
    var registryVersion: Int
    var readiness: String
    var consumers: [CredentialConsumer]
}

struct CredentialRegistryManifest: Encodable, Equatable {
    var schemaVersion: Int
    var authority: String
    var registryVersion: Int
    var templateRegistryHash: String
    var consumerRegistryHash: String
}

struct CredentialRegistryBundle: Equatable {
    var templateRegistry: CredentialTemplateRegistry
    var consumerRegistry: CredentialConsumerRegistry
    var manifest: CredentialRegistryManifest
    var registryManifestHash: String
}

package struct EmbeddedCredentialPromptDescriptor: Equatable, Sendable {
    package let scope: CredentialReferenceScope
    package let windowTitle: String
    package let siteLabel: String
    package let purposeLabel: String
    package let fieldLabel: String
    package let submitLabel: String
    package let cancelLabel: String
    package let pasteboardWarning: String
}

package func credentialRegistryDigest<Value: Encodable>(
    domain: String,
    value: Value
) -> String? {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard !domain.isEmpty, !domain.contains("\0"), let encoded = try? encoder.encode(value) else {
        return nil
    }
    var input = Data(domain.utf8)
    input.append(0)
    input.append(encoded)
    return SHA256.hash(data: input).map { String(format: "%02x", $0) }.joined()
}

func evaluateCredentialRegistry(_ bundle: CredentialRegistryBundle) -> CredentialRegistryReport {
    guard bundle == embeddedFixtureCredentialRegistry(),
          credentialRegistryDigest(
              domain: "oxrail-credential-template-registry-v1",
              value: bundle.templateRegistry
          ) == bundle.manifest.templateRegistryHash,
          credentialRegistryDigest(
              domain: "oxrail-credential-consumer-registry-v1",
              value: bundle.consumerRegistry
          ) == bundle.manifest.consumerRegistryHash,
          credentialRegistryDigest(
              domain: "oxrail-credential-registry-manifest-v1",
              value: bundle.manifest
          ) == bundle.registryManifestHash else {
        return CredentialRegistryReport(status: .inactive)
    }

    return CredentialRegistryReport(
        status: .matchedFixtureNonAuthorizing,
        registryVersion: bundle.manifest.registryVersion,
        templateRegistryHash: bundle.manifest.templateRegistryHash,
        consumerRegistryHash: bundle.manifest.consumerRegistryHash,
        registryManifestHash: bundle.registryManifestHash
    )
}

func embeddedFixtureCredentialRegistry() -> CredentialRegistryBundle {
    CredentialRegistryBundle(
        templateRegistry: CredentialTemplateRegistry(
            schemaVersion: 1,
            registryVersion: 1,
            readiness: "FIXTURE_ONLY",
            templates: [
                CredentialTemplate(
                    schemaVersion: 1,
                    credentialUseId: "fixture.publish.api-key",
                    credentialKind: "API_KEY",
                    templateId: "fixture.api-key.v1",
                    serviceId: "fixture-service",
                    provisioningOrigin: "https://credentials.example.test",
                    purposeId: "publish-post",
                    consumerId: "fixture.https.publisher",
                    grantTtlSeconds: 3_600,
                    generation: 1,
                    secureFieldClass: "NSSecureTextField",
                    windowTitle: "Oxrail Secure API Key",
                    siteLabel: "credentials.example.test",
                    purposeLabel: "Controlled credential fixture",
                    fieldLabel: "API key",
                    submitLabel: "Save securely",
                    cancelLabel: "Cancel",
                    pasteboardWarning: "Third-party clipboard managers are unsupported."
                ),
            ]
        ),
        consumerRegistry: CredentialConsumerRegistry(
            schemaVersion: 1,
            registryVersion: 1,
            readiness: "FIXTURE_ONLY",
            consumers: [
                CredentialConsumer(
                    schemaVersion: 1,
                    consumerId: "fixture.https.publisher",
                    serviceId: "fixture-service",
                    tlsOrigin: "https://credentials.example.test",
                    path: "/v1/credential-probe",
                    method: "POST",
                    credentialPlacement: "AUTHORIZATION_BEARER",
                    followsRedirects: false,
                    requestShape: "FIXTURE_PROBE_V1",
                    outputSchema: "FIXTURE_BOOLEAN_V1"
                ),
            ]
        ),
        manifest: CredentialRegistryManifest(
            schemaVersion: 1,
            authority: "FIXTURE_ONLY_NON_AUTHORIZING",
            registryVersion: 1,
            templateRegistryHash: "b01287454e5727a721e941b00e6d5bf2b6a0c89c47cfb3f9edcad5820e970cdd",
            consumerRegistryHash: "71e4b865818705e073c556f3adea9bb296fe359f0385cb48ec6054862347b1be"
        ),
        registryManifestHash: "2fd54c5c4bf0672d670323d3bb181aa185ebfdec8667baedb69e13222790e4d7"
    )
}

package func embeddedCredentialPromptDescriptor(
    for credentialUseId: String
) -> EmbeddedCredentialPromptDescriptor? {
    let bundle = embeddedFixtureCredentialRegistry()
    guard let scope = embeddedCredentialReferenceScope(),
          credentialUseId.utf8.count <= 256,
          evaluateCredentialRegistry(bundle).status == .matchedFixtureNonAuthorizing,
          bundle.templateRegistry.templates.count == 1,
          let template = bundle.templateRegistry.templates.first,
          template.credentialUseId == credentialUseId,
          scope.credentialUseId == credentialUseId,
          template.secureFieldClass == "NSSecureTextField" else {
        return nil
    }
    return EmbeddedCredentialPromptDescriptor(
        scope: scope,
        windowTitle: template.windowTitle,
        siteLabel: template.siteLabel,
        purposeLabel: template.purposeLabel,
        fieldLabel: template.fieldLabel,
        submitLabel: template.submitLabel,
        cancelLabel: template.cancelLabel,
        pasteboardWarning: template.pasteboardWarning
    )
}

/// Verifies only the build-fixed fixture registry structure. It never authorizes Credential use.
public func runEmbeddedCredentialRegistryObservation() -> CredentialRegistryReport {
    evaluateCredentialRegistry(embeddedFixtureCredentialRegistry())
}
