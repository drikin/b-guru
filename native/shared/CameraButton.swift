#if os(iOS)
import SwiftUI
import UIKit

/// 「カメラで撮る」: takes a photo with the camera and adds it to the draft, next to the
/// photo picker (drikin 2026-10-20). The shot goes through the same path as a picked
/// photo (resized, metadata stripped when sent) and is not saved to the library.
/// Hidden where there is no camera (the simulator, some iPads).
/// After the shot, 「五撮 Vol.1」 can be put on it or not (drikin 2026-11-03, `GosatsuReview`).
struct CameraButton<Label: View>: View {
    let draft: PostDraft
    @ViewBuilder var label: () -> Label
    @State private var shooting = false
    @State private var shot: Data?

    var body: some View {
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            Button(action: { shot = nil; shooting = true }, label: label)
                .disabled(draft.images.count >= draft.maxImages)
                .accessibilityLabel("カメラで撮る")
                .fullScreenCover(isPresented: $shooting) {
                    if let shot {
                        GosatsuReview(original: shot) { data in
                            shooting = false
                            if let data { draft.add(imageData: data) }
                        }
                    } else {
                        CameraPicker { data in
                            if let data { shot = data } else { shooting = false }
                        }
                        .ignoresSafeArea()
                    }
                }
        }
    }
}

/// The shot, with a 「五撮 Vol.1」 switch (on: the filtered photo is what gets added). The switch
/// remembers the last choice; off by default. The filter runs on the device (`Gosatsu`, ~1 s).
struct GosatsuReview: View {
    let original: Data
    let done: (Data?) -> Void
    @AppStorage("cameraGosatsu") private var useGosatsu = false
    @State private var preview: UIImage?
    @State private var filtered: Data?
    @State private var filteredPreview: UIImage?
    @State private var working = false
    @State private var failed = false

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Color.black
                if let image = useGosatsu ? (filteredPreview ?? preview) : preview {
                    Image(uiImage: image).resizable().scaledToFit()
                }
                if useGosatsu && working {
                    ProgressView().controlSize(.large).tint(.white)
                }
            }
            VStack(spacing: 14) {
                Toggle(isOn: $useGosatsu) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("五撮 Vol.1").font(.app(.body, weight: .semibold))
                        Text(failed ? "かけられませんでした。元の写真で追加できます" : "フィルムの粒子と高い解像感のフィルター")
                            .font(.app(.caption)).foregroundStyle(.secondary)
                    }
                }
                .tint(.accentGreen)
                HStack(spacing: 12) {
                    Button { done(nil) } label: { Text("やめる").frame(maxWidth: .infinity) }
                        .buttonStyle(.bordered)
                    Button { done(useGosatsu && !failed ? filtered : original) } label: {
                        Text("追加").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.accentGreen)
                    .disabled(useGosatsu && filtered == nil && !failed)
                }
                .controlSize(.large)
                .font(.app(.body, weight: .semibold))
            }
            .padding(16)
            .background(.bar)
        }
        .preferredColorScheme(.dark)
        .task {
            let data = original
            preview = await Task.detached(priority: .userInitiated) {
                MediaCache.decode(data, maxPixel: 1600).map { UIImage(cgImage: $0) }
            }.value
            if useGosatsu { await runFilter() }
        }
        .onChange(of: useGosatsu) { _, on in
            if on { Task { await runFilter() } }
        }
    }

    private func runFilter() async {
        guard filtered == nil, !working, !failed else { return }
        working = true
        let data = original
        let result = await Task.detached(priority: .userInitiated) { () -> (Data, UIImage?)? in
            guard let jpeg = Gosatsu.jpeg(from: data) else { return nil }
            return (jpeg, MediaCache.decode(jpeg, maxPixel: 1600).map { UIImage(cgImage: $0) })
        }.value
        working = false
        if let result {
            filtered = result.0
            filteredPreview = result.1
        } else {
            failed = true
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
