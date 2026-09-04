import AppKit
import Foundation
import OxrailCredentialRegistry
import XCTest
@testable import OxrailCredentialEnclave

@MainActor
final class CredentialEnclaveTests: XCTestCase {
    private let credentialRef = "ocref1_" + String(repeating: "A", count: 43)

    func testObservationBuildsOneInertSecureFieldWithoutActivation() throws {
        let report = runEmbeddedCredentialEnclaveObservation()

        XCTAssertEqual(report.schemaVersion, 1)
        XCTAssertEqual(report.authority, .fixtureOnlyNonAuthorizing)
        XCTAssertEqual(report.scope, .secureFieldBoundaryOnly)
        XCTAssertEqual(report.status, .matchedFixtureNonAuthorizing)
        XCTAssertEqual(report.activation, "INACTIVE")
        XCTAssertEqual(report.surface, "NSSecureTextField")
        XCTAssertEqual(report.presentation, "NOT_PRESENTED")
        XCTAssertEqual(report.storage, "UNAVAILABLE")
        XCTAssertEqual(
            Set(Mirror(reflecting: report).children.compactMap { $0.label }),
            [
                "schemaVersion", "authority", "scope", "status", "activation",
                "surface", "presentation", "storage",
            ]
        )

        let sink = FakeSink(credentialRef: credentialRef)
        let surface = try XCTUnwrap(
            CredentialPromptSurface(
                credentialUseId: "fixture.publish.api-key",
                sink: sink
            )
        )
        XCTAssertEqual(secureFields(in: try XCTUnwrap(surface.alert.accessoryView)).count, 1)
        XCTAssertTrue(surface.secureField is NSSecureTextField)
        XCTAssertEqual(surface.alert.buttons.count, 2)
        XCTAssertEqual(sink.callCount, 0)
    }

    func testOnlyTheEmbeddedIdCanConstructTheFixedSurface() throws {
        let sink = FakeSink(credentialRef: credentialRef)
        XCTAssertNil(CredentialPromptSurface(credentialUseId: "unknown", sink: sink))

        let surface = try XCTUnwrap(
            CredentialPromptSurface(
                credentialUseId: "fixture.publish.api-key",
                sink: sink
            )
        )
        XCTAssertEqual(surface.alert.messageText, "Oxrail Secure API Key")
        XCTAssertEqual(
            surface.alert.informativeText,
            "credentials.example.test\nControlled credential fixture"
        )
        XCTAssertEqual(surface.secureField.placeholderString, "API key")
        XCTAssertEqual(surface.secureField.accessibilityLabel(), "API key")
        XCTAssertEqual(surface.alert.buttons.map(\.title), ["Save securely", "Cancel"])
        XCTAssertTrue(
            textFields(in: try XCTUnwrap(surface.alert.accessoryView))
                .contains { $0.stringValue == "Third-party clipboard managers are unsupported." }
        )
        XCTAssertEqual(surface.scope.credentialUseId, "fixture.publish.api-key")
        XCTAssertEqual(surface.scope.credentialKind, "API_KEY")
        XCTAssertEqual(surface.scope.templateId, "fixture.api-key.v1")
        XCTAssertEqual(surface.scope.serviceId, "fixture-service")
        XCTAssertEqual(surface.scope.provisioningOrigin, "https://credentials.example.test")
        XCTAssertEqual(surface.scope.purposeId, "publish-post")
        XCTAssertEqual(surface.scope.consumerId, "fixture.https.publisher")
        XCTAssertEqual(surface.scope.grantTtlSeconds, 3_600)
        XCTAssertEqual(surface.scope.generation, 1)
        XCTAssertEqual(surface.scope.registryVersion, 1)
        XCTAssertEqual(
            surface.scope.templateRegistryHash,
            "b01287454e5727a721e941b00e6d5bf2b6a0c89c47cfb3f9edcad5820e970cdd"
        )
        XCTAssertEqual(
            surface.scope.consumerRegistryHash,
            "71e4b865818705e073c556f3adea9bb296fe359f0385cb48ec6054862347b1be"
        )
        XCTAssertEqual(
            surface.scope.registryManifestHash,
            "2fd54c5c4bf0672d670323d3bb181aa185ebfdec8667baedb69e13222790e4d7"
        )
        XCTAssertEqual(sink.callCount, 0)
    }

    func testSubmitConfinesTheSecretToTheSinkAndClearsTheField() throws {
        let sink = FakeSink(
            credentialRef: credentialRef,
            expectedSecret: Data("fixture_api_key_canary".utf8)
        )
        let surface = try XCTUnwrap(
            CredentialPromptSurface(
                credentialUseId: "fixture.publish.api-key",
                sink: sink
            )
        )
        let canary = "fixture_api_key_canary"
        surface.secureField.stringValue = canary

        let result = surface.submit()

        XCTAssertEqual(result, .stored(credentialRef: credentialRef))
        XCTAssertEqual(surface.secureField.stringValue, "")
        XCTAssertEqual(sink.callCount, 1)
        XCTAssertEqual(sink.matchedExpectedSecret, true)
        XCTAssertEqual(sink.receivedScope, surface.scope)
        XCTAssertFalse(String(reflecting: result).contains(canary))
    }

