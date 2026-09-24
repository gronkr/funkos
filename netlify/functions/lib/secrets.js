// Encrypts EVM private keys at rest. Key comes from EVM_KEY_SECRET (any long random string). Without it, no EVM wallets are created.
const crypto = require("crypto");
const key = () => { const s = process.env.EVM_KEY_SECRET; if (!s) throw new Error("EVM_KEY_SECRET not set"); return crypto.createHash("sha256").update(s).digest(); };
function encrypt(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
}
function decrypt(blob) {
  const [v, iv, tag, data] = String(blob).split(".");
  if (v !== "v1") throw new Error("bad secret blob");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}
module.exports = { encrypt, decrypt, enabled: () => !!process.env.EVM_KEY_SECRET };
