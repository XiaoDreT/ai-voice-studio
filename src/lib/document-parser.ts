import { StoryboardSegment } from "@/types";
import { normalizeToHmsRange, formatSecondsToHms, parseTimecodeToSeconds } from "./timeline-utils";
import * as XLSX from "xlsx";
import mammoth from "mammoth";
import path from "path";
import fs from "fs";
import zlib from "zlib";
import { spawnSync } from "child_process";

// Regex untuk mendeteksi rentang waktu "00:00:00 - 00:00:05", "00:00 - 00:05", "00:00:00 --> 00:00:05", dll.
export const TIME_RANGE_REGEX =
  /\b(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)\s*(?:[-–—~\xad]+|-->|s\/d|sd|sampai|to|hingga|\s+)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)\b/i;

export const SINGLE_TIMECODE_REGEX = /\b(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)\b/g;

/**
 * Mendekode seluruh entitas XML dan HTML (bernama maupun numerik)
 * seperti &apos; -> ', &quot; -> ", &amp; -> &, &lt; -> <, &#39; -> ', dll.
 */
export function decodeHtmlAndXmlEntities(text: string): string {
  if (!text) return "";
  let cur = text;
  // Multi-pass untuk menangani entitas bersarang (misal &amp;apos; -> &apos; -> ')
  for (let pass = 0; pass < 2; pass++) {
    const next = cur
      .replace(/&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lsquo;/gi, "'")
      .replace(/&rsquo;/gi, "'")
      .replace(/&ldquo;/gi, '"')
      .replace(/&rdquo;/gi, '"')
      .replace(/&ndash;/gi, "–")
      .replace(/&mdash;/gi, "—")
      .replace(/&hellip;/gi, "...")
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/**
 * Memeriksa apakah teks merupakan nomor/footer halaman (misal "Page 1 of 1", "Halaman 1 dari 1")
 */
export function isPageFooterOrMeta(text: string): boolean {
  if (!text) return true;
  const clean = text.trim();
  const low = clean.toLowerCase();

  return (
    /^(?:page|halaman|hlm|hal\.?)\s*\d+(\s*(?:of|\/|dari)\s*\d+)?$/i.test(low) ||
    /^\d+\s*(?:of|\/|dari)\s*\d+$/i.test(low) ||
    /^-\s*\d+\s*-$/.test(low) ||
    /^(?:confidential|rahasia|all rights reserved|hak cipta dilindungi)/i.test(low)
  );
}

/**
 * Membersihkan naskah akhir:
 * - Mendekode entitas XML/HTML (&apos;, &quot;, dll.)
 * - Menghilangkan footer halaman ("Page 1 of 1") yang tersangkut di akhir sel
 * - Menormalkan spasi berlebih
 */
export function sanitizeCleanScriptText(text: string): string {
  if (!text) return "";
  let clean = decodeHtmlAndXmlEntities(text);

  // Hapus nomor halaman/footer yang menempel di ujung naskah
  clean = clean.replace(/\s*(?:page|halaman|hlm|hal\.?)\s*\d+(\s*(?:of|\/|dari)\s*\d+)?\s*$/i, "");
  clean = clean.replace(/\s*\b\d+\s*(?:of|\/|dari)\s*\d+\s*$/i, "");
  clean = clean.replace(/\s*-\s*\d+\s*-\s*$/, "");

  return clean.replace(/\s+/g, " ").trim();
}

/**
 * Memeriksa apakah teks merupakan header tabel storyboard atau metadata file
 * agar tidak salah dideteksi sebagai naskah voice over ataupun visual.
 */
export function isTableHeaderOrMeta(text: string): boolean {
  if (!text) return true;
  const clean = decodeHtmlAndXmlEntities(text).replace(/\s+/g, " ").trim();
  const low = clean.toLowerCase();
  const normAlpha = low.replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();

  const exactHeaders = new Set([
    "estimasi waktu",
    "estimasi",
    "waktu",
    "durasi",
    "rentang waktu",
    "timestamp",
    "time",
    "time range",
    "no",
    "nomor",
    "segmen",
    "segment",
    "arahan visual adegan video",
    "arahan visual adegan",
    "arahan visual",
    "adegan video",
    "visual",
    "video",
    "naskah voice over audio",
    "naskah voice over",
    "voice over audio",
    "voice over",
    "audio",
    "naskah",
    "narasi",
    "dialog",
    "teks",
    "text",
    "estimasi waktu arahan visual adegan video naskah voice over audio",
    "estimasi waktu arahan visual naskah voice over",
    "arahan visual adegan video naskah voice over audio",
  ]);

  if (exactHeaders.has(normAlpha)) {
    return true;
  }

  // Metadata prefixes
  const metaPrefixes = [
    "naskah voice over -",
    "naskah voice over –",
    "karakter suara:",
    "file video referensi:",
    "estimasi waktu arahan visual",
    "tabel storyboard",
    "panduan voice over",
    "tutorial flow",
  ];

  if (metaPrefixes.some((p) => low.startsWith(p))) {
    return true;
  }

  return false;
}

/**
 * Memeriksa apakah suatu teks murni HANYA berisi rentang waktu (misal "00:00:00 - 00:00:05"
 * atau "00:00 - 00:05" atau "00:00:00 00:00:05").
 */
export function isPureTimeRangeText(txt: string): [string, string] | null {
  if (!txt) return null;
  const matches = Array.from(txt.matchAll(SINGLE_TIMECODE_REGEX));
  if (matches.length === 2) {
    const rem = txt
      .replace(SINGLE_TIMECODE_REGEX, "")
      .replace(/[\s\-–—~\xad:.,/()detiksampaihinggatosd>]+/gi, "")
      .trim();
    if (!rem) {
      return [matches[0][1], matches[1][1]];
    }
  }
  return null;
}

/**
 * Menggabungkan rentang waktu yang terpotong baris baru pada sel tabel sempit
 * Contoh: "00:00:00 -\n00:00:05" atau "00:00:00\n00:00:05" -> "00:00:00 - 00:00:05"
 */
export function normalizeWrappedTimeRanges(text: string): string {
  if (!text) return "";
  return text.replace(
    /\b(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)\s*[-–—~\xad]*\s*\r?\n\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)\b/g,
    "$1 - $2"
  );
}

/**
 * Parser untuk blok-blok sel berurutan:
 * [Sel Waktu] -> [Sel Arahan Visual] -> [Sel Naskah Voice Over]
 */
export function parseSequentialTableBlocks(blocks: string[]): StoryboardSegment[] {
  const cleanedBlocks = blocks
    .map((b) => sanitizeCleanScriptText(b))
    .filter((b) => b && !isTableHeaderOrMeta(b) && !isPageFooterOrMeta(b));

  const timeIndices: Array<{ idx: number; timeRange: string }> = [];

  for (let idx = 0; idx < cleanedBlocks.length; idx++) {
    const blk = cleanedBlocks[idx];
    const pureTc = isPureTimeRangeText(blk);
    if (pureTc) {
      timeIndices.push({
        idx,
        timeRange: normalizeToHmsRange(`${pureTc[0]} - ${pureTc[1]}`),
      });
      continue;
    }
    const m = blk.match(TIME_RANGE_REGEX);
    if (m && m.index !== undefined && m.index === 0 && blk.length <= m[0].length + 4) {
      timeIndices.push({
        idx,
        timeRange: normalizeToHmsRange(m[0]),
      });
    }
  }

  if (timeIndices.length === 0) return [];

  const segments: StoryboardSegment[] = [];

  for (let tPos = 0; tPos < timeIndices.length; tPos++) {
    const cur = timeIndices[tPos];
    const nextIdx = tPos + 1 < timeIndices.length ? timeIndices[tPos + 1].idx : cleanedBlocks.length;
    const contentBlocks = cleanedBlocks.slice(cur.idx + 1, nextIdx);

    if (contentBlocks.length === 0) continue;

    let visTxt = "";
    let voTxt = "";

    if (contentBlocks.length >= 2) {
      visTxt = contentBlocks[0];
      voTxt = contentBlocks.slice(1).join(" ");
    } else {
      const single = contentBlocks[0];
      const parts = single.split(/[|\t]|\s{2,}/).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        visTxt = parts[0];
        voTxt = parts.slice(1).join(" ");
      } else {
        voTxt = single;
      }
    }

    const cleanVis = sanitizeCleanScriptText(visTxt);
    const cleanVo = sanitizeCleanScriptText(voTxt);

    if (cleanVo || cleanVis) {
      segments.push({
        time_range: cur.timeRange,
        visual: cleanVis,
        text: cleanVo,
      });
    }
  }

  return segments;
}

