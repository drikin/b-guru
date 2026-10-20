import LinkAction from "../LinkAction";

export const metadata = { title: "すべての端末をログアウト | B-guru", robots: { index: false } };

export default function LoginRevokePage() {
  return (
    <LinkAction
      title="すべての端末をログアウト"
      endpoint="/api/auth/revoke-all"
      auto={false}
      confirmText="このアカウントでログインしているすべてのブラウザとアプリをログアウトします。AI エージェント用のトークンも無効になります。"
      actionLabel="すべての端末をログアウトする"
      doneText="すべての端末をログアウトしました。次にログインするときは、届いたメールで確認します。"
    />
  );
}
