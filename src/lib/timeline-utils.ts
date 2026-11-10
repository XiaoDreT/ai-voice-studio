import { StoryboardSegment, SubtitleStyle } from "@/types";

/**
 * Mengonversi timecode ("HH:MM:SS" atau "MM:SS") menjadi detik (float)
 */
export function parseTimecodeToSeconds(timecode: string): number {
  if (!timecode) return 0.0;
  const clean = timecode.trim().replace(/,/g, ".");
  const parts = clean.split(":");

  if (parts.length === 3) {
    const h = parseInt(parts[0], 10) || 0;
    const m = parseInt(parts[1], 10) || 0;
    const s = parseFloat(parts[2]) || 0.0;
    return Math.max(0.0, h * 3600 + m * 60 + s);
  }
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10) || 0;
    const s = parseFloat(parts[1]) || 0.0;
    return Math.max(0.0, m * 60 + s);
  }
  if (parts.length === 1) {
    return Math.max(0.0, parseFloat(parts[0]) || 0.0);
  }
  return 0.0;
}

/**
 * Mengonversi detik (float) ke format string "HH:MM:SS" (atau "MM:SS")
 */
export function formatSecondsToHms(seconds: number, includeHours: boolean = true): string {
  if (seconds < 0) seconds = 0.0;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  const pad = (n: number) => String(n).padStart(2, "0");
  if (includeHours || h > 0) {
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  return `${pad(m)}:${pad(s)}`;
}

/**
 * Mengekstrak waktu mulai dan selesai dari string rentang waktu ("00:00:00 - 00:00:05")
 */
export function parseTimeRangeStr(rangeStr: string): [number, number] {
  if (!rangeStr) return [0.0, 5.0];
  const cleaned = rangeStr.replace(/-->|s\/d|sd|sampai|to|hingga/gi, "-");
  const parts = cleaned.split("-");
  if (parts.length >= 2) {
    const s = parseTimecodeToSeconds(parts[0].trim());
    const e = parseTimecodeToSeconds(parts[1].trim());
    return [s, Math.max(s + 1.0, e)];
  }
  const s = parseTimecodeToSeconds(cleaned);
  return [s, s + 5.0];
}

/**
 * Menstandarkan rentang waktu ke format wajib "HH:MM:SS - HH:MM:SS"
 */
export function normalizeToHmsRange(rangeStr: string): string {
  const [s, e] = parseTimeRangeStr(rangeStr);
  return `${formatSecondsToHms(s, true)} - ${formatSecondsToHms(e, true)}`;
}

/**
 * Menata ulang rentang waktu segmen agar tersambung berurutan mulai dari 00:00:00
 * dengan estimasi durasi wicara yang realistis berdasarkan jumlah kata.
 */
export function resequenceTimelineTimestamps(segments: StoryboardSegment[]): StoryboardSegment[] {
  let curr = 0.0;
  return segments.map((seg) => {
    const [s, e] = parseTimeRangeStr(seg.time_range);
    const existingSlot = Math.max(1.0, e - s);
    const words = (seg.text || "").trim().split(/\s+/).filter(Boolean).length;
    // Estimasi wicara natural bahasa Indonesia (~2.3 kata/detik)
    const estimatedSpeechSec = words > 0 ? Math.ceil(words / 2.3) : 2.0;
    const dur = Math.max(existingSlot, estimatedSpeechSec);
    const newStart = curr;
    const newEnd = curr + dur;
    curr = newEnd + 1.0;
    return {
      ...seg,
      time_range: `${formatSecondsToHms(newStart, true)} - ${formatSecondsToHms(newEnd, true)}`,
    };
  });
}

/**
 * Menghasilkan daftar opsi dropdown timecode HH:MM:SS
 */
export function getTimecodeDropdownOptions(
  maxSeconds: number = 3600,
  extraTimecodes: string[] = []
): string[] {
  const set = new Set<string>();
  const limit = Math.max(300, maxSeconds + 60);

  // Interval 1 detik sampai 60s, lalu interval 5 detik
  for (let sec = 0; sec <= limit; sec += sec < 60 ? 1 : 5) {
    set.add(formatSecondsToHms(sec, true));
  }

  for (const tc of extraTimecodes) {
    if (tc) {
      const s = parseTimecodeToSeconds(tc);
      set.add(formatSecondsToHms(s, true));
    }
  }

  return Array.from(set).sort((a, b) => parseTimecodeToSeconds(a) - parseTimecodeToSeconds(b));
}

/**
 * Memecah teks naskah menjadi cues subtitle yang tersinkronisasi.
 * Memastikan satu kalimat storyboard tetap utuh dan selaras dengan tampilan Live Preview.
 */
export function splitTextIntoSubtitleCues(
  text: string,
  startSec: number,
  endSec: number,
  maxWordsPerCue: number = 22
): Array<{ start: number; end: number; text: string }> {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];

  const slotDur = Math.max(1.0, endSec - startSec);
  const totalWords = clean.split(" ").filter(Boolean).length;

  if (totalWords <= maxWordsPerCue && slotDur <= 7.0) {
    return [
      {
        start: Number(startSec.toFixed(2)),
        end: Number(endSec.toFixed(2)),
        text: clean,
      },
    ];
  }

  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunks: string[] = [];

  for (const s of sentences) {
    const words = s.split(" ").filter(Boolean);
    if (words.length <= maxWordsPerCue) {
      chunks.push(s);
    } else {
      for (let i = 0; i < words.length; i += maxWordsPerCue) {
        chunks.push(words.slice(i, i + maxWordsPerCue).join(" "));
      }
    }
  }

  const finalChunks = chunks.length > 0 ? chunks : [clean];
  const cueDur = slotDur / finalChunks.length;

  return finalChunks.map((chunk, i) => {
    const cStart = startSec + i * cueDur;
    const cEnd = Math.min(endSec, cStart + cueDur);
    return {
      start: Number(cStart.toFixed(2)),
      end: Number(cEnd.toFixed(2)),
      text: chunk,
    };
  });
}