/**
 * Mengubah matriks baris tabel 2/3/4 kolom dari Word (HTML), Excel, atau CSV
 * menjadi daftar StoryboardSegment yang presisi.
 */
export function parseGenericTableRows(rows: string[][]): StoryboardSegment[] {
  const segments: StoryboardSegment[] = [];
  if (!rows || rows.length === 0) return segments;

  let currentStart = 0;

  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const rawCells = rows[rIdx] || [];
    const cells = rawCells.map((c) => sanitizeCleanScriptText(c || ""));

    if (!cells.some(Boolean)) continue;

    const joined = cells.join(" ").toLowerCase();
    // Abaikan header tabel atau footer
    if (
      (rIdx === 0 && (joined.includes("estimasi") || joined.includes("waktu") || (joined.includes("visual") && joined.includes("naskah")))) ||
      isPageFooterOrMeta(joined)
    ) {
      continue;
    }

    // Deteksi sel mana yang berisi timestamp
    let timeIdx = -1;
    let detectedTimeRange = "";

    for (let cIdx = 0; cIdx < cells.length; cIdx++) {
      const cell = cells[cIdx];
      const m = cell.match(TIME_RANGE_REGEX);
      if (m) {
        timeIdx = cIdx;
        detectedTimeRange = normalizeToHmsRange(m[0]);
        break;
      }
    }

    let vis = "";
    let vo = "";
    let tr = "";

    if (timeIdx !== -1) {
      tr = detectedTimeRange;
      const otherCells = cells.filter((_, idx) => idx !== timeIdx);

      // Jika ada kolom Nomor sebelum kolom waktu (e.g. [No, Waktu, Visual, Naskah])
      const nonNumericOthers = otherCells.filter((c, idx) => {
        if (idx === 0 && timeIdx > 0 && /^\d+$/.test(c)) return false;
        return true;
      });

      if (nonNumericOthers.length >= 2) {
        vis = nonNumericOthers[0];
        vo = nonNumericOthers.slice(1).join(" ");
      } else if (nonNumericOthers.length === 1) {
        vo = nonNumericOthers[0];
      }
    } else {
      // Baris tanpa timestamp eksplisit: abaikan jika header
      if (isTableHeaderOrMeta(joined)) continue;

      let contentCells = cells;
      if (cells.length >= 2 && /^\d+$/.test(cells[0])) {
        contentCells = cells.slice(1);
      }

      if (contentCells.length >= 2) {
        vis = contentCells[0];
        vo = contentCells.slice(1).join(" ");
      } else if (contentCells.length === 1) {
        vo = contentCells[0];
      }

      if (!vo && !vis) continue;

      const words = (vo || vis).split(/\s+/).length;
      const dur = Math.max(4, Math.round(words / 2.3));
      tr = `${formatSecondsToHms(currentStart, true)} - ${formatSecondsToHms(currentStart + dur, true)}`;
      currentStart += dur + 1;
    }

    const cleanVis = sanitizeCleanScriptText(vis);
    const cleanVo = sanitizeCleanScriptText(vo);

    if (cleanVo || cleanVis) {
      segments.push({
        time_range: tr,
        visual: cleanVis,
        text: cleanVo,
      });
    }
  }

  return segments;
}

