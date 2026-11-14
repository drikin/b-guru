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
                .navigationTitle(title)
                .inlineNavigationTitle()
                .toolbar { if let tabPicker { ToolbarItem(placement: .principal) { tabPicker } } }
                .onAppear { web.shown() }
        }
    }
}
