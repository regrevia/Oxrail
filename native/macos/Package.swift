// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "OxrailMacOS",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "OxrailKeychainProbe", targets: ["OxrailKeychainProbe"]),
        .executable(name: "oxrail-keychain-probe", targets: ["OxrailKeychainProbeCLI"]),
    ],
    targets: [
        .target(
            name: "OxrailKeychainProbe",
            linkerSettings: [.linkedFramework("Security")]
        ),
        .executableTarget(
            name: "OxrailKeychainProbeCLI",
            dependencies: ["OxrailKeychainProbe"]
        ),
        .testTarget(
            name: "OxrailKeychainProbeTests",
            dependencies: ["OxrailKeychainProbe"]
        ),
    ]
)
