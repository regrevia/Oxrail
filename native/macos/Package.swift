// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "OxrailMacOS",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "OxrailCodeIdentity", targets: ["OxrailCodeIdentity"]),
        .library(name: "OxrailCredentialRegistry", targets: ["OxrailCredentialRegistry"]),
        .library(name: "OxrailCredentialEnclave", targets: ["OxrailCredentialEnclave"]),
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
            name: "OxrailCredentialEnclave",
            dependencies: ["OxrailCredentialRegistry"],
            linkerSettings: [.linkedFramework("AppKit")]
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
            name: "OxrailCredentialEnclaveTests",
            dependencies: ["OxrailCredentialEnclave", "OxrailCredentialRegistry"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
