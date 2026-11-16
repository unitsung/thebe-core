import type {
  ImAdapterCredentials,
  ImLoginAdapter,
  ImLoginChallenge,
  ImLoginPoll,
} from "../../../agent/im/types.ts";
import {
  WECHAT_DEFAULT_BASE_URL,
  WechatApiError,
  getWechatQRCode,
  pollWechatQRCode,
  type WechatQRStatus,
} from "./protocol.ts";

const LOGIN_TTL_MS = 5 * 60 * 1_000;

type Session = {
  qrcode: string;
  baseUrl: string;
  expiresAt: number;
  verifyCode?: string;
};

/**
 * Weixin ClawBot QR login. The QR content is a WeChat URL; the App renders it as a QR code and
 * polls this adapter through Core. The bot token and IDs never leave Core.
 */
export function createWechatLoginAdapter(input: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): ImLoginAdapter {
  const now = input.now ?? (() => new Date());
  const baseUrl = (input.baseUrl?.trim() || WECHAT_DEFAULT_BASE_URL).replace(
    /\/+$/,
    ""
  );
  const sessions = new Map<string, Session>();

  function statusToPoll(status: WechatQRStatus, session: Session): ImLoginPoll {
    switch (status.status) {
      case "wait":
        return { state: "pending" };
      case "scaned":
        return { state: "scanned" };
      case "scaned_but_redirect": {
        if (status.redirectHost?.trim()) {
          session.baseUrl = status.redirectHost.trim().replace(/\/+$/, "");
        }
        return {
          state: "pending",
          detail: "Switching to the Weixin redirect host",
        };
      }
      case "need_verifycode":
      case "confirmed_but_need_verifycode":
        return {
          state: "need_verifycode",
          detail: "Enter the PIN shown on your phone",
        };
      case "expired":
        sessions.delete(session.qrcode);
        return { state: "expired", detail: "The QR code expired" };
      case "verify_code_blocked":
        sessions.delete(session.qrcode);
        return { state: "failed", detail: "Too many incorrect PIN attempts" };
      case "binded_redirect":
        sessions.delete(session.qrcode);
        return {
          state: "failed",
          detail: "This Weixin Bot is already bound to another client",
        };
      case "confirmed": {
        if (!status.botToken) {
          sessions.delete(session.qrcode);
          return {
            state: "failed",
            detail: "Weixin confirmed the login without a bot token",
          };
        }
        const credentials: ImAdapterCredentials = {
          token: status.botToken,
          baseurl: (status.baseurl?.trim() || session.baseUrl).replace(
            /\/+$/,
            ""
          ),
          ...(status.ilinkBotId ? { accountId: status.ilinkBotId } : {}),
          ...(status.ilinkUserId ? { userId: status.ilinkUserId } : {}),
        };
        sessions.delete(session.qrcode);
        return { state: "confirmed", credentials };
      }
      default:
        return {
          state: "failed",
          detail: "Weixin returned an unknown login state",
        };
    }
  }

  return {
    async begin(): Promise<ImLoginChallenge> {
      const qr = await getWechatQRCode({
        baseUrl,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
      const expiresAt = now().getTime() + LOGIN_TTL_MS;
      sessions.set(qr.qrcode, { qrcode: qr.qrcode, baseUrl, expiresAt });
      return {
        id: qr.qrcode,
        platform: "wechat",
        kind: "qr",
        content: qr.qrcodeImgContent,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },

    async poll(challengeId: string): Promise<ImLoginPoll> {
      const session = sessions.get(challengeId);
      if (!session) {
        return { state: "expired", detail: "The QR login is no longer active" };
      }
      if (session.expiresAt <= now().getTime()) {
        sessions.delete(challengeId);
        return { state: "expired", detail: "The QR code expired" };
      }
      try {
        const status = await pollWechatQRCode({
          baseUrl: session.baseUrl,
          qrcode: session.qrcode,
          ...(session.verifyCode ? { verifyCode: session.verifyCode } : {}),
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        });
        session.verifyCode = undefined;
        return statusToPoll(status, session);
      } catch (error) {
        if (error instanceof WechatApiError) {
          return {
            state: "pending",
            detail: error.message,
            retryAfterMs: 2_000,
          };
        }
        return {
          state: "pending",
          detail: "Weixin QR status check failed",
          retryAfterMs: 2_000,
        };
      }
    },

    async cancel(challengeId: string): Promise<void> {
      sessions.delete(challengeId);
    },

    async submitCode(challengeId: string, code: string): Promise<void> {
      const session = sessions.get(challengeId);
      if (!session) {
        throw new WechatApiError("The QR login is no longer active");
      }
      session.verifyCode = code;
    },
  };
}
