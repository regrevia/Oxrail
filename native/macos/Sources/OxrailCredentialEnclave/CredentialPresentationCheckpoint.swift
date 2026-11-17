import Foundation
import OxrailCredentialRegistry

private let maximumSafeJSONInteger = 9_007_199_254_740_991
private let maximumCredentialTicketBytes = 16_384
private let credentialTicketKeys: Set<String> = [
    "authority", "consumerId", "consumerRegistryHash", "credentialKind",
    "credentialUseId", "generation", "grantTtlSeconds", "handoff", "issuedAt",
    "provisioningOrigin", "purposeId", "registryManifestHash", "registryVersion",
    "schemaVersion", "serviceId", "templateId", "templateRegistryHash", "ticketId",
]
private let credentialTicketHandoffKeys: Set<String> = [
    "acquiredAt", "activationAnchorHash", "expiresAt", "leaseEpoch",
]

struct CredentialTicketHandoff: Codable {
    let activationAnchorHash: String
    let leaseEpoch: Int
    let acquiredAt: Int
    let expiresAt: Int
}

struct CredentialTicketV2: Codable {
    let schemaVersion: Int
    let authority: String
    let ticketId: String
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
    let issuedAt: Int
    let handoff: CredentialTicketHandoff
}

private struct CredentialTicketRegistryEntry: Encodable {
    let schemaVersion: Int
    let credentialUseId: String
    let credentialKind: String
    let templateId: String
    let serviceId: String
    let provisioningOrigin: String
    let purposeId: String
    let consumerId: String
    let grantTtlSeconds: Int
    let generation: Int
    let readiness: String
    let registryVersion: Int
    let templateRegistryHash: String
    let consumerRegistryHash: String
    let registryManifestHash: String
}

private struct CredentialTicketIdPayload: Encodable {
    let entry: CredentialTicketRegistryEntry
    let handoff: CredentialTicketHandoff
    let issuedAt: Int
}

private struct CredentialPromptContextPayload: Encodable {
    let observedAt: Int
    let ticket: CredentialTicketV2
}

struct FixtureCredentialPresentationCheckpoint: Equatable, Sendable {
    let schemaVersion = 1
    let authority = CredentialEnclaveAuthority.fixtureOnlyNonAuthorizing
    let activation = "INACTIVE"
    let authorization = "NOT_AUTHORIZED"
    let hostSuspension = "UNVERIFIED"
    let presentation = "NOT_PRESENTED"
    let credentialUseId: String
    let leaseExpiresAt: Int
    let promptContextHash: String
    let scope: CredentialReferenceScope
}

private func isLowercaseSHA256(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy {
        ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102)
    }
}

private func isSafeJSONInteger(_ value: Int, positive: Bool = false) -> Bool {
    value >= (positive ? 1 : 0) && value <= maximumSafeJSONInteger
}

private func hasStrictCredentialTicketShape(_ data: Data) -> Bool {
    guard let object = try? JSONSerialization.jsonObject(with: data),
          let ticket = object as? [String: Any],
          Set(ticket.keys) == credentialTicketKeys,
          let handoff = ticket["handoff"] as? [String: Any],
          Set(handoff.keys) == credentialTicketHandoffKeys else {
        return false
    }
    return true
}

private func matchesEmbeddedScope(
    _ ticket: CredentialTicketV2,
    scope: CredentialReferenceScope
) -> Bool {
    ticket.credentialUseId == scope.credentialUseId &&
        ticket.credentialKind == scope.credentialKind &&
        ticket.templateId == scope.templateId &&
        ticket.serviceId == scope.serviceId &&
        ticket.provisioningOrigin == scope.provisioningOrigin &&
        ticket.purposeId == scope.purposeId &&
        ticket.consumerId == scope.consumerId &&
        ticket.grantTtlSeconds == scope.grantTtlSeconds &&
        ticket.generation == scope.generation &&
        ticket.registryVersion == scope.registryVersion &&
        ticket.templateRegistryHash == scope.templateRegistryHash &&
        ticket.consumerRegistryHash == scope.consumerRegistryHash &&
        ticket.registryManifestHash == scope.registryManifestHash
}

private func registryEntry(for ticket: CredentialTicketV2) -> CredentialTicketRegistryEntry {
    CredentialTicketRegistryEntry(
        schemaVersion: 1,
        credentialUseId: ticket.credentialUseId,
        credentialKind: ticket.credentialKind,
        templateId: ticket.templateId,
        serviceId: ticket.serviceId,
        provisioningOrigin: ticket.provisioningOrigin,
        purposeId: ticket.purposeId,
        consumerId: ticket.consumerId,
        grantTtlSeconds: ticket.grantTtlSeconds,
        generation: ticket.generation,
        readiness: "FIXTURE_ONLY",
        registryVersion: ticket.registryVersion,
        templateRegistryHash: ticket.templateRegistryHash,
        consumerRegistryHash: ticket.consumerRegistryHash,
        registryManifestHash: ticket.registryManifestHash
    )
}

func credentialTicketIdentifier(for ticket: CredentialTicketV2) -> String? {
    credentialRegistryDigest(
        domain: "oxrail-credential-fixture-ticket-v2",
        value: CredentialTicketIdPayload(
            entry: registryEntry(for: ticket),
            handoff: ticket.handoff,
            issuedAt: ticket.issuedAt
        )
    ).map { "oct1_\($0)" }
}

/// Validates only a secret-free fixture ticket. It cannot present UI or authorize credential use.
func checkpointCredentialPresentation(
    candidateJSON: Data,
    observedAt: Int
) -> FixtureCredentialPresentationCheckpoint? {
    guard !candidateJSON.isEmpty,
          candidateJSON.count <= maximumCredentialTicketBytes,
          isSafeJSONInteger(observedAt),
          hasStrictCredentialTicketShape(candidateJSON),
          let ticket = try? JSONDecoder().decode(CredentialTicketV2.self, from: candidateJSON),
          ticket.schemaVersion == 2,
          ticket.authority == "FIXTURE_ONLY_NON_AUTHORIZING",
          ticket.ticketId.hasPrefix("oct1_"),
          isLowercaseSHA256(String(ticket.ticketId.dropFirst(5))),
          isLowercaseSHA256(ticket.handoff.activationAnchorHash),
          isSafeJSONInteger(ticket.handoff.leaseEpoch, positive: true),
          isSafeJSONInteger(ticket.handoff.acquiredAt),
          isSafeJSONInteger(ticket.handoff.expiresAt),
          isSafeJSONInteger(ticket.issuedAt),
          ticket.handoff.expiresAt > ticket.handoff.acquiredAt,
          ticket.issuedAt >= ticket.handoff.acquiredAt,
          observedAt >= ticket.issuedAt,
          observedAt <= ticket.handoff.expiresAt,
          let scope = embeddedCredentialReferenceScope(),
          matchesEmbeddedScope(ticket, scope: scope) else {
        return nil
    }

    guard credentialTicketIdentifier(for: ticket) == ticket.ticketId,
          let promptContextHash = credentialRegistryDigest(
        domain: "oxrail-credential-prompt-context-v1",
        value: CredentialPromptContextPayload(observedAt: observedAt, ticket: ticket)
    ) else {
        return nil
    }

    return FixtureCredentialPresentationCheckpoint(
        credentialUseId: scope.credentialUseId,
        leaseExpiresAt: ticket.handoff.expiresAt,
        promptContextHash: promptContextHash,
        scope: scope
    )
}
