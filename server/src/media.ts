/**
 * 网页媒体抓取（v1.0 · 2026-10-17）
 *
 * 【做什么】
 *   · HLS（m3u8）：解析 master/media playlist → 并发下分片 → 按序拼接 → 落盘
 *   · 直链（mp4/webm/mp3…）：流式下载
 *
 * 【为什么放 server 而不是扩展】
 *   扩展的 service worker 有内存与生命周期限制（30s 空闲被杀），长视频几百 MB 会撑爆。
 *   Node 端有文件系统、可控并发、可断点、可进度——这才是干重活的地方。
 *
 * 【不做什么】
 *   · 不碰 DRM：SAMPLE-AES / Widevine / PlayReady 一律报「不支持」，不尝试绕过
 *   · 不做转码：本机无 ffmpeg。TS 分片直接拼接即为合法 MPEG-TS（VLC/PotPlayer 可播）；
 *     fMP4 分片（带 EXT-X-MAP）拼接即为 mp4 容器。需要 mp4 时可后补 ffmpeg。
 *
 * 【参考】
 *   · RFC 8216（HTTP Live Streaming）
 *   · cat-catch（xifangczy/cat-catch, MIT）：嗅探思路与 m3u8 解析范式
 *   · Stream-Detector（Kaciis, MIT）：MV3 下用 webRequest 观察而不拦截
 */
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createDecipheriv } from "node:crypto";

export type GrabOptions = {
  outPath: string;
  concurrency?: number;   // 分片并发，默认 6（实测：>8 容易被 CDN 掐）
  maxSegments?: number;   // 只取前 N 段（调试/试看用）
  timeoutMs?: number;     // 单个请求超时，默认 30s
  onProgress?: (done: number, total: number, bytes: number) => void;
};

export type GrabResult = {
  ok: boolean;
  outPath: string;
  bytes: number;
  segments: number;
  encrypted: boolean;
  container: "ts" | "mp4" | "direct";
  durationSec: number | null;
  notes: string[];
};

type Segment = { url: string; duration: number; keyIndex: number };
type KeyInfo = { method: string; uri: string | null; iv: Buffer | null };

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

function absUrl(base: string, ref: string): string {
  try { return new URL(ref, base).toString(); } catch { return ref; }
}