/**
 * Mengonversi detik (float) ke format timestamp SSA/ASS "H:MM:SS.cc"
 */
export function formatAssTimestamp(seconds: number): string {
  if (seconds < 0) seconds = 0.0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor(Math.round((seconds % 1) * 100));
  const pad = (n: number, w: number = 2) => String(n).padStart(w, "0");
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs < 100 ? cs : 99)}`;
}

/**
 * Mengurai string konten SRT menjadi daftar cue objek { start, end, text }
 */
export function parseSrtToCues(srtContent: string): Array<{ start: number; end: number; text: string }> {
  const blocks = srtContent.trim().split(/\r?\n\r?\n/);
  const cues: Array<{ start: number; end: number; text: string }> = [];
  for (const block of blocks) {
    const lines = block.trim().split(/\r?\n/);
    if (lines.length >= 3) {
      const timeMatch = lines[1].match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
      if (timeMatch) {
        const parseSec = (t: string) => {
          const [h, m, rest] = t.split(":");
          const [s, ms] = rest.split(/[,.]/);
          return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10) + parseInt(ms, 10) / 1000;
        };
        const start = parseSec(timeMatch[1]);
        const end = parseSec(timeMatch[2]);
        const text = lines.slice(2).join(" ").trim();
        cues.push({ start, end, text });
      }
    }
  }
  return cues;
}

/**
 * Menghasilkan file Advanced SubStation Alpha (.ass) dengan PlayResX=1280 & PlayResY=720
 * sehingga ukuran font, outline, dan jarak aman margin bawah (MarginV) 100% presisi piksel demi piksel
 * sesuai dengan tampilan yang disetel oleh user pada pratinjau.
 */
export function generateAssContent(
  cues: Array<{ start: number; end: number; text: string }>,
  options: {
    fontSize?: number;
    ypad?: number;
    style?: SubtitleStyle;
  } = {}
): string {
  const fontSize = options.fontSize || 34;
  const marginV = options.ypad !== undefined ? options.ypad : 40;
  const style = options.style || "outline";

  let styleLine = "";
  if (style === "shaded_box") {
    styleLine = `Style: Default,Inter,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H900B132B,-1,0,0,0,100,100,0,0,3,4,0,2,60,60,${marginV},1`;
  } else if (style === "yellow_outline") {
    styleLine = `Style: Default,Inter,${fontSize},&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,1.5,0,2,60,60,${marginV},1`;
  } else {
    styleLine = `Style: Default,Inter,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,1.5,0,2,60,60,${marginV},1`;
  }

  const events = cues
    .map((c) => {
      const cleanText = c.text.replace(/\r?\n/g, "\\N");
      return `Dialogue: 0,${formatAssTimestamp(c.start)},${formatAssTimestamp(c.end)},Default,,0,0,0,,${cleanText}`;
    })
    .join("\n");

  return `[Script Info]
Title: ElevenLabs Timeline Subtitles
ScriptType: v4.00+
WrapStyle: 1
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLine}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;
}

