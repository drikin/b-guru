/** Mac のアシスタント機能の段階公開（MAC_ASSISTANT_ENABLED → capabilities の features.mac_assistant）。 */
import { describe, it, expect, afterEach } from "vitest";
import { macAssistantEnabledFor, MAC_ASSISTANT_FLAG } from "../feature-flag";
import { agentCapabilities } from "../agent-chat";

const saved = process.env[MAC_ASSISTANT_FLAG];
afterEach(() => {
  if (saved === undefined) delete process.env[MAC_ASSISTANT_FLAG];
  else process.env[MAC_ASSISTANT_FLAG] = saved;
});

describe("MAC_ASSISTANT_ENABLED", () => {
  it("未設定・0・false は誰にも出さない", () => {
    delete process.env[MAC_ASSISTANT_FLAG];
    expect(macAssistantEnabledFor("owner@example.com")).toBe(false);
    for (const v of ["0", "false", ""]) {
      process.env[MAC_ASSISTANT_FLAG] = v;
      expect(macAssistantEnabledFor("owner@example.com")).toBe(false);
    }
  });

  it("メールなら本人だけ（大文字小文字・空白は無視）", () => {
    process.env[MAC_ASSISTANT_FLAG] = " Owner@Example.com , second@example.com";
    expect(macAssistantEnabledFor("owner@example.com")).toBe(true);
    expect(macAssistantEnabledFor("SECOND@example.com")).toBe(true);
    expect(macAssistantEnabledFor("other@example.com")).toBe(false);
    expect(macAssistantEnabledFor(null)).toBe(false);
  });

  it("1 で全員", () => {
    process.env[MAC_ASSISTANT_FLAG] = "1";
    expect(macAssistantEnabledFor("anyone@example.com")).toBe(true);
  });

  it("capabilities の features.mac_assistant に出る（既定 false）", () => {
    expect(agentCapabilities(["read"]).features.mac_assistant).toBe(false);
    expect(agentCapabilities(["read"], { macAssistant: true }).features.mac_assistant).toBe(true);
  });
});
