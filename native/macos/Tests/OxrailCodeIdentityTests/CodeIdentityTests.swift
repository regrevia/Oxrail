import Foundation
import XCTest
@testable import OxrailCodeIdentity

final class CodeIdentityTests: XCTestCase {
    func testProductionObservationIsFixedInactiveWithoutReleasePins() {
        let report = runPinnedCodeIdentityObservation()

        XCTAssertEqual(report.schemaVersion, 1)
        XCTAssertEqual(report.authority.rawValue, "NON_AUTHORIZING")
        XCTAssertEqual(report.scope.rawValue, "CODE_IDENTITY_ONLY")
        XCTAssertEqual(report.status, .inactive)
        XCTAssertEqual(
            Set(Mirror(reflecting: report).children.compactMap { $0.label }),
            ["schemaVersion", "authority", "scope", "status"]
        )
    }

    func testBothDistinctPinnedIdentitiesMustMatch() {
        let pins = makePins()
        let inspector = FakeInspector(pins: pins)

        XCTAssertEqual(
            evaluatePinnedCodeIdentityObservation(inspector: inspector, pins: pins).status,
            .matchedNonAuthorizing
        )
        XCTAssertEqual(inspector.calls, 2)
    }

    func testEveryPinnedFieldMismatchAndPartialSuccessAreInactive() {
        let pins = makePins()
        let base = FakeInspector.observations(for: pins)

        for role in [Role.launcher, .helper] {
            for mismatch in Mismatch.allCases {
                var observations = base
                observations[role] = mismatch.apply(to: observations[role]!)
                let inspector = FakeInspector(
                    pins: pins,
                    observations: observations,
                    mismatchedRequirementRole: mismatch == .designatedRequirement ? role : nil
                )
                XCTAssertEqual(
                    evaluatePinnedCodeIdentityObservation(inspector: inspector, pins: pins).status,
                    .inactive,
                    "\(role) \(mismatch)"
                )
            }
        }

        let partial = FakeInspector(pins: pins, missingRole: .helper)
        XCTAssertEqual(
            evaluatePinnedCodeIdentityObservation(inspector: partial, pins: pins).status,
            .inactive
        )

        var aliasedRequirement = base
        let helper = aliasedRequirement[.helper]!
        aliasedRequirement[.helper] = InspectedCodeIdentity(
            teamIdentifier: helper.teamIdentifier,
            signingIdentifier: helper.signingIdentifier,
            codeDirectoryHash: helper.codeDirectoryHash,
            designatedRequirementData: base[.launcher]!.designatedRequirementData,
            singleArchitecture: true
        )
        XCTAssertEqual(
            evaluatePinnedCodeIdentityObservation(
                inspector: FakeInspector(pins: pins, observations: aliasedRequirement),
                pins: pins
            ).status,
            .inactive
        )
    }

    func testMalformedOrNonDistinctPinsAreInactiveWithoutInspection() {
        let pins = makePins()
        let malformed: [CodeIdentityPins] = [
            replacing(pins, launcher: replacing(pins.launcher, team: "lowercase")),
            replacing(pins, launcher: replacing(pins.launcher, signing: "bad/id")),
            replacing(pins, launcher: replacing(pins.launcher, hash: String(repeating: "a", count: 39))),
            replacing(pins, launcher: replacing(pins.launcher, hash: String(repeating: "a", count: 41))),
            replacing(pins, launcher: replacing(pins.launcher, hash: String(repeating: "A", count: 40))),
            replacing(pins, launcher: replacing(pins.launcher, requirement: "")),
            replacing(pins, helper: replacing(pins.helper, path: pins.launcher.path)),
            replacing(pins, helper: replacing(pins.helper, signing: pins.launcher.signingIdentifier)),
            replacing(pins, helper: replacing(pins.helper, requirement: pins.launcher.designatedRequirement)),
        ]

        for candidate in malformed {
            let inspector = FakeInspector(pins: candidate)
            XCTAssertEqual(
                evaluatePinnedCodeIdentityObservation(inspector: inspector, pins: candidate).status,
                .inactive
            )
            XCTAssertEqual(inspector.calls, 0)
        }
    }

    func testUnsignedFileAndMalformedRequirementAreRejectedBySecurityFramework() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let unsigned = directory.appendingPathComponent("unsigned.txt")
        try Data("not executable".utf8).write(to: unsigned)
        let inspector = SecurityCodeIdentityInspector()

        XCTAssertNil(
            inspector.inspect(
                path: unsigned,
                designatedRequirement: #"identifier "dev.oxrail.unsigned""#
            )
        )
        XCTAssertNil(
            inspector.inspect(
                path: URL(fileURLWithPath: "/usr/bin/true"),
                designatedRequirement: "not a requirement ("
            )
        )
    }
}

