// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "OxrailLabMacOS",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(name: "OxrailMacOS", path: "../../../native/macos"),
    ],
    targets: [
        .target(
            name: "OxrailCredentialDemo",
            dependencies: [
                .product(name: "OxrailCredentialEnclave", package: "OxrailMacOS"),
                .product(name: "OxrailCredentialRegistry", package: "OxrailMacOS"),
            ],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("Security"),
            ]
        ),
        .target(
            name: "OxrailKeychainProbe",
            linkerSettings: [.linkedFramework("Security")]
        ),
        .executableTarget(
            name: "OxrailKeychainProbeCLI",
            dependencies: ["OxrailKeychainProbe"]
        ),
        .executableTarget(
            name: "OxrailCredentialDemoCLI",
            dependencies: ["OxrailCredentialDemo"]
        ),
        .testTarget(
            name: "OxrailCredentialDemoTests",
            dependencies: ["OxrailCredentialDemo"]
        ),
        .testTarget(
            name: "OxrailKeychainProbeTests",
            dependencies: ["OxrailKeychainProbe"]
        ),
    ]
)
