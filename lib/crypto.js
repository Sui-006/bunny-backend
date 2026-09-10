import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';

// 凭据加密服务（EncryptionService）
// 密钥来自环境变量 ENCRYPTION_KEY，绝不落盘到前端 / DB / 源码 / localStorage。
// 密文格式：enc:v1:<iv(12B)+authTag(16B)+ciphertext> 的 base64。
// 解密兼容历史明文（迁移前已存的 key 直接返回原文，下次保存时自动加密）。
const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

function deriveKey() {
  const raw = config.encryptionKey;
  if (!raw) {
    const e = new Error('服务器未配置 ENCRYPTION_KEY，无法加密/解密凭据');
    e.code = 'CREDENTIAL_NOT_CONFIGURED';
    throw e;
  }
  return createHash('sha256').update(raw).digest(); // 32 字节密钥
}

export const EncryptionService = {
  get available() {
    return Boolean(config.encryptionKey);
  },

  isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(PREFIX);
  },

  encrypt(plain) {
    if (!plain) return '';
    const key = deriveKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
  },

  decrypt(value) {
    if (!value) return '';
    const s = String(value);
    if (!s.startsWith(PREFIX)) return s; // 历史明文，直接返回
    const buf = Buffer.from(s.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const key = deriveKey();
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  },
};