/**
 * Parser teks storyboard multi-format (TXT, MD, PDF text, Subtitles).
 * Mendukung pembatas Pipa (|), Tab (\t), Multi-Spasi (layout table), serta label eksplisit.
 */
export function parseRawTimelineText(
  rawText: string,
  autoGenerateIfNoTimestamps: boolean = false
): StoryboardSegment[] {
  if (!rawText || !rawText.trim()) return [];

  const decodedRaw = decodeHtmlAndXmlEntities(rawText);
  const normalized = normalizeWrappedTimeRanges(decodedRaw);

  // 1. Cek apakah teks terbagi menjadi blok-blok sel berurutan antar paragraf kosong
  const paraBlocks = normalized
    .split(/\n\s*\n|\r\n\s*\r\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  if (paraBlocks.length >= 3) {
    const seqSegs = parseSequentialTableBlocks(paraBlocks);
    if (seqSegs.length > 0) {
      return seqSegs;
    }
  }

  const lines = normalized
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.toLowerCase().startsWith("webvtt") && !/^\d+$/.test(l));

  // 2. Cek apakah baris-baris tunggal mengikuti format sel berurutan (Waktu -> Visual -> Audio)
  const standaloneTimeLines = lines.filter((l) => isPureTimeRangeText(l) !== null).length;
  if (standaloneTimeLines >= 1) {
    const seqLineSegs = parseSequentialTableBlocks(lines);
    if (seqLineSegs.length > 0) {
      return seqLineSegs;
    }
  }

  // 3. Stateful line-by-line parsing
  const segments: StoryboardSegment[] = [];
  let pendingRange: string | null = null;
  let pendingVisual = "";
  let pendingText: string | null = null;
  let pendingLines: string[] = [];
  let cursorTime = 0;

  const flushPending = () => {
    if (!pendingRange && !pendingText && !pendingVisual && pendingLines.length === 0) {
      return;
    }

    let finalVisual = pendingVisual.trim();
    let finalText = (pendingText !== null ? pendingText : pendingLines.join(" ")).trim();

    // Jika visual kosong tapi naskah memiliki pemisah kolom (| atau \t atau 2+ spasi)
    if (!finalVisual && finalText) {
      const parts = finalText.split(/[|\t]|\s{2,}/).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        finalVisual = parts[0];
        finalText = parts.slice(1).join(" ");
      }
    }

    const cleanVis = sanitizeCleanScriptText(finalVisual);
    const cleanVo = sanitizeCleanScriptText(finalText);

    if (cleanVo || cleanVis) {
      let tr = pendingRange;
      if (!tr) {
        const words = (cleanVo || cleanVis).split(/\s+/).length;
        const dur = Math.max(4, Math.round(words / 2.3));
        tr = `${formatSecondsToHms(cursorTime, true)} - ${formatSecondsToHms(cursorTime + dur, true)}`;
        cursorTime += dur + 1;
      } else {
        const parts = tr.split(/\s*-\s*/);
        if (parts.length === 2) {
          cursorTime = parseTimecodeToSeconds(parts[1]) + 1;
        }
      }

      segments.push({
        time_range: normalizeToHmsRange(tr),
        visual: cleanVis,
        text: cleanVo,
      });
    }

    pendingRange = null;
    pendingVisual = "";
    pendingText = null;
    pendingLines = [];
  };

  for (const line of lines) {
    if (
      (isTableHeaderOrMeta(line) && !line.match(TIME_RANGE_REGEX)) ||
      isPageFooterOrMeta(line)
    ) {
      continue;
    }

    const low = line.toLowerCase();

    // 1. Label Teks / Naskah
    if (
      low.startsWith("teks:") ||
      low.startsWith("naskah:") ||
      low.startsWith("audio:") ||
      low.startsWith("narasi:") ||
      low.startsWith("voice over:")
    ) {
      const val = line.substring(line.indexOf(":") + 1).trim();
      if (pendingText !== null && pendingRange !== null) {
        flushPending();
      }
      pendingText = val;
      continue;
    }

    // 2. Label Visual
    if (
      low.startsWith("visual:") ||
      low.startsWith("arahan visual:") ||
      low.startsWith("adegan:") ||
      low.startsWith("video:")
    ) {
      pendingVisual = line.substring(line.indexOf(":") + 1).trim();
      continue;
    }

    // 3. Label Durasi / Waktu
    if (
      low.startsWith("durasi:") ||
      low.startsWith("waktu:") ||
      low.startsWith("estimasi waktu:") ||
      low.startsWith("timestamp:")
    ) {
      const m = line.match(TIME_RANGE_REGEX);
      if (m) {
        if (pendingRange !== null) {
          flushPending();
        }
        pendingRange = normalizeToHmsRange(m[0]);
        if (pendingText !== null) {
          flushPending();
        }
      }
      continue;
    }

    // 4. Rentang Waktu di awal baris
    const m = line.match(TIME_RANGE_REGEX);
    if (m && m.index !== undefined && m.index <= 15) {
      flushPending();
      pendingRange = normalizeToHmsRange(m[0]);
      let rest = line.substring(m.index + m[0].length).replace(/^[:\s|–—\t-]+/, "").trim();
      rest = rest.replace(/^\(detik.*?\)\s*/i, "").trim();

      if (rest) {
        const parts = rest.split(/[|\t]|\s{2,}/).map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 2) {
          pendingVisual = parts[0];
          pendingText = parts.slice(1).join(" ");
        } else {
          pendingLines.push(rest);
        }
      }
      continue;
    }

    // 5. Baris lanjutan di bawah rentang waktu yang sedang aktif
    if (pendingRange !== null) {
      if (pendingText !== null) {
        pendingText += " " + line;
      } else if (pendingVisual && !pendingLines.length) {
        pendingText = line;
      } else {
        pendingLines.push(line);
      }
      continue;
    }

    // 6. Fallback baris bebas jika auto-generate timestamp diaktifkan
    if (autoGenerateIfNoTimestamps && line.length > 5 && !isTableHeaderOrMeta(line) && !isPageFooterOrMeta(line)) {
      pendingLines.push(line);
      flushPending();
    }
  }

  flushPending();

  if (segments.length > 0) {
    return segments;
  }

  // Fallback hanya jika dokumen narasi polos tanpa timestamp sama sekali
  if (autoGenerateIfNoTimestamps) {
    const paras = paraBlocks.filter((p) => !isTableHeaderOrMeta(p) && !isPageFooterOrMeta(p));
    let cur = 0;
    for (const p of paras) {
      const cleanP = sanitizeCleanScriptText(p);
      if (!cleanP) continue;
      const words = cleanP.split(/\s+/).length;
      const dur = Math.max(4, Math.round(words / 2.3));
      segments.push({
        time_range: `${formatSecondsToHms(cur, true)} - ${formatSecondsToHms(cur + dur, true)}`,
        visual: "",
        text: cleanP,
      });
      cur += dur + 1;
    }
  }

  return segments;
}

