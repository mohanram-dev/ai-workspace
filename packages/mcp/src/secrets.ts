import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";

/**
 * AES-256-GCM encryption for secrets stored in the database (MCP headers and
 * environment values). The key is derived from the server secret with HKDF,
 * so rotating that secret makes stored values unreadable (they must be re-entered).
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error("SecretBox needs a secret of at least 32 characters");
    this.key = Buffer.from(hkdfSync("sha256", secret, "aiw:secret-box", "mcp-secrets:v1", 32));
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
  }

  /** Throws when the value was tampered with or encrypted under a different secret. */
  decrypt(value: string): string {
    const [version, iv, tag, ciphertext] = value.split(":");
    if (version !== VERSION || !iv || !tag || ciphertext === undefined) throw new SecretDecryptionError();
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretDecryptionError();
    }
  }

  encryptMap(values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, this.encrypt(value)]));
  }

  decryptMap(values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, this.decrypt(value)]));
  }

  /**
   * Applies a write-only update to an encrypted map: strings replace, null
   * removes, names not mentioned keep their stored value.
   */
  applyUpdate(stored: Record<string, string>, changes: Record<string, string | null>): Record<string, string> {
    const next = { ...stored };
    for (const [name, value] of Object.entries(changes)) {
      if (value === null) delete next[name];
      else next[name] = this.encrypt(value);
    }
    return next;
  }
}

export class SecretDecryptionError extends Error {
  constructor() {
    super("A stored secret could not be decrypted. It may have been saved with a different server secret; enter it again.");
    this.name = "SecretDecryptionError";
  }
}
