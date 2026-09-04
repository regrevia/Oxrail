import Foundation
import Security

public enum CodeIdentityAuthority: String, Sendable {
    case nonAuthorizing = "NON_AUTHORIZING"
}

public enum CodeIdentityScope: String, Sendable {
    case codeIdentityOnly = "CODE_IDENTITY_ONLY"
}

public enum CodeIdentityStatus: String, Sendable {
    case matchedNonAuthorizing = "MATCHED_NON_AUTHORIZING"
    case inactive = "INACTIVE"
}

public struct CodeIdentityReport: Equatable, Sendable {
    public let schemaVersion = 1
    public let authority = CodeIdentityAuthority.nonAuthorizing
    public let scope = CodeIdentityScope.codeIdentityOnly
    public let status: CodeIdentityStatus

    fileprivate init(status: CodeIdentityStatus) {
        self.status = status
    }
}

struct PinnedCodeIdentity {
    let path: URL
    let teamIdentifier: String
    let signingIdentifier: String
    let codeDirectoryHash: String
    let designatedRequirement: String
}

struct CodeIdentityPins {
    let launcher: PinnedCodeIdentity
    let helper: PinnedCodeIdentity
}

struct InspectedCodeIdentity {
    let teamIdentifier: String
    let signingIdentifier: String
    let codeDirectoryHash: String
    let designatedRequirementData: Data
    let singleArchitecture: Bool
}

protocol CodeIdentityInspecting {
    func inspect(path: URL, designatedRequirement: String) -> InspectedCodeIdentity?
}

struct SecurityCodeIdentityInspector: CodeIdentityInspecting {
    func inspect(path: URL, designatedRequirement: String) -> InspectedCodeIdentity? {
        let defaultFlags = SecCSFlags(rawValue: 0)
        var staticCode: SecStaticCode?
        guard SecStaticCodeCreateWithPath(path as CFURL, defaultFlags, &staticCode) == errSecSuccess,
              let staticCode else {
            return nil
        }

        var expectedRequirement: SecRequirement?
        guard SecRequirementCreateWithString(
            designatedRequirement as CFString,
            defaultFlags,
            &expectedRequirement
        ) == errSecSuccess, let expectedRequirement else {
            return nil
        }

        let validationFlags = SecCSFlags(rawValue:
            kSecCSCheckAllArchitectures |
                kSecCSCheckNestedCode |
                kSecCSStrictValidate |
                kSecCSRestrictSymlinks
        )
        guard SecStaticCodeCheckValidity(
            staticCode,
            validationFlags,
            expectedRequirement
        ) == errSecSuccess else {
            return nil
        }

        guard let expectedRequirementData = requirementData(expectedRequirement) else {
            return nil
        }
        var actualRequirement: SecRequirement?
        guard SecCodeCopyDesignatedRequirement(
            staticCode,
            defaultFlags,
            &actualRequirement
        ) == errSecSuccess, let actualRequirement,
              let actualRequirementData = requirementData(actualRequirement),
              actualRequirementData == expectedRequirementData else {
            return nil
        }

        var signingInformation: CFDictionary?
        let signingFlags = SecCSFlags(rawValue: kSecCSSigningInformation)
        guard SecCodeCopySigningInformation(
            staticCode,
            signingFlags,
            &signingInformation
        ) == errSecSuccess, let signingInformation else {
            return nil
        }

        let values = signingInformation as NSDictionary
        guard let teamIdentifier = values[kSecCodeInfoTeamIdentifier as String] as? String,
              let signingIdentifier = values[kSecCodeInfoIdentifier as String] as? String,
              let codeDirectoryHash = values[kSecCodeInfoUnique as String] as? Data,
              codeDirectoryHash.count == 20,
              let executableURL = values[kSecCodeInfoMainExecutable as String] as? URL else {
            return nil
        }

        return InspectedCodeIdentity(
            teamIdentifier: teamIdentifier,
            signingIdentifier: signingIdentifier,
            codeDirectoryHash: codeDirectoryHash.map { String(format: "%02x", $0) }.joined(),
            designatedRequirementData: actualRequirementData,
            singleArchitecture: isThinMachO(executableURL)
        )
    }