/**
 * Ekstraktor bounding-box presisi tinggi dari XML `pdftotext -bbox`.
 * Merekonstruksi tabel 3 kolom (Estimasi Waktu | Arahan Visual | Naskah Voice Over)
 * berdasarkan posisi koordinat X (kolom) dan Y (baris) per kata.
 */
export interface BboxWord {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  text: string;
}

export function groupWordsIntoLines(words: BboxWord[]): Array<{ y: number; text: string }> {
  if (!words.length) return [];
  const sorted = [...words].sort((a, b) => {
    if (Math.abs(a.ymin - b.ymin) > 4.2) return a.ymin - b.ymin;
    return a.xmin - b.xmin;
  });

  const groups: BboxWord[][] = [];
  for (const w of sorted) {
    if (!groups.length || Math.abs(w.ymin - groups[groups.length - 1][0].ymin) > 4.2) {
      groups.push([w]);
    } else {
      groups[groups.length - 1].push(w);
    }
  }

  return groups.map((g) => {
    g.sort((a, b) => a.xmin - b.xmin);
    const avgY = g.reduce((acc, cur) => acc + cur.ymin, 0) / g.length;
    const lineTxt = g.map((item) => item.text).join(" ");
    return { y: avgY, text: lineTxt };
  });
}

function extractTimeRangesFromColLines(
  timeLinesRaw: Array<{ y: number; text: string }>
): Array<{ y: number; start: string; end: string }> {
  const tcTokens: Array<{ y: number; tc: string }> = [];
  for (const tl of timeLinesRaw) {
    const matches = Array.from(tl.text.matchAll(SINGLE_TIMECODE_REGEX));
    for (const m of matches) {
      tcTokens.push({ y: tl.y, tc: m[1] });
    }
  }

  const result: Array<{ y: number; start: string; end: string }> = [];
  let idx = 0;
  while (idx < tcTokens.length) {
    const t1 = tcTokens[idx];
    if (idx + 1 < tcTokens.length) {
      const t2 = tcTokens[idx + 1];
      // Jika berada di baris yang sama atau baris terpotong dalam sel yang sama (jarak Y <= 50pt)
      if (t2.y - t1.y >= 0 && t2.y - t1.y <= 50) {
        result.push({ y: t1.y, start: t1.tc, end: t2.tc });
        idx += 2;
        continue;
      }
    }
    idx += 1;
  }
  return result;
}

