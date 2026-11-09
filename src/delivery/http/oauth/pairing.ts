import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "../../../atomic-write.ts";

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;
const MAX_CODES = 16;

type StoredPairingCode = {
  hash: string;
  createdAt: string;
  expiresAt: string;
};

type PairingState = {
  version: 1;
  codes: StoredPairingCode[];
};

export type IssuedPairingCode = {
  code: string;
  expiresAt: string;
};

export function oauthPairingPath(configDir: string): string {
  return join(configDir, "oauth-pairing.json");
}

export class PairingCodeStore {
  readonly path: string;

  constructor(
    configDir: string,
    private readonly options: {
      ttlSeconds: number;
      now?: () => number;
      generate?: () => string;
    }
  ) {
    this.path = oauthPairingPath(configDir);
  }

  issue(): IssuedPairingCode {
    const now = this.options.now?.() ?? Date.now();
    const code = normalizePairingCode(
      this.options.generate?.() ?? generatePairingCode()
    );
    if (code.length !== CODE_LENGTH) {
      throw new Error("generated pairing code must contain 10 symbols");
    }
    const expiresAt = new Date(
      now + this.options.ttlSeconds * 1000
    ).toISOString();
    const state = this.read(now);
    state.codes.push({
      hash: hashPairingCode(code),
      createdAt: new Date(now).toISOString(),
      expiresAt,
    });
    state.codes = state.codes.slice(-MAX_CODES);
    this.write(state);
    return { code: formatPairingCode(code), expiresAt };
  }

  consume(received: string): boolean {
    const code = normalizePairingCode(received);
    if (code.length !== CODE_LENGTH) return false;
    const now = this.options.now?.() ?? Date.now();
    const state = this.read(now);
    const digest = createHash("sha256").update(code).digest();
    const index = state.codes.findIndex((candidate) => {
      const expected = Buffer.from(candidate.hash, "hex");
      return (
        expected.length === digest.length && timingSafeEqual(expected, digest)
      );
    });
    if (index < 0) return false;
    state.codes.splice(index, 1);
    this.write(state);
    return true;
  }

  private read(now: number): PairingState {
    if (!existsSync(this.path)) return { version: 1, codes: [] };
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      throw new Error(`${this.path} is not valid pairing-code state`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${this.path} does not contain pairing-code state`);
    }
    const state = value as Partial<PairingState>;
    if (
      state.version !== 1 ||
      !Array.isArray(state.codes) ||
      !state.codes.every(validStoredCode)
    ) {
      throw new Error(`${this.path} does not contain valid pairing-code state`);
    }
    return {
      version: 1,
      codes: state.codes.filter(
        (candidate) => Date.parse(candidate.expiresAt) > now
      ),
    };
  }

  private write(state: PairingState): void {
    mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 });
    writeFileAtomicSync(this.path, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}

export function normalizePairingCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z2-9]/g, "");
}

function formatPairingCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

function generatePairingCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const byte of bytes) {
    code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
  }
  return code;
}

function hashPairingCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function validStoredCode(value: unknown): value is StoredPairingCode {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const code = value as Partial<StoredPairingCode>;
  return (
    typeof code.hash === "string" &&
    /^[0-9a-f]{64}$/.test(code.hash) &&
    typeof code.createdAt === "string" &&
    Number.isFinite(Date.parse(code.createdAt)) &&
    typeof code.expiresAt === "string" &&
    Number.isFinite(Date.parse(code.expiresAt))
  );
}
