// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "OxrailMacOS",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "OxrailCodeIdentity", targets: ["OxrailCodeIdentity"]),
        .library(name: "OxrailCredentialRegistry", targets: ["OxrailCredentialRegistry"]),
        .library(name: "OxrailKeychainProbe", targets: ["OxrailKeychainProbe"]),
        .executable(name: "oxrail-keychain-probe", targets: ["OxrailKeychainProbeCLI"]),
    ],
    targets: [
        .target(
            name: "OxrailCodeIdentity",
            linkerSettings: [.linkedFramework("Security")]
        ),
        .target(
            name: "OxrailCredentialRegistry",
            linkerSettings: [.linkedFramework("Security")]
        ),
        .target(
            name: "OxrailKeychainProbe",
            linkerSettings: [.linkedFramework("Security")]
        ),
        .executableTarget(
            name: "OxrailKeychainProbeCLI",
            dependencies: ["OxrailKeychainProbe"]
        ),
        .testTarget(
            name: "OxrailCodeIdentityTests",
            dependencies: ["OxrailCodeIdentity"]
        ),
        .testTarget(
            name: "OxrailCredentialRegistryTests",
            dependencies: ["OxrailCredentialRegistry"]
        ),
        .testTarget(
            name: "OxrailKeychainProbeTests",
            dependencies: ["OxrailKeychainProbe"]
        ),
    ]
)