export function extractStoryboardFromPagesWords(pagesWords: BboxWord[][]): StoryboardSegment[] {
  if (!pagesWords.length) return [];

  const visHeaderXmins: number[] = [];
  const voHeaderXmins: number[] = [];
  const headerYByPage: Record<number, number> = {};

  for (let pIdx = 0; pIdx < pagesWords.length; pIdx++) {
    const words = pagesWords[pIdx];
    const linesAll = groupWordsIntoLines(words);
    for (const ln of linesAll) {
      const low = ln.text.toLowerCase();
      const isHeaderRow =
        low.includes("estimasi waktu") ||
        (low.includes("arahan visual") && low.includes("naskah")) ||
        (low.includes("adegan video") && low.includes("audio")) ||
        (low.includes("visual") && (low.includes("voice") || low.includes("naskah")));

      if (isHeaderRow) {
        headerYByPage[pIdx] = ln.y;
        const hdrWords = words
          .filter((w) => Math.abs(w.ymin - ln.y) <= 20)
          .sort((a, b) => a.xmin - b.xmin);

        for (const w of hdrWords) {
          const wLow = w.text.toLowerCase();
          if (
            (wLow.includes("visual") || wLow.includes("arahan") || wLow.includes("adegan") || wLow.includes("video")) &&
            w.xmin > 70
          ) {
            visHeaderXmins.push(w.xmin);
            break;
          }
        }

        const minVis = visHeaderXmins.length ? Math.min(...visHeaderXmins) : 185;
        for (const w of hdrWords) {
          const wLow = w.text.toLowerCase();
          if (
            (wLow.includes("naskah") || wLow.includes("voice") || wLow.includes("narasi") || wLow.includes("audio") || wLow.includes("dialog") || wLow.includes("teks")) &&
            w.xmin > minVis + 30
          ) {
            voHeaderXmins.push(w.xmin);
            break;
          }
        }
      }
    }
  }

  const xVisualStart = visHeaderXmins.length ? Math.min(...visHeaderXmins) - 8 : 185;
  const xVoStart = voHeaderXmins.length ? Math.min(...voHeaderXmins) - 8 : 355;

  const segments: StoryboardSegment[] = [];

  for (let pIdx = 0; pIdx < pagesWords.length; pIdx++) {
    const words = pagesWords[pIdx];
    const minY = (headerYByPage[pIdx] ?? 0) + 4;
    const colTimeW: BboxWord[] = [];
    const colVisW: BboxWord[] = [];
    const colVoW: BboxWord[] = [];

    for (const w of words) {
      if (w.ymin <= minY) continue;
      if (w.xmin < xVisualStart) {
        colTimeW.push(w);
      } else if (w.xmin < xVoStart) {
        colVisW.push(w);
      } else {
        colVoW.push(w);
      }
    }

    const timeLines = groupWordsIntoLines(colTimeW).filter((l) => !isTableHeaderOrMeta(l.text) && !isPageFooterOrMeta(l.text));
    const visLines = groupWordsIntoLines(colVisW).filter((l) => !isTableHeaderOrMeta(l.text) && !isPageFooterOrMeta(l.text));
    const voLines = groupWordsIntoLines(colVoW).filter((l) => !isTableHeaderOrMeta(l.text) && !isPageFooterOrMeta(l.text));

    const colTimeRanges = extractTimeRangesFromColLines(timeLines);

    for (let idx = 0; idx < colTimeRanges.length; idx++) {
      const cur = colTimeRanges[idx];
      const yTop = cur.y - 4;
      const yBot = idx + 1 < colTimeRanges.length ? colTimeRanges[idx + 1].y - 4 : 99999;

      const segVis = visLines
        .filter((l) => l.y >= yTop && l.y < yBot)
        .map((l) => l.text)
        .join(" ");

      const segVo = voLines
        .filter((l) => l.y >= yTop && l.y < yBot)
        .map((l) => l.text)
        .join(" ");

      const cleanVis = sanitizeCleanScriptText(segVis);
      const cleanVo = sanitizeCleanScriptText(segVo);

      if (cleanVo || cleanVis) {
        segments.push({
          time_range: normalizeToHmsRange(`${cur.start} - ${cur.end}`),
          visual: cleanVis,
          text: cleanVo,
        });
      }
    }
  }

  return segments;
}

/**
 * Memuat modul PDF.js legacy secara dinamis dan aman untuk lingkungan serverless (Vercel).
 */
async function loadPdfJsModule(): Promise<any> {
  try {
    const cjsIndex = require.resolve("pdf-parse");
    const pdfjsLegacyPath = (require.resolve as any)(/*turbopackIgnore: true*/ "pdfjs-dist/legacy/build/pdf.mjs", {
      paths: [path.dirname(cjsIndex), path.join(path.dirname(cjsIndex), "..", "..")],
    });
    return await import(/*turbopackIgnore: true*/ "file://" + pdfjsLegacyPath);
  } catch {
    try {
      // @ts-ignore - Dynamic server import
      return await import(/*turbopackIgnore: true*/ "pdfjs-dist/legacy/build/pdf.mjs");
    } catch {
      return null;
    }
  }
}

/**
 * Ekstraksi tabel storyboard menggunakan PDF.js in-process parser.
 * Mengonversi seluruh teks halaman ke format koordinat BboxWord (X, Y) untuk
 * merekonstruksi tabel 3 kolom (Estimasi Waktu | Arahan Visual | Naskah Voice Over)
 * dengan presisi pixel tinggi tanpa membutuhkan binary poppler eksternal.
 */
