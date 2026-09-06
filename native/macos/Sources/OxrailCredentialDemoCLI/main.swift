import Darwin
import Foundation
import OxrailCredentialDemo

private func finish(_ result: CredentialDemoResult, status: Int32? = nil) -> Never {
    FileHandle.standardOutput.write(Data("\(result.jsonLine)\n".utf8))
    exit(status ?? (result.isFailure ? 1 : 0))
}

let arguments = Array(CommandLine.arguments.dropFirst())

if arguments == ["--prompt-fixture"] {
    Task { @MainActor in
        finish(presentCredentialDemo())
    }
    RunLoop.main.run()
    exit(70)
}

if arguments.count == 2 {
    let reference = arguments[1]
    switch arguments[0] {
    case "--status-fixture": finish(credentialDemoStatus(reference))
    case "--consume-fixture": finish(consumeCredentialDemo(reference))
    case "--revoke-fixture": finish(revokeCredentialDemo(reference))
    default: break
    }
}

finish(.invalidRequest, status: 64)
