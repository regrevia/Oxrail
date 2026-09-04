import XCTest
@testable import OxrailCredentialRegistry

final class CredentialRegistryTests: XCTestCase {
    func testEmbeddedFixtureMatchesTypeScriptDigestsButNeverActivates() {
        let report = runEmbeddedCredentialRegistryObservation()

        XCTAssertEqual(report.schemaVersion, 1)
        XCTAssertEqual(report.authority, .fixtureOnlyNonAuthorizing)
        XCTAssertEqual(report.scope, .registryStructureOnly)
        XCTAssertEqual(report.status, .matchedFixtureNonAuthorizing)
        XCTAssertEqual(report.activation, .inactive)
        XCTAssertEqual(report.credentialKind, "API_KEY")
        XCTAssertEqual(report.consumerReadiness, "FIXTURE_ONLY")
        XCTAssertEqual(report.registryVersion, 1)
        XCTAssertEqual(
            report.templateRegistryHash,
            "b01287454e5727a721e941b00e6d5bf2b6a0c89c47cfb3f9edcad5820e970cdd"
        )
        XCTAssertEqual(
            report.consumerRegistryHash,
            "71e4b865818705e073c556f3adea9bb296fe359f0385cb48ec6054862347b1be"
        )
        XCTAssertEqual(
            report.registryManifestHash,
            "2fd54c5c4bf0672d670323d3bb181aa185ebfdec8667baedb69e13222790e4d7"
        )
        XCTAssertEqual(
            Set(Mirror(reflecting: report).children.compactMap { $0.label }),
            [
                "schemaVersion", "authority", "scope", "status", "activation",
                "credentialKind", "consumerReadiness", "registryVersion",
                "templateRegistryHash", "consumerRegistryHash", "registryManifestHash",
            ]
        )
    }

    func testStructureScopeAndLinkMutationsRemainInactiveEvenWhenRehashed() {
        let mutations: [(String, (inout CredentialRegistryBundle) -> Void)] = [
            ("template schema", { $0.templateRegistry.schemaVersion = 2 }),
            ("consumer schema", { $0.consumerRegistry.schemaVersion = 2 }),
            ("manifest schema", { $0.manifest.schemaVersion = 2 }),
            ("template readiness", { $0.templateRegistry.readiness = "AUDITED_REAL_CONSUMER" }),
            ("consumer readiness", { $0.consumerRegistry.readiness = "AUDITED_REAL_CONSUMER" }),
            ("authority", { $0.manifest.authority = "AUTHORIZING" }),
            ("registry version", { $0.templateRegistry.registryVersion = 2 }),
            ("coordinated registry version", {
                $0.templateRegistry.registryVersion = 2
                $0.consumerRegistry.registryVersion = 2
                $0.manifest.registryVersion = 2
            }),
            ("zero version", { $0.manifest.registryVersion = 0 }),
            ("duplicate template", {
                let duplicate = $0.templateRegistry.templates[0]
                $0.templateRegistry.templates.append(duplicate)
            }),
            ("duplicate consumer", {
                let duplicate = $0.consumerRegistry.consumers[0]
                $0.consumerRegistry.consumers.append(duplicate)
            }),
            ("credential kind", { $0.templateRegistry.templates[0].credentialKind = "PASSWORD" }),
            ("credential use id", { $0.templateRegistry.templates[0].credentialUseId = "INVALID ID" }),
            ("template id", { $0.templateRegistry.templates[0].templateId = "INVALID ID" }),
            ("purpose id", { $0.templateRegistry.templates[0].purposeId = "INVALID ID" }),
            ("consumer link", { $0.templateRegistry.templates[0].consumerId = "fixture.other" }),
            ("service link", { $0.templateRegistry.templates[0].serviceId = "fixture-other" }),
            ("origin link", {
                $0.templateRegistry.templates[0].provisioningOrigin = "https://other.example.test"
                $0.templateRegistry.templates[0].siteLabel = "other.example.test"
            }),
            ("coordinated origin change", {
                $0.templateRegistry.templates[0].provisioningOrigin = "https://other.example.test"
                $0.templateRegistry.templates[0].siteLabel = "other.example.test"
                $0.consumerRegistry.consumers[0].tlsOrigin = "https://other.example.test"
            }),
            ("non-https origin", {
                $0.consumerRegistry.consumers[0].tlsOrigin = "http://credentials.example.test"
            }),
            ("origin userinfo", {
                $0.consumerRegistry.consumers[0].tlsOrigin = "https://user@credentials.example.test"
            }),
            ("origin path", {
                $0.consumerRegistry.consumers[0].tlsOrigin = "https://credentials.example.test/path"
            }),
            ("request path query", {
                $0.consumerRegistry.consumers[0].path = "/v1/credential-probe?raw=true"
            }),
            ("request path traversal", {
                $0.consumerRegistry.consumers[0].path = "/v1/../credential-probe"
            }),
            ("different valid path", {
                $0.consumerRegistry.consumers[0].path = "/v1/other-probe"
            }),
            ("method", { $0.consumerRegistry.consumers[0].method = "GET" }),
            ("credential placement", {
                $0.consumerRegistry.consumers[0].credentialPlacement = "ARBITRARY_HEADER"
            }),
            ("redirect", { $0.consumerRegistry.consumers[0].followsRedirects = true }),
            ("request shape", { $0.consumerRegistry.consumers[0].requestShape = "GENERIC_JSON" }),
            ("output", { $0.consumerRegistry.consumers[0].outputSchema = "RAW_RESPONSE" }),
            ("ttl zero", { $0.templateRegistry.templates[0].grantTtlSeconds = 0 }),
            ("ttl excessive", {
                $0.templateRegistry.templates[0].grantTtlSeconds = 31_536_001
            }),
            ("different valid ttl", { $0.templateRegistry.templates[0].grantTtlSeconds = 7_200 }),
            ("generation", { $0.templateRegistry.templates[0].generation = 0 }),
            ("different generation", { $0.templateRegistry.templates[0].generation = 2 }),
            ("field class", { $0.templateRegistry.templates[0].secureFieldClass = "NSTextField" }),
            ("site label", { $0.templateRegistry.templates[0].siteLabel = "other.example.test" }),
            ("fixed title", { $0.templateRegistry.templates[0].windowTitle = "Page supplied" }),
            ("fixed purpose label", {
                $0.templateRegistry.templates[0].purposeLabel = "Different purpose"
            }),
            ("fixed warning", { $0.templateRegistry.templates[0].pasteboardWarning = "Hidden" }),
        ]

        for (name, mutate) in mutations {
            var candidate = embeddedFixtureCredentialRegistry()
            mutate(&candidate)
            rehash(&candidate)
            let report = evaluateCredentialRegistry(candidate)
            XCTAssertEqual(report.status, .inactive, name)
            XCTAssertEqual(report.activation, .inactive, name)
            XCTAssertNil(report.registryManifestHash, name)
        }
    }