async function extractPdfStoryboardWithPdfJs(buffer: Buffer): Promise<StoryboardSegment[]> {
  try {
    const pdfjs = await loadPdfJsModule();
    if (!pdfjs || !pdfjs.getDocument) return [];

    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false,
    }).promise;

    const pagesWords: BboxWord[][] = [];
    const allPageLines: string[] = [];

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1.0 });
      const textContent = await page.getTextContent();
      const words: BboxWord[] = [];

      for (const item of textContent.items as any[]) {
        if (!item || !item.str || !item.str.trim()) continue;
        const tx = typeof item.transform?.[4] === "number" ? item.transform[4] : 0;
        const ty = typeof item.transform?.[5] === "number" ? item.transform[5] : 0;
        const h = typeof item.height === "number" && item.height > 0 ? item.height : 10;
        const w = typeof item.width === "number" && item.width > 0 ? item.width : 20;

        words.push({
          xmin: tx,
          ymin: Math.max(0, viewport.height - ty - h),
          xmax: tx + w,
          ymax: Math.max(0, viewport.height - ty),
          text: decodeHtmlAndXmlEntities(item.str.trim()),
        });
      }

      if (words.length > 0) {
        pagesWords.push(words);
        const pageLines = groupWordsIntoLines(words);
        for (const pl of pageLines) {
          if (!isPageFooterOrMeta(pl.text)) {
            allPageLines.push(pl.text);
          }
        }
      }
    }

    // 1. Prioritas: Rekonstruksi struktur tabel 3 kolom berdasarkan koordinat geometris
    if (pagesWords.length > 0) {
      const bboxSegments = extractStoryboardFromPagesWords(pagesWords);
      if (bboxSegments.length > 0) {
        return bboxSegments;
      }
    }

    // 2. Fallback: Ekstraksi baris teks dalam urutan baca alami
    if (allPageLines.length > 0) {
      const combined = allPageLines.join("\n");
      let parsed = parseRawTimelineText(combined, false);
      if (parsed.length === 0) {
        parsed = parseRawTimelineText(combined, true);
      }
      if (parsed.length > 0) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn("[extractPdfStoryboardWithPdfJs] PDF.js extraction error:", err);
  }

  return [];
}

/**
 * Ekstraksi stream teks PDF murni menggunakan Node.js built-in zlib.
 * Mendekompresi seluruh stream /FlateDecode dan mengekstrak teks asli
 * dari operator Tj / TJ, tanpa pernah memproses sintaks biner objek PDF.
 */
function extractPdfStoryboardWithZlibStream(buffer: Buffer): StoryboardSegment[] {
  try {
    const textChunks: string[] = [];
    let idx = 0;

    while (idx < buffer.length) {
      const streamStart = buffer.indexOf(Buffer.from("stream"), idx);
      if (streamStart === -1) break;

      let dataStart = streamStart + 6;
      if (buffer[dataStart] === 0x0d && buffer[dataStart + 1] === 0x0a) {
        dataStart += 2;
      } else if (buffer[dataStart] === 0x0a) {
        dataStart += 1;
      }

      const streamEnd = buffer.indexOf(Buffer.from("endstream"), dataStart);
      if (streamEnd === -1) break;

      const chunk = buffer.subarray(dataStart, streamEnd);
      let decompressed = "";

      try {
        decompressed = zlib.inflateSync(chunk).toString("latin1");
      } catch {
        try {
          decompressed = zlib.inflateRawSync(chunk).toString("latin1");
        } catch {
          decompressed = chunk.toString("latin1");
        }
      }

      if (decompressed) {
        // Operator Tj: (text) Tj
        const tjRegex = /\(([^)]+)\)\s*Tj/g;
        let m: RegExpExecArray | null;
        while ((m = tjRegex.exec(decompressed)) !== null) {
          const decoded = decodeHtmlAndXmlEntities(m[1].replace(/\\([()\\])/g, "$1")).trim();
          if (decoded && !isTableHeaderOrMeta(decoded) && !isPageFooterOrMeta(decoded)) {
            textChunks.push(decoded);
          }
        }

        // Operator TJ: [(text1) 20 (text2)] TJ
        const tjArrayRegex = /\[([^\]]+)\]\s*TJ/g;
        while ((m = tjArrayRegex.exec(decompressed)) !== null) {
          const inner = m[1];
          const subMatches = inner.match(/\(([^)]+)\)/g);
          if (subMatches) {
            const line = subMatches
              .map((s) => s.slice(1, -1).replace(/\\([()\\])/g, "$1"))
              .join("");
            const decoded = decodeHtmlAndXmlEntities(line).trim();
            if (decoded && !isTableHeaderOrMeta(decoded) && !isPageFooterOrMeta(decoded)) {
              textChunks.push(decoded);
            }
          }
        }
      }

      idx = streamEnd + 9;
    }

    if (textChunks.length > 0) {
      const combined = textChunks.join("\n");
      let parsed = parseRawTimelineText(combined, false);
      if (parsed.length === 0) {
        parsed = parseRawTimelineText(combined, true);
      }
      if (parsed.length > 0) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn("[extractPdfStoryboardWithZlibStream] Error:", err);
  }

  return [];
}

/**
 * Ekstraksi tabel storyboard dari PDF dengan pendekatan multi-tier yang sangat tangguh:
 * 1. pdftotext -bbox (poppler-utils) -> Presisi koordinat 3 kolom jika tersedia di server
 * 2. PDF.js Bounding-Box Parser -> Presisi tinggi murni JavaScript, 100% aman untuk Vercel Serverless
 * 3. pdftotext -layout & standard -> Fallback layout multi-spasi
 * 4. Pure Node.js Zlib Stream Decompressor -> Fallback dekompresi FlateDecode tanpa ketergantungan luar
 */
