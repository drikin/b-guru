"use client";
/* Pages opened from B-guru mails (/login/verify, /login/revoke). The token is in
 * the URL fragment (#t=...), so it never reaches server logs, and mail link
 * checkers that only fetch the URL cannot use it up: only this page posts it. */
import { useEffect, useRef, useState } from "react";
import { Button, Container, Paper, Stack, Text, Title } from "@mantine/core";

export default function LinkAction(props: {
  title: string;
  endpoint: string;
  /** Run as soon as the page opens (login), or wait for a button (sign-out everywhere). */
  auto: boolean;
  actionLabel?: string;
  confirmText?: string;
  doneText: string;
  redirectTo?: string;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const started = useRef(false);

  const run = async () => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("t") ?? "";
    if (!token) {
      setState("error");
      setError("リンクが正しくありません。メールのリンクをもう一度開いてください");
      return;
    }
    setState("busy");
    try {
      const r = await fetch(props.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        credentials: "same-origin",
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setState("error");
        setError(d.error || "うまくいきませんでした");
        return;
      }
      // Drop the token from the address bar and history.
      history.replaceState(null, "", window.location.pathname);
      setState("done");
      if (props.redirectTo) window.location.replace(props.redirectTo);
    } catch {
      setState("error");
      setError("通信エラー");
    }
  };

  useEffect(() => {
    if (props.auto && !started.current) {
      started.current = true;
      run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Container size={420} py={64}>
      <Paper radius="lg" p="lg" withBorder shadow="sm">
        <Stack gap="md">
          <Title order={3}>{props.title}</Title>
          {state === "idle" && !props.auto && (
            <>
              {props.confirmText && <Text size="sm">{props.confirmText}</Text>}
              <Button color="red" onClick={run}>
                {props.actionLabel}
              </Button>
            </>
          )}
          {(state === "busy" || (state === "idle" && props.auto)) && <Text c="dimmed">処理中…</Text>}
          {state === "done" && <Text>{props.doneText}</Text>}
          {state === "error" && <Text c="red">{error}</Text>}
          {(state === "done" || state === "error") && (
            <Button component="a" href="/" variant="light" color="green">
              B-guru を開く
            </Button>
          )}
        </Stack>
      </Paper>
    </Container>
  );
}
