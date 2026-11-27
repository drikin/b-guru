import SwiftUI

/// 📝 ネタ帳のページ（iPhone は ✉️ と 📻 の間、iPad は左の列）。中身は Web のネタ帳（shared/NetaTab.swift）。
/// 📜 台本のページ（いちばん右、2026-11-14 オーナー「アプリは 1 番右のタブに追加」）も同じ作り（title: "台本", web: .script）。
struct NetaScreen: View {
    let path: String
    var title = "ネタ帳"
    var web: NetaTabWeb = .shared
    var tabPicker: PagePicker? = nil

    var body: some View {
        NavigationStack {
            NetaTabView(path: path, web: web)
                .ignoresSafeArea(.container, edges: .bottom)
                // 元記事（2026-11-27）: ネタ帳の上に重ねる。✕ でネタ帳に戻る。
                .overlay { NetaReaderOverlay(reader: web.reader).ignoresSafeArea(.keyboard) }
                // キーボードは WebView が自分で避ける（入力欄が見えるようにページの中をずらす）。SwiftUI にも避けさせると
                // ネタ帳の画面ごとキーボードの高さに合わせて縮み、iPad のフローティングキーボードでも上がっていた
                // （オーナー 2026-11-27「ネタ帳の表示ビューがソフトウェアキーボードの表示領域に引っ張られて可変に上がっちゃう」）。
                .ignoresSafeArea(.keyboard)
                .navigationTitle(title)
                .inlineNavigationTitle()
                .toolbar {
                    if let tabPicker { ToolbarItem(placement: .principal) { tabPicker } }
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu { NetaLinksToggle() } label: { Image(systemName: "ellipsis.circle") }
                            .accessibilityLabel("ネタ帳の設定")
                    }
                }
                .onAppear { web.shown() }
        }
    }
}
