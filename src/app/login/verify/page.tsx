import LinkAction from "../LinkAction";

export const metadata = { title: "ログイン | B-guru", robots: { index: false } };

export default function LoginVerifyPage() {
  return (
    <LinkAction
      title="B-guru にログイン"
      endpoint="/api/auth/verify"
      auto
      doneText="ログインしました"
      redirectTo="/"
    />
  );
}