    func testHashDriftAndNoncanonicalHashesAreInactive() {
        var changedTemplate = embeddedFixtureCredentialRegistry()
        changedTemplate.templateRegistry.templates[0].purposeLabel = "Changed fixture purpose"

        var changedConsumer = embeddedFixtureCredentialRegistry()
        changedConsumer.consumerRegistry.consumers[0].path = "/v1/other-probe"

        var changedManifest = embeddedFixtureCredentialRegistry()
        changedManifest.registryManifestHash = String(repeating: "a", count: 64)

        var uppercaseHash = embeddedFixtureCredentialRegistry()
        uppercaseHash.manifest.templateRegistryHash = uppercaseHash.manifest.templateRegistryHash.uppercased()

        for candidate in [changedTemplate, changedConsumer, changedManifest, uppercaseHash] {
            let report = evaluateCredentialRegistry(candidate)
            XCTAssertEqual(report.status, .inactive)
            XCTAssertEqual(report.activation, .inactive)
            XCTAssertNil(report.registryVersion)
            XCTAssertNil(report.templateRegistryHash)
            XCTAssertNil(report.consumerRegistryHash)
            XCTAssertNil(report.registryManifestHash)
        }
    }
}

private func rehash(_ bundle: inout CredentialRegistryBundle) {
    bundle.manifest.templateRegistryHash = credentialRegistryDigest(
        domain: "oxrail-credential-template-registry-v1",
        value: bundle.templateRegistry
    )!
    bundle.manifest.consumerRegistryHash = credentialRegistryDigest(
        domain: "oxrail-credential-consumer-registry-v1",
        value: bundle.consumerRegistry
    )!
    bundle.registryManifestHash = credentialRegistryDigest(
        domain: "oxrail-credential-registry-manifest-v1",
        value: bundle.manifest
    )!
}
