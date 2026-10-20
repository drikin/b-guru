#if os(iOS)
import SwiftUI
import UIKit

/// 「カメラで撮る」: takes a photo with the camera and adds it to the draft, next to the
/// photo picker (drikin 2026-10-20). The shot goes through the same path as a picked
/// photo (resized, metadata stripped when sent) and is not saved to the library.
/// Hidden where there is no camera (the simulator, some iPads).
struct CameraButton<Label: View>: View {
    let draft: PostDraft
    @ViewBuilder var label: () -> Label
    @State private var shooting = false

    var body: some View {
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            Button(action: { shooting = true }, label: label)
                .disabled(draft.images.count >= draft.maxImages)
                .accessibilityLabel("カメラで撮る")
                .fullScreenCover(isPresented: $shooting) {
                    CameraPicker { data in
                        shooting = false
                        if let data { draft.add(imageData: data) }
                    }
                    .ignoresSafeArea()
                }
        }
    }
}

private struct CameraPicker: UIViewControllerRepresentable {
    let done: (Data?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let p = UIImagePickerController()
        p.sourceType = .camera
        p.cameraCaptureMode = .photo
        p.delegate = context.coordinator
        return p
    }
    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let done: (Data?) -> Void
        init(done: @escaping (Data?) -> Void) { self.done = done }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            // The JPEG carries the orientation; the draft applies it when it decodes.
            done((info[.originalImage] as? UIImage)?.jpegData(compressionQuality: 0.9))
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { done(nil) }
    }
}
#endif
