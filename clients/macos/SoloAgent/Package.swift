// swift-tools-version: 5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "SoloAgent",
    platforms: [
        .macOS(.v14)  // macOS 14+ for ScreenCaptureKit improvements & MenuBarExtra
    ],
    products: [
        .executable(name: "SoloAgent", targets: ["SoloAgent"])
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "SoloAgent",
            dependencies: [],
            path: "Sources",
            resources: [
                .process("../Resources")
            ]
        )
    ]
)
