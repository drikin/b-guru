import SwiftUI

/// 📝 ネタ帳のページ（iPhone は ✉️ と 📻 の間、iPad は左の列）。中身は Web のネタ帳（shared/NetaTab.swift）。
struct NetaScreen: View {
    let path: String
    var tabPicker: PagePicker? = nil

    var body: some View {
        NavigationStack {
            NetaTabView(path: path)
                .ignoresSafeArea(.container, edges: .bottom)
                .navigationTitle("ネタ帳")
                .inlineNavigationTitle()
                .toolbar { if let tabPicker { ToolbarItem(placement: .principal) { tabPicker } } }
                .onAppear { NetaTabWeb.shared.shown() }
        }
    }
}