    private func requirementData(_ requirement: SecRequirement) -> Data? {
        var data: CFData?
        let status = SecRequirementCopyData(
            requirement,
            SecCSFlags(rawValue: 0),
            &data
        )
        guard status == errSecSuccess, let data else { return nil }
        return data as Data
    }

    private func isThinMachO(_ executableURL: URL) -> Bool {
        do {
            let handle = try FileHandle(forReadingFrom: executableURL)
            defer { try? handle.close() }
            guard let data = try handle.read(upToCount: 4), data.count == 4 else {
                return false
            }
            let magic = Array(data)
            return magic == [0xce, 0xfa, 0xed, 0xfe] ||
                magic == [0xfe, 0xed, 0xfa, 0xce] ||
                magic == [0xcf, 0xfa, 0xed, 0xfe] ||
                magic == [0xfe, 0xed, 0xfa, 0xcf]
        } catch {
            return false
        }
    }
}

func evaluatePinnedCodeIdentityObservation(
    inspector: any CodeIdentityInspecting,
    pins: CodeIdentityPins
) -> CodeIdentityReport {
    guard valid(pin: pins.launcher), valid(pin: pins.helper),
          pins.launcher.path.standardizedFileURL != pins.helper.path.standardizedFileURL,
          pins.launcher.signingIdentifier != pins.helper.signingIdentifier,
          pins.launcher.designatedRequirement != pins.helper.designatedRequirement,
          let launcher = inspector.inspect(
              path: pins.launcher.path,
              designatedRequirement: pins.launcher.designatedRequirement
          ),
          let helper = inspector.inspect(
              path: pins.helper.path,
              designatedRequirement: pins.helper.designatedRequirement
          ),
          matches(launcher, pin: pins.launcher),
          matches(helper, pin: pins.helper),
          launcher.signingIdentifier != helper.signingIdentifier,
          launcher.designatedRequirementData != helper.designatedRequirementData else {
        return CodeIdentityReport(status: .inactive)
    }
    return CodeIdentityReport(status: .matchedNonAuthorizing)
}

private func valid(pin: PinnedCodeIdentity) -> Bool {
    let teamPattern = #/^[A-Z0-9]{10}$/#
    let signingPattern = #/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/#
    let hashPattern = #/^[0-9a-f]{40}$/#
    return pin.path.isFileURL && pin.path.path.hasPrefix("/") && !pin.path.path.contains("\0") &&
        pin.teamIdentifier.wholeMatch(of: teamPattern) != nil &&
        pin.signingIdentifier.wholeMatch(of: signingPattern) != nil &&
        !pin.signingIdentifier.contains("..") &&
        pin.codeDirectoryHash.wholeMatch(of: hashPattern) != nil &&
        (1 ... 4_096).contains(pin.designatedRequirement.utf8.count) &&
        !pin.designatedRequirement.contains("\0")
}

private func matches(_ identity: InspectedCodeIdentity, pin: PinnedCodeIdentity) -> Bool {
    identity.teamIdentifier == pin.teamIdentifier &&
        identity.signingIdentifier == pin.signingIdentifier &&
        identity.codeDirectoryHash == pin.codeDirectoryHash &&
        identity.singleArchitecture
}

// Real release artifacts and their compile-time pins do not exist yet.
private let releaseCodeIdentityPins: CodeIdentityPins? = nil

/// Returns read-only local identity evidence. It never authorizes Credential activation.
public func runPinnedCodeIdentityObservation() -> CodeIdentityReport {
    guard let releaseCodeIdentityPins else {
        return CodeIdentityReport(status: .inactive)
    }
    return evaluatePinnedCodeIdentityObservation(
        inspector: SecurityCodeIdentityInspector(),
        pins: releaseCodeIdentityPins
    )
}
