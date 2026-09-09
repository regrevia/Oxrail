import Darwin
import OxrailKeychainProbe

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments == ["--extended-keychain-probe"] else {
    print(ProbeResult.usage.jsonLine)
    exit(64)
}

let result = runExtendedKeychainProbe()
print(result.jsonLine)

switch result.status {
case .passed:
    exit(0)
case .failed:
    exit(1)
case .cleanupFailed:
    exit(2)
case .usage:
    exit(64)
}
