import AppKit
import Foundation
import OxrailCredentialRegistry

public enum CredentialEnclaveAuthority: String, Sendable {
    case fixtureOnlyNonAuthorizing = "FIXTURE_ONLY_NON_AUTHORIZING"
}

public enum CredentialEnclaveScope: String, Sendable {
    case secureFieldBoundaryOnly = "SECURE_FIELD_BOUNDARY_ONLY"
}

public enum CredentialEnclaveStatus: String, Sendable {
    case matchedFixtureNonAuthorizing = "MATCHED_FIXTURE_NON_AUTHORIZING"
    case inactive = "INACTIVE"
}

public struct CredentialEnclaveObservation: Equatable, Sendable {
    public let schemaVersion = 1
    public let authority = CredentialEnclaveAuthority.fixtureOnlyNonAuthorizing
    public let scope = CredentialEnclaveScope.secureFieldBoundaryOnly
    public let status: CredentialEnclaveStatus
    public let activation = "INACTIVE"
    public let surface = "NSSecureTextField"
    public let presentation = "NOT_PRESENTED"
    public let storage = "UNAVAILABLE"

    fileprivate init(status: CredentialEnclaveStatus) {
        self.status = status
    }
}

enum CredentialPromptBoundaryError: String, Equatable {
    case internalError = "INTERNAL_ERROR"
    case unavailable = "UNAVAILABLE"
}

enum CredentialPromptBoundaryResult: Equatable {
    case stored(credentialRef: String)
    case cancelled
    case error(CredentialPromptBoundaryError)
}

protocol CredentialSecretSink: AnyObject {
    func store(_ secret: Data, scope: CredentialReferenceScope) -> String?
}

private final class UnavailableCredentialSecretSink: CredentialSecretSink {
    func store(_ secret: Data, scope: CredentialReferenceScope) -> String? { nil }
}

@MainActor
final class CredentialPromptSurface {
    static let maximumSecretBytes = 16_384

    let alert: NSAlert
    let secureField: NSSecureTextField
    let scope: CredentialReferenceScope

    private let sink: any CredentialSecretSink

    init?(credentialUseId: String, sink: any CredentialSecretSink) {
        guard let descriptor = embeddedCredentialPromptDescriptor(for: credentialUseId) else {
            return nil
        }
        self.sink = sink
        scope = descriptor.scope

        secureField = NSSecureTextField(
            frame: NSRect(x: 0, y: 0, width: 360, height: 24)
        )
        secureField.placeholderString = descriptor.fieldLabel
        secureField.setAccessibilityLabel(descriptor.fieldLabel)

        let fieldLabel = NSTextField(labelWithString: descriptor.fieldLabel)
        let warning = NSTextField(labelWithString: descriptor.pasteboardWarning)
        warning.maximumNumberOfLines = 2
        warning.lineBreakMode = .byWordWrapping
        let stack = NSStackView(views: [fieldLabel, secureField, warning])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.frame = NSRect(x: 0, y: 0, width: 360, height: 88)

        alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = descriptor.windowTitle
        alert.informativeText = "\(descriptor.siteLabel)\n\(descriptor.purposeLabel)"
        alert.accessoryView = stack
        alert.addButton(withTitle: descriptor.submitLabel)
        alert.addButton(withTitle: descriptor.cancelLabel)
    }

    func submit() -> CredentialPromptBoundaryResult {
        var candidate = secureField.stringValue
        secureField.stringValue = ""
        defer { candidate.removeAll(keepingCapacity: false) }
        guard !candidate.isEmpty,
              candidate.utf8.count <= Self.maximumSecretBytes,
              !candidate.unicodeScalars.contains(where: {
                  CharacterSet.controlCharacters.contains($0)
              }) else {
            return .error(.internalError)
        }

        var secret = Data(candidate.utf8)
        defer { secret.resetBytes(in: 0 ..< secret.count) }
        guard let credentialRef = sink.store(secret, scope: scope) else {
            return .error(.unavailable)
        }
        guard credentialRef.wholeMatch(of: #/^ocref1_[A-Za-z0-9_-]{43}$/#) != nil else {
            return .error(.internalError)
        }
        return .stored(credentialRef: credentialRef)
    }

    func cancel() -> CredentialPromptBoundaryResult {
        secureField.stringValue = ""
        return .cancelled
    }
}

/// Builds but never presents the fixed fixture surface. It cannot store a credential or activate protection.
@MainActor
public func runEmbeddedCredentialEnclaveObservation() -> CredentialEnclaveObservation {
    guard CredentialPromptSurface(
        credentialUseId: "fixture.publish.api-key",
        sink: UnavailableCredentialSecretSink()
    ) != nil else {
        return CredentialEnclaveObservation(status: .inactive)
    }
    return CredentialEnclaveObservation(status: .matchedFixtureNonAuthorizing)
}