export async function parsePdfStoryboard(buffer: Buffer): Promise<StoryboardSegment[]> {
  // Tier 1: Coba pdftotext -bbox (poppler-utils)
  try {
    const resBbox = spawnSync("pdftotext", ["-bbox", "-", "-"], {
      input: buffer,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15000,
    });

    if (resBbox.status === 0 && resBbox.stdout) {
      const xml = resBbox.stdout.toString("utf-8");
      const pagePattern = /<page\s+[^>]*width="([\d.]+)"\s+height="([\d.]+)"[^>]*>([\s\S]*?)<\/page>/gi;
      const wordPattern = /<word\s+xMin="([\d.]+)"\s+yMin="([\d.]+)"\s+xMax="([\d.]+)"\s+yMax="([\d.]+)">(.*?)<\/word>/gi;

      const pagesWords: BboxWord[][] = [];
      let pMatch: RegExpExecArray | null;

      while ((pMatch = pagePattern.exec(xml)) !== null) {
        const pageXml = pMatch[3];
        const words: BboxWord[] = [];
        let wMatch: RegExpExecArray | null;
        while ((wMatch = wordPattern.exec(pageXml)) !== null) {
          const decodedWord = decodeHtmlAndXmlEntities(wMatch[5]).trim();
          if (decodedWord) {
            words.push({
              xmin: parseFloat(wMatch[1]),
              ymin: parseFloat(wMatch[2]),
              xmax: parseFloat(wMatch[3]),
              ymax: parseFloat(wMatch[4]),
              text: decodedWord,
            });
          }
        }
        if (words.length > 0) {
          pagesWords.push(words);
        }
      }

      if (pagesWords.length > 0) {
        const bboxSegments = extractStoryboardFromPagesWords(pagesWords);
        if (bboxSegments.length > 0) {
          return bboxSegments;
        }
      }
    }
  } catch {
    // pdftotext tidak tersedia, lanjut ke Tier 2
  }

  // Tier 2: PDF.js In-Process Bounding-Box Parser (Universal, 100% Serverless & Pure JS, Aman di Vercel)
  try {
    const pdfJsSegments = await extractPdfStoryboardWithPdfJs(buffer);
    if (pdfJsSegments.length > 0) {
      return pdfJsSegments;
    }
  } catch (err) {
    console.warn("[parsePdfStoryboard] PDF.js extraction error:", err);
  }

  // Tier 3: Coba pdftotext -layout
  try {
    const resLayout = spawnSync("pdftotext", ["-layout", "-", "-"], {
      input: buffer,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15000,
    });

    if (resLayout.status === 0 && resLayout.stdout) {
      const layoutText = resLayout.stdout.toString("utf-8");
      if (layoutText.trim()) {
        const layoutSegments = parseRawTimelineText(layoutText, false);
        if (layoutSegments.length > 0) {
          return layoutSegments;
        }
      }
    }
  } catch {
    // Abaikan jika pdftotext tidak tersedia
  }

  // Tier 4: Pure Node.js Zlib Stream Decompressor (Zero external dependencies)
  const zlibSegments = extractPdfStoryboardWithZlibStream(buffer);
  if (zlibSegments.length > 0) {
    return zlibSegments;
  }

  // PENTING: Jangan pernah decode buffer binary PDF sebagai string mentah!
  return [];
}

/**
 * Ekstraksi tabel dari dokumen Word (.docx / .doc)
 */
export async function parseDocxStoryboard(buffer: Buffer): Promise<StoryboardSegment[]> {
  try {
    // 1. Prioritas: Mammoth konversi ke HTML tabel
    const htmlResult = await mammoth.convertToHtml({ buffer });
    if (htmlResult && htmlResult.value) {
      const tableMatches = htmlResult.value.match(/<table[\s\S]*?<\/table>/gi);
      if (tableMatches && tableMatches.length > 0) {
        const allRows: string[][] = [];
        for (const tbl of tableMatches) {
          const rowMatches = tbl.match(/<tr[\s\S]*?<\/tr>/gi) || [];
          for (const tr of rowMatches) {
            const cellMatches = tr.match(/<td[\s\S]*?<\/td>/gi) || tr.match(/<th[\s\S]*?<\/th>/gi) || [];
            const cells = cellMatches.map((c) => {
              const stripped = c.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
              return sanitizeCleanScriptText(stripped);
            });
            if (cells.some(Boolean)) {
              allRows.push(cells);
            }
          }
        }

        const tableSegments = parseGenericTableRows(allRows);
        if (tableSegments.length > 0) {
          return tableSegments;
        }
      }
    }

    // 2. Fallback: Ekstraksi teks paragraf
    const textResult = await mammoth.extractRawText({ buffer });
    if (textResult && textResult.value) {
      let textSegments = parseRawTimelineText(textResult.value, false);
      if (textSegments.length === 0) {
        textSegments = parseRawTimelineText(textResult.value, true);
      }
      if (textSegments.length > 0) {
        return textSegments;
      }
    }
  } catch (e) {
    console.error("[parseDocxStoryboard] Gagal memproses Word document:", e);
  }

  return [];
}

/**
 * Ekstraksi dari Spreadsheet (.xlsx, .xls, .csv, .tsv)
 */