private enum Role: CaseIterable, Hashable {
    case launcher
    case helper
}

private enum Mismatch: CaseIterable, Hashable {
    case team
    case signingIdentifier
    case codeDirectoryHash
    case designatedRequirement
    case universalBinary

    func apply(to identity: InspectedCodeIdentity) -> InspectedCodeIdentity {
        InspectedCodeIdentity(
            teamIdentifier: self == .team ? "ZZZZZZZZZZ" : identity.teamIdentifier,
            signingIdentifier: self == .signingIdentifier
                ? "dev.oxrail.wrong" : identity.signingIdentifier,
            codeDirectoryHash: self == .codeDirectoryHash
                ? String(repeating: "f", count: 40) : identity.codeDirectoryHash,
            designatedRequirementData: self == .designatedRequirement
                ? Data("wrong".utf8) : identity.designatedRequirementData,
            singleArchitecture: self != .universalBinary
        )
    }
}

private final class FakeInspector: CodeIdentityInspecting {
    private let pins: CodeIdentityPins
    private let observations: [Role: InspectedCodeIdentity]
    private let missingRole: Role?
    private let mismatchedRequirementRole: Role?
    var calls = 0

    init(
        pins: CodeIdentityPins,
        observations: [Role: InspectedCodeIdentity]? = nil,
        missingRole: Role? = nil,
        mismatchedRequirementRole: Role? = nil
    ) {
        self.pins = pins
        self.observations = observations ?? Self.observations(for: pins)
        self.missingRole = missingRole
        self.mismatchedRequirementRole = mismatchedRequirementRole
    }

    func inspect(path: URL, designatedRequirement: String) -> InspectedCodeIdentity? {
        calls += 1
        let role: Role
        if path == pins.launcher.path {
            role = .launcher
        } else if path == pins.helper.path {
            role = .helper
        } else {
            return nil
        }
        guard role != missingRole,
              role != mismatchedRequirementRole,
              designatedRequirement == requirement(for: role) else {
            return nil
        }
        return observations[role]
    }

    static func observations(for pins: CodeIdentityPins) -> [Role: InspectedCodeIdentity] {
        [
            .launcher: observation(pin: pins.launcher),
            .helper: observation(pin: pins.helper),
        ]
    }

    private static func observation(pin: PinnedCodeIdentity) -> InspectedCodeIdentity {
        InspectedCodeIdentity(
            teamIdentifier: pin.teamIdentifier,
            signingIdentifier: pin.signingIdentifier,
            codeDirectoryHash: pin.codeDirectoryHash,
            designatedRequirementData: Data(pin.designatedRequirement.utf8),
            singleArchitecture: true
        )
    }

    private func requirement(for role: Role) -> String {
        role == .launcher
            ? pins.launcher.designatedRequirement
            : pins.helper.designatedRequirement
    }
}

private func makePins() -> CodeIdentityPins {
    CodeIdentityPins(
        launcher: PinnedCodeIdentity(
            path: URL(fileURLWithPath: "/Applications/Oxrail Launcher.app"),
            teamIdentifier: "ABCDE12345",
            signingIdentifier: "dev.oxrail.launcher",
            codeDirectoryHash: String(repeating: "a", count: 40),
            designatedRequirement: #"identifier "dev.oxrail.launcher" and anchor apple generic"#
        ),
        helper: PinnedCodeIdentity(
            path: URL(fileURLWithPath: "/Applications/Oxrail Helper.app"),
            teamIdentifier: "ABCDE12345",
            signingIdentifier: "dev.oxrail.helper",
            codeDirectoryHash: String(repeating: "b", count: 40),
            designatedRequirement: #"identifier "dev.oxrail.helper" and anchor apple generic"#
        )
    )
}

private func replacing(
    _ pins: CodeIdentityPins,
    launcher: PinnedCodeIdentity? = nil,
    helper: PinnedCodeIdentity? = nil
) -> CodeIdentityPins {
    CodeIdentityPins(launcher: launcher ?? pins.launcher, helper: helper ?? pins.helper)
}

private func replacing(
    _ pin: PinnedCodeIdentity,
    path: URL? = nil,
    team: String? = nil,
    signing: String? = nil,
    hash: String? = nil,
    requirement: String? = nil
) -> PinnedCodeIdentity {
    PinnedCodeIdentity(
        path: path ?? pin.path,
        teamIdentifier: team ?? pin.teamIdentifier,
        signingIdentifier: signing ?? pin.signingIdentifier,
        codeDirectoryHash: hash ?? pin.codeDirectoryHash,
        designatedRequirement: requirement ?? pin.designatedRequirement
    )
}