    func testEveryRejectedPathClearsWithoutCallingOrLeakingTheSink() throws {
        let sink = FakeSink(credentialRef: credentialRef)
        let surface = try XCTUnwrap(
            CredentialPromptSurface(
                credentialUseId: "fixture.publish.api-key",
                sink: sink
            )
        )
        for candidate in [
            "",
            "line\nbreak",
            String(repeating: "a", count: CredentialPromptSurface.maximumSecretBytes + 1),
        ] {
            surface.secureField.stringValue = candidate
            XCTAssertEqual(surface.submit(), .error(.internalError))
            XCTAssertEqual(surface.secureField.stringValue, "")
        }
        XCTAssertEqual(sink.callCount, 0)

        let unavailable = FakeSink(
            credentialRef: nil,
            expectedSecret: Data("fixture_failure_canary".utf8)
        )
        let unavailableSurface = try XCTUnwrap(
            CredentialPromptSurface(
                credentialUseId: "fixture.publish.api-key",
                sink: unavailable
            )
        )
        unavailableSurface.secureField.stringValue = "fixture_failure_canary"
        XCTAssertEqual(unavailableSurface.submit(), .error(.unavailable))
        XCTAssertEqual(unavailableSurface.secureField.stringValue, "")
        XCTAssertEqual(unavailable.callCount, 1)
        XCTAssertEqual(unavailable.matchedExpectedSecret, true)

        let malformed = FakeSink(
            credentialRef: "not-a-reference",
            expectedSecret: Data("fixture_malformed_ref_canary".utf8)
        )
        let malformedSurface = try XCTUnwrap(
            CredentialPromptSurface(
                credentialUseId: "fixture.publish.api-key",
                sink: malformed
            )
        )
        malformedSurface.secureField.stringValue = "fixture_malformed_ref_canary"
        XCTAssertEqual(malformedSurface.submit(), .error(.internalError))
        XCTAssertEqual(malformedSurface.secureField.stringValue, "")
        XCTAssertEqual(malformed.callCount, 1)
        XCTAssertEqual(malformed.matchedExpectedSecret, true)
    }

    func testCancelAndAccessibilityDoNotExposeTheFieldValue() throws {
        let sink = FakeSink(credentialRef: credentialRef)
        let surface = try XCTUnwrap(
            CredentialPromptSurface(
                credentialUseId: "fixture.publish.api-key",
                sink: sink
            )
        )
        let canary = "fixture_accessibility_canary"
        surface.secureField.stringValue = canary
        let accessibility = surface.secureField.accessibilityValue().map {
            String(describing: $0)
        } ?? ""

        XCTAssertFalse(accessibility.contains(canary))
        XCTAssertEqual(surface.cancel(), .cancelled)
        XCTAssertEqual(surface.secureField.stringValue, "")
        XCTAssertEqual(sink.callCount, 0)
    }

    func testTargetHasNoPresenterStorageOrGenericSecretChannel() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sourceRoot = packageRoot.appendingPathComponent("Sources/OxrailCredentialEnclave")
        let sources = try swiftSources(below: sourceRoot)
        XCTAssertFalse(sources.isEmpty)
        for forbidden in [
            "runModal(", "beginSheetModal", "makeKeyAndOrderFront", "orderFront(",
            "SecItem", "NSXPCConnection", "NSPasteboard", "URLSession", "URLRequest",
            "CommandLine", "ProcessInfo.processInfo.environment", "FileHandle", "NSLog", "print(",
        ] {
            XCTAssertFalse(sources.contains { $0.contains(forbidden) }, forbidden)
        }

        let manifest = try String(
            contentsOf: packageRoot.appendingPathComponent("Package.swift"),
            encoding: .utf8
        )
        let productsStart = try XCTUnwrap(manifest.range(of: "products: [")?.upperBound)
        let productsEnd = try XCTUnwrap(manifest.range(of: "],\n    targets:")?.lowerBound)
        let products = productsStart ..< productsEnd
        XCTAssertFalse(manifest[products].contains("OxrailCredentialEnclave"))
        let enclaveName = try XCTUnwrap(
            manifest.range(of: "name: \"OxrailCredentialEnclave\"")?.lowerBound
        )
        let targetDeclaration = manifest[..<enclaveName].suffix(80)
        XCTAssertTrue(targetDeclaration.contains(".target("))
        XCTAssertFalse(targetDeclaration.contains(".executableTarget("))
    }
}

private final class FakeSink: CredentialSecretSink {
    private let credentialRef: String?
    private let expectedSecret: Data?
    private(set) var callCount = 0
    private(set) var matchedExpectedSecret: Bool?
    private(set) var receivedScope: CredentialReferenceScope?

    init(credentialRef: String?, expectedSecret: Data? = nil) {
        self.credentialRef = credentialRef
        self.expectedSecret = expectedSecret
    }

    func store(_ secret: Data, scope: CredentialReferenceScope) -> String? {
        callCount += 1
        matchedExpectedSecret = expectedSecret.map { secret == $0 }
        receivedScope = scope
        return credentialRef
    }
}

@MainActor
private func secureFields(in view: NSView) -> [NSSecureTextField] {
    view.subviews.reduce((view as? NSSecureTextField).map { [$0] } ?? []) {
        $0 + secureFields(in: $1)
    }
}

@MainActor
private func textFields(in view: NSView) -> [NSTextField] {
    view.subviews.reduce((view as? NSTextField).map { [$0] } ?? []) {
        $0 + textFields(in: $1)
    }
}

private func swiftSources(below root: URL) throws -> [String] {
    guard let enumerator = FileManager.default.enumerator(
        at: root,
        includingPropertiesForKeys: nil,
        options: [.skipsHiddenFiles]
    ) else {
        return []
    }
    return try enumerator.compactMap { item in
        guard let url = item as? URL, url.pathExtension == "swift" else { return nil }
        return try String(contentsOf: url, encoding: .utf8)
    }
}