export function parseSpreadsheetStoryboard(buffer: Buffer, ext: string): StoryboardSegment[] {
  try {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 });
      if (!rows || rows.length === 0) continue;

      const stringRows = rows.map((r) =>
        Array.isArray(r) ? r.map((c) => sanitizeCleanScriptText(String(c ?? ""))) : []
      );

      const segments = parseGenericTableRows(stringRows);
      if (segments.length > 0) {
        return segments;
      }
    }
  } catch (e) {
    console.error(`[parseSpreadsheetStoryboard] Gagal parse ${ext}:`, e);
  }

  return [];
}

/**
 * Ekstraksi dari file Subtitle (.srt, .vtt)
 */
export function parseSubtitleStoryboard(text: string): StoryboardSegment[] {
  const segments: StoryboardSegment[] = [];
  const cueRegex = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/gi;

  const decoded = decodeHtmlAndXmlEntities(text);
  const blocks = decoded.split(/\n\s*\n|\r\n\s*\r\n/).map((b) => b.trim()).filter(Boolean);

  for (const blk of blocks) {
    const lines = blk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let timeRange = "";
    const contentLines: string[] = [];

    for (const ln of lines) {
      const m = ln.match(cueRegex);
      if (m) {
        const parts = ln.split(/\s*-->\s*/);
        if (parts.length === 2) {
          timeRange = normalizeToHmsRange(`${parts[0].replace(/,/g, ".")} - ${parts[1].replace(/,/g, ".")}`);
        }
      } else if (!/^\d+$/.test(ln) && ln.toLowerCase() !== "webvtt") {
        contentLines.push(ln);
      }
    }

    if (timeRange && contentLines.length > 0) {
      let fullText = contentLines.join(" ").trim();
      let visual = "";

      // Cek format [Visual] Text
      const visBracketMatch = fullText.match(/^\[(.*?)\]\s*(.*)$/);
      if (visBracketMatch) {
        visual = visBracketMatch[1].trim();
        fullText = visBracketMatch[2].trim();
      }

      const cleanVis = sanitizeCleanScriptText(visual);
      const cleanVo = sanitizeCleanScriptText(fullText);

      if (cleanVo || cleanVis) {
        segments.push({
          time_range: timeRange,
          visual: cleanVis,
          text: cleanVo,
        });
      }
    }
  }

  return segments;
}

/**
 * Fungsi utama terpadu untuk mengekstrak tabel storyboard dari berbagai tipe file.
 * Mengonversi seluruh format ke struktur standar:
 * - `time_range`: "HH:MM:SS - HH:MM:SS"
 * - `visual`: Arahan Visual (Adegan Video)
 * - `text`: Naskah Voice Over (Audio)
 */
export async function parseStoryboardBuffer(
  fileName: string,
  buffer: Buffer
): Promise<StoryboardSegment[]> {
  const ext = (fileName.split(".").pop() || "").toLowerCase();

  // 1. PDF Document
  if (ext === "pdf") {
    return await parsePdfStoryboard(buffer);
  }

  // 2. Microsoft Word (.docx / .doc)
  if (["docx", "doc"].includes(ext)) {
    if (ext === "doc" && buffer.slice(0, 4).toString("hex") === "504b0304") {
      // Sebenarnya file docx dengan ekstensi .doc
      return await parseDocxStoryboard(buffer);
    }
    const docxResult = await parseDocxStoryboard(buffer);
    if (docxResult.length > 0) return docxResult;

    // Untuk file .doc biner lama, ekstrak string ASCII/UTF-8
    if (ext === "doc") {
      const raw = buffer.toString("latin1");
      const strings = raw.match(/[\x20-\x7E\r\n\t]{4,}/g);
      if (strings) {
        return parseRawTimelineText(strings.join("\n"), false);
      }
    }
    return [];
  }

  // 3. Spreadsheet (.xlsx, .xls, .csv, .tsv)
  if (["xlsx", "xls", "csv", "tsv"].includes(ext)) {
    return parseSpreadsheetStoryboard(buffer, ext);
  }

  // 4. Subtitle (.srt, .vtt)
  if (["srt", "vtt"].includes(ext)) {
    const text = buffer.toString("utf-8");
    const subSegs = parseSubtitleStoryboard(text);
    if (subSegs.length > 0) return subSegs;
    return parseRawTimelineText(text, false);
  }

  // 5. Teks Murni (.txt, .md, .json)
  if (["txt", "md", "json"].includes(ext)) {
    const text = buffer.toString("utf-8");

    if (ext === "json") {
      try {
        const data = JSON.parse(text);
        if (Array.isArray(data)) {
          const segs: StoryboardSegment[] = [];
          for (const item of data) {
            if (item && typeof item === "object") {
              const tr = item.time_range || item.durasi || item.waktu || "00:00:00 - 00:00:05";
              const vis = sanitizeCleanScriptText(String(item.visual || item.arahan_visual || item.adegan || ""));
              const vo = sanitizeCleanScriptText(String(item.text || item.naskah || item.audio || ""));
              if (vo || vis) {
                segs.push({
                  time_range: normalizeToHmsRange(String(tr)),
                  visual: vis,
                  text: vo,
                });
              }
            }
          }
          if (segs.length > 0) return segs;
        }
      } catch {
        // Fallback ke parser teks
      }
    }

    return parseRawTimelineText(text, true);
  }

  // File lain yang tidak dikenali:
  // JANGAN decode binary sebagai teks! Hanya parse jika teks utf-8 valid tanpa null bytes
  if (!buffer.includes(0)) {
    return parseRawTimelineText(buffer.toString("utf-8"), false);
  }

  return [];
}
