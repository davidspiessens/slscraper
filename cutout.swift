// Knipt het voorwerp uit een foto (macOS Vision) en zet het op een witte
// achtergrond, met dezelfde afmetingen. Bestaande bestanden worden nooit
// overschreven.
//
//   swift cutout.swift <uitvoermap> <foto> [<foto> ...]
//   bv. swift cutout.swift ~/Pictures/Sales/Wit ~/Pictures/Sales/19-*.jpg
//
// Vereist macOS 14 of later (VNGenerateForegroundInstanceMaskRequest).

import AppKit
import CoreImage
import Vision

let args = CommandLine.arguments
guard args.count >= 3 else {
    print("gebruik: swift cutout.swift <uitvoermap> <foto> [<foto> ...]")
    exit(1)
}
let outDir = URL(fileURLWithPath: args[1])
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
let context = CIContext()

/// Vision levert een masker van lage resolutie. Gewoon opschalen geeft
/// trapjes en een rand van de oude achtergrond, dus:
/// 1. opschalen langs de randen van de foto zelf (edge-preserving),
/// 2. de overgang verscherpen, zodat halfdoorzichtige achtergrond wegvalt,
/// 3. het masker 1-2 px laten krimpen tegen de resterende rand,
/// 4. licht vervagen voor een zachte, niet-gekartelde rand.
func refinedMask(_ small: CIImage, for image: CIImage) -> CIImage {
    let scale = image.extent.width / 1500  // instellingen gelden voor ~1500 px breed
    let upsampled = image.applyingFilter("CIEdgePreserveUpsampleFilter", parameters: [
        "inputSmallImage": small,
        "inputSpatialSigma": 3,
        "inputLumaSigma": 0.15,
    ])
    // alpha' = (alpha - 0.4) * 4, dus 0.4 → 0 en 0.65 → 1
    let gain: CGFloat = 4, bias: CGFloat = -0.4 * gain
    let hardened = upsampled.applyingFilter("CIColorMatrix", parameters: [
        "inputRVector": CIVector(x: gain, y: 0, z: 0, w: 0),
        "inputGVector": CIVector(x: 0, y: gain, z: 0, w: 0),
        "inputBVector": CIVector(x: 0, y: 0, z: gain, w: 0),
        "inputBiasVector": CIVector(x: bias, y: bias, z: bias, w: 0),
    ]).applyingFilter("CIColorClamp")
    return hardened
        .applyingFilter("CIMorphologyMinimum", parameters: [kCIInputRadiusKey: max(1, 1.5 * scale)])
        .clampedToExtent()
        .applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: max(0.7, 0.8 * scale)])
        .cropped(to: image.extent)
}

for path in args.dropFirst(2) {
    let input = URL(fileURLWithPath: path)
    let output = outDir.appendingPathComponent(input.lastPathComponent)
    if FileManager.default.fileExists(atPath: output.path) {
        print("\(input.lastPathComponent): bestaat al in \(outDir.path), overgeslagen")
        continue
    }
    // EXIF-oriëntatie toepassen, zodat de uitvoer rechtop staat.
    guard let image = CIImage(contentsOf: input, options: [.applyOrientationProperty: true]) else {
        print("\(input.lastPathComponent): kan niet gelezen worden")
        continue
    }
    let handler = VNImageRequestHandler(ciImage: image)
    let request = VNGenerateForegroundInstanceMaskRequest()
    do {
        try handler.perform([request])
        guard let result = request.results?.first else {
            print("\(input.lastPathComponent): geen voorwerp gevonden")
            continue
        }
        let maskImage = refinedMask(
            CIImage(cvPixelBuffer: try result.generateMask(forInstances: result.allInstances)), for: image)
        let white = CIImage(color: .white).cropped(to: image.extent)
        let composed = image.applyingFilter("CIBlendWithMask", parameters: [
            kCIInputBackgroundImageKey: white,
            kCIInputMaskImageKey: maskImage,
        ])
        try context.writeJPEGRepresentation(
            of: composed, to: output, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.92])
        print("\(input.lastPathComponent): \(Int(image.extent.width))x\(Int(image.extent.height)), \(result.allInstances.count) voorwerp(en) → \(output.path)")
    } catch {
        print("\(input.lastPathComponent): \(error.localizedDescription)")
    }
}