async function fetchText(url: string, timeoutMs = 30000, referer?: string): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { "user-agent": UA, ...(referer ? { referer } : {}) },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchBuf(url: string, timeoutMs = 30000, referer?: string): Promise<Buffer> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { "user-agent": UA, ...(referer ? { referer } : {}) },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`);
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

/** 解析 m3u8：返回 master 变体列表，或 media 分片列表 */
export function parseM3u8(text: string, baseUrl: string):
  | { kind: "master"; variants: { url: string; bandwidth: number; resolution: string | null }[] }
  | { kind: "media"; segments: Segment[]; keys: KeyInfo[]; map: string | null; durationSec: number } {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

  // ── master playlist ──
  if (lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"))) {
    const variants: { url: string; bandwidth: number; resolution: string | null }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.startsWith("#EXT-X-STREAM-INF")) continue;
      const bw = /BANDWIDTH=(\d+)/i.exec(l);
      const res = /RESOLUTION=([0-9x]+)/i.exec(l);
      const next = lines[i + 1];
      if (next && !next.startsWith("#")) {
        variants.push({
          url: absUrl(baseUrl, next),
          bandwidth: bw ? Number(bw[1]) : 0,
          resolution: res ? res[1] : null,
        });
      }
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { kind: "master", variants };
  }

  // ── media playlist ──
  const segments: Segment[] = [];
  const keys: KeyInfo[] = [];
  let map: string | null = null;
  let duration = 0;
  let curKey = -1;
  let curDur = 0;
  let lastKeyLine = "";

  for (const l of lines) {
    if (l.startsWith("#EXT-X-KEY")) {
      if (l === lastKeyLine) continue;       // 同一 key 重复声明（常见），不重复加
      lastKeyLine = l;
      const method = /METHOD=([^,]+)/i.exec(l)?.[1] ?? "NONE";
      const uri = /URI="([^"]+)"/i.exec(l)?.[1] ?? null;
      const ivHex = /IV=0x([0-9a-fA-F]+)/i.exec(l)?.[1] ?? null;
      keys.push({
        method: method.toUpperCase(),
        uri: uri ? absUrl(baseUrl, uri) : null,
        iv: ivHex ? Buffer.from(ivHex.padStart(32, "0"), "hex") : null,
      });
      curKey = keys.length - 1;
    } else if (l.startsWith("#EXT-X-MAP")) {
      const uri = /URI="([^"]+)"/i.exec(l)?.[1] ?? null;
      if (uri) map = absUrl(baseUrl, uri);
    } else if (l.startsWith("#EXTINF:")) {
      const v = parseFloat(l.slice("#EXTINF:".length).split(",")[0]);
      curDur = Number.isFinite(v) ? v : 0;
    } else if (!l.startsWith("#")) {
      segments.push({ url: absUrl(baseUrl, l), duration: curDur, keyIndex: curKey });
      duration += curDur;
      curDur = 0;
    }
  }
  return { kind: "media", segments, keys, map, durationSec: Math.round(duration) };
}

/** 取 AES-128 的 IV：优先 EXT-X-KEY 的 IV，否则用媒体序列号（RFC 8216 §5.2） */
function ivFor(key: KeyInfo, seq: number): Buffer {
  if (key.iv) return key.iv;
  const b = Buffer.alloc(16);
  b.writeUInt32BE(seq >>> 0, 12);
  return b;
}

function decryptAes128(data: Buffer, key: Buffer, iv: Buffer): Buffer {
  const d = createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([d.update(data), d.final()]);
}

/**
 * 抓取一个 HLS 流。
 * @param url      m3u8 地址（master 或 media 都行）
 * @param opts     输出路径与并发
 * @param referer  防盗链场景必填（很多站校验 Referer）
 */
export async function grabHls(url: string, opts: GrabOptions, referer?: string): Promise<GrabResult> {
  const notes: string[] = [];
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 6, 16));
  const timeoutMs = opts.timeoutMs ?? 60000;

  let text = await fetchText(url, timeoutMs, referer);
  let parsed = parseM3u8(text, url);

  // master → 取最高码率
  if (parsed.kind === "master") {
    if (!parsed.variants.length) throw new Error("master playlist 里没有可用 variant");
    const best = parsed.variants[0];
    notes.push(
      `master: ${parsed.variants.length} 个变体，选最高 ${best.resolution ?? "?"} / ${Math.round(best.bandwidth / 1000)}kbps`
    );
    text = await fetchText(best.url, timeoutMs, referer);
    parsed = parseM3u8(text, best.url);
  }
  if (parsed.kind !== "media") throw new Error("无法解析为 media playlist");

  let segs = parsed.segments;
  if (opts.maxSegments && segs.length > opts.maxSegments) {
    notes.push(`只取前 ${opts.maxSegments} 段（原 ${segs.length} 段）`);
    segs = segs.slice(0, opts.maxSegments);
  }
  if (!segs.length) throw new Error("playlist 里没有分片");

  // ── 加密检查 ──
  const encMethods = Array.from(new Set(parsed.keys.map((k) => k.method).filter((m) => m && m !== "NONE")));
  if (encMethods.some((m) => m !== "AES-128")) {
    throw new Error(
      `不支持的加密方式：${encMethods.join("/")}（仅支持 AES-128；SAMPLE-AES / Widevine 属 DRM，本工具不做绕过）`
    );
  }
  const encrypted = encMethods.includes("AES-128");
  if (encrypted) notes.push("AES-128 加密，已在本地解密");

  // ── 取 keys ──
  let keyBufs: (Buffer | null)[] = [];
  if (encrypted) {
    keyBufs = await Promise.all(
      parsed.keys.map(async (k) => {
        if (k.method !== "AES-128" || !k.uri) return null;
        return await fetchBuf(k.uri, timeoutMs, referer);
      })
    );
  }

  const container: "ts" | "mp4" = parsed.map ? "mp4" : "ts";
  await mkdir(dirname(opts.outPath), { recursive: true });
  const ws = createWriteStream(opts.outPath);

  const write = (b: Buffer) =>
    new Promise<void>((res, rej) => {
      if (ws.write(b)) res();
      else ws.once("drain", () => res());
      ws.once("error", rej);
    });

  let bytes = 0;
  const writeChunk = async (b: Buffer) => {
    bytes += b.length;
    await write(b);
  };

  try {
    // fMP4：先写 init 段（EXT-X-MAP），否则拼接出来的 mp4 无法播
    if (parsed.map) {
      const init = await fetchBuf(parsed.map, timeoutMs, referer);
      await writeChunk(init);
      notes.push(`已写入 init 段（${init.length} bytes）`);
    }

    let done = 0;
    // 滑动窗口：并发 N 个，但**按序写入**（顺序错了视频就花）
    for (let i = 0; i < segs.length; i += concurrency) {
      const batch = segs.slice(i, i + concurrency);
      const bufs = await Promise.all(
        batch.map(async (s, k) => {
          const raw = await fetchBuf(s.url, timeoutMs, referer);
          if (!encrypted) return raw;
          const ki = s.keyIndex;
          if (ki < 0 || !keyBufs[ki]) return raw;   // 该段未加密
          return decryptAes128(raw, keyBufs[ki]!, ivFor(parsed.keys[ki], i + k));
        })
      );
      for (const b of bufs) {
        await writeChunk(b);
        done++;
        opts.onProgress?.(done, segs.length, bytes);
      }
    }
  } finally {
    await new Promise<void>((res) => ws.end(() => res()));
  }

  const st = await stat(opts.outPath).catch(() => null);
  if (st) notes.push(`落盘 ${st.size} bytes`);

  return {
    ok: true,
    outPath: opts.outPath,
    bytes,
    segments: segs.length,
    encrypted,
    container,
    durationSec: parsed.durationSec || null,
    notes,
  };
}

/** 直链下载（mp4/webm/mp3…）—— 流式写盘，不占内存 */
export async function grabDirect(url: string, opts: GrabOptions, referer?: string): Promise<GrabResult> {
  const notes: string[] = [];
  await mkdir(dirname(opts.outPath), { recursive: true });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 120000);
  let bytes = 0;
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { "user-agent": UA, ...(referer ? { referer } : {}) },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`);
    if (!r.body) throw new Error("响应没有 body");

    const ws = createWriteStream(opts.outPath);
    const reader = r.body.getReader();
    const total = Number(r.headers.get("content-length") || 0);
    let done = 0;
    for (;;) {
      const { done: fin, value } = await reader.read();
      if (fin) break;
      if (value) {
        bytes += value.length;
        ws.write(Buffer.from(value));
        done++;
        if (done % 64 === 0) opts.onProgress?.(done, total || 0, bytes);
      }
    }
    await new Promise<void>((res) => ws.end(() => res()));
  } finally {
    clearTimeout(t);
  }
  const st = await stat(opts.outPath).catch(() => null);
  if (st) notes.push(`落盘 ${st.size} bytes`);
  return {
    ok: true,
    outPath: opts.outPath,
    bytes,
    segments: 0,
    encrypted: false,
    container: "direct",
    durationSec: null,
    notes,
  };
}

/** 入口：按 URL 特征自动选 HLS 还是直链 */
export async function grabMedia(url: string, opts: GrabOptions, referer?: string): Promise<GrabResult> {
  if (/\.m3u8(\?|#|$)/i.test(url)) return grabHls(url, opts, referer);
  return grabDirect(url, opts, referer);
}
