import { StoryboardSegment, FitMode, SubtitleStyle } from "@/types";
import { formatSrtTimestamp, generateSpeechRaw } from "./elevenlabs";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import {
  parseTimecodeToSeconds,
  formatSecondsToHms,
  parseTimeRangeStr,
  normalizeToHmsRange,
  resequenceTimelineTimestamps,
  getTimecodeDropdownOptions,
  splitTextIntoSubtitleCues,
  formatAssTimestamp,
  generateAssContent,
} from "./timeline-utils";

export {
  parseTimecodeToSeconds,
  formatSecondsToHms,
  parseTimeRangeStr,
  normalizeToHmsRange,
  resequenceTimelineTimestamps,
  getTimecodeDropdownOptions,
  splitTextIntoSubtitleCues,
  formatAssTimestamp,
  generateAssContent,
};

export const SAMPLE_RATE = 24000; // 24kHz 16-bit mono native ElevenLabs PCM

function getFfmpegBinary(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const staticFfmpeg = require("ffmpeg-static");
    if (typeof staticFfmpeg === "string" && fs.existsSync(staticFfmpeg)) {
      return staticFfmpeg;
    }
  } catch {
    // fallback
  }

  const localBin = path.join(process.cwd(), "node_modules", ".bin", "ffmpeg");
  if (fs.existsSync(localBin)) {
    return localBin;
  }

  return "ffmpeg";
}

/**
 * Menyesuaikan tempo audio PCM 16-bit mono menggunakan filter atempo FFmpeg
 * tanpa mengubah nada (pitch-invariant time-stretching).
 */
export function adjustPcmTempo(
  pcmBuffer: Buffer,
  sampleRate: number = SAMPLE_RATE,
  tempo: number = 1.0
): Buffer {
  if (Math.abs(tempo - 1.0) < 0.03 || tempo <= 0.4 || tempo >= 2.5) {
    return pcmBuffer;
  }
  const ffmpegBin = getFfmpegBinary();
  try {
    const res = spawnSync(
      /*turbopackIgnore: true*/ ffmpegBin,
      [
        "-y",
        "-f", "s16le",
        "-ar", String(sampleRate),
        "-ac", "1",
        "-i", "pipe:0",
        "-filter:a", `atempo=${tempo.toFixed(2)}`,
        "-f", "s16le",
        "-ar", String(sampleRate),
        "-ac", "1",
        "pipe:1",
      ],
      { input: pcmBuffer, maxBuffer: 60 * 1024 * 1024 }
    );

    if (res.status === 0 && res.stdout && res.stdout.length > 0) {
      return res.stdout;
    }
  } catch (err) {
    console.warn("[adjustPcmTempo] Gagal memproses atempo:", err);
  }
  return pcmBuffer;
}

/**
 * Membungkus PCM 16-bit mono little-endian Buffer dengan 44-byte WAV header
 */
export function pcm16ToWavBuffer(
  pcmBuffer: Buffer,
  sampleRate: number = SAMPLE_RATE,
  numChannels: number = 1
): Buffer {
  const byteRate = sampleRate * numChannels * 2;
  const blockAlign = numChannels * 2;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  // RIFF header
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);

  // fmt subchunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // SubChunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // BitsPerSample

  // data subchunk
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

export interface TimelineGenerationOptions {
  segments: StoryboardSegment[];
  voiceId?: string;
  voiceName?: string;
  modelId?: string;
  languageCode?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speed?: number;
  useSpeakerBoost?: boolean;
  fitMode?: FitMode;
  stretchShorter?: boolean;
  apiKey?: string;
  subtitleFontSize?: number;
  subtitleYpad?: number;
  subtitleStyle?: SubtitleStyle;
}

export interface SegmentReport {
  index: number;
  time_range: string;
  target_slot_sec: number;
  speech_dur_sec: number;
  status: string;
  speed_factor: number;
  text: string;
}

export interface TimelineResult {
  totalTimelineSec: number;
  elapsedSec: number;
  wavBuffer: Buffer;
  srtContent: string;
  assContent: string;
  segmentReports: SegmentReport[];
  featureName?: string;
}

/**
 * Menghasilkan Master Audio Timeline Storyboard tersinkronisasi presisi tinggi
 * dengan pemosisian non-destruktif (mencegah penimpaan audio antar adegan),
 * penyesuaian tempo cerdas (auto-fit tanpa ubah pitch), dan sinkronisasi subtitle 1:1.
 */
export async function generateTimelineVoiceover(
  options: TimelineGenerationOptions
): Promise<TimelineResult> {
  const startTime = Date.now();
  const segments = options.segments.filter((s) => (s.text || "").trim().length > 0);
  if (!segments.length) {
    throw new Error("Tidak ada segmen naskah yang memiliki teks untuk diproses.");
  }

  // Hitung perkiraan total durasi awal
  let maxEndSec = 0;
  for (const seg of segments) {
    const [, e] = parseTimeRangeStr(seg.time_range);
    if (e > maxEndSec) maxEndSec = e;
  }
  const initialDurationSec = Math.ceil(maxEndSec + 1.0);

  const segmentReports: SegmentReport[] = [];
  const srtCues: Array<{ start: number; end: number; text: string }> = [];
  const audioChunks: Array<{ startByte: number; buffer: Buffer }> = [];
  let maxNeededBytes = 0;
  let prevFinishSec = 0.0;

  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx];
    const [origStartSec, origEndSec] = parseTimeRangeStr(seg.time_range);
    const targetSlot = Math.max(1.0, origEndSec - origStartSec);
    const text = seg.text
      .replace(/&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&nbsp;/gi, " ")
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .trim();

    // Pastikan tidak ada suara yang terpotong/timpa antar segmen (non-destructive audio positioning)
    let actualStartSec = origStartSec;
    if (idx > 0 && actualStartSec < prevFinishSec) {
      actualStartSec = Number((prevFinishSec + 0.25).toFixed(2));
    }

    const prevText = idx > 0 ? segments[idx - 1].text.replace(/&apos;/gi, "'").replace(/&quot;/gi, '"').trim() : undefined;
    const nextText = idx + 1 < segments.length ? segments[idx + 1].text.replace(/&apos;/gi, "'").replace(/&quot;/gi, '"').trim() : undefined;

    // Request PCM 24kHz audio langsung dari ElevenLabs API
    const res = await generateSpeechRaw({
      text,
      voiceId: options.voiceId,
      modelId: options.modelId || "eleven_v4",
      outputFormat: "pcm_24000",
      stability: options.stability ?? 0.55,
      similarityBoost: options.similarityBoost ?? 0.8,
      style: options.style ?? 0.0,
      speed: options.speed ?? 1.0,
      useSpeakerBoost: options.useSpeakerBoost !== false,
      languageCode: options.languageCode,
      previousText: prevText,
      nextText: nextText,
      apiKey: options.apiKey,
    });

    let effectivePcm = res.audioBuffer;
    let speechDur = (effectivePcm.length / 2) / SAMPLE_RATE;
    let speedFactor = 1.0;
    let status = "Pas di slot";

    if (options.fitMode === "strict_trim") {
      if (speechDur > targetSlot) {
        const bytesToWrite = Math.floor(targetSlot * SAMPLE_RATE) * 2;
        effectivePcm = effectivePcm.subarray(0, bytesToWrite);
        speechDur = targetSlot;
        status = "Dipotong pas di batas waktu";
      }
    } else if (options.fitMode === "auto_fit") {
      if (speechDur > targetSlot * 1.05) {
        const desiredTempo = speechDur / targetSlot;
        // Batasi tempo maksimal 1.35x agar suara tetap sangat jelas dan alami
        const tempo = Math.min(1.35, Math.max(1.05, desiredTempo));
        effectivePcm = adjustPcmTempo(effectivePcm, SAMPLE_RATE, tempo);
        speechDur = (effectivePcm.length / 2) / SAMPLE_RATE;
        speedFactor = Number(tempo.toFixed(2));
        status = `Auto-Fit (${speedFactor}x tempo)`;
      } else if (options.stretchShorter && speechDur < targetSlot * 0.65) {
        const tempo = Math.max(0.85, speechDur / (targetSlot * 0.85));
        effectivePcm = adjustPcmTempo(effectivePcm, SAMPLE_RATE, tempo);
        speechDur = (effectivePcm.length / 2) / SAMPLE_RATE;
        speedFactor = Number(tempo.toFixed(2));
        status = `Diperlambat santai (${speedFactor}x tempo)`;
      } else {
        status = "Pas di slot";
      }
    } else {
      // natural_pad (Kecepatan Alami)
      if (speechDur > targetSlot + 0.4) {
        status = "Kecepatan Alami (Slot diperpanjang)";
      } else {
        status = "Pas di slot";
      }
    }

    const actualEndSec = Number((actualStartSec + speechDur).toFixed(2));
    prevFinishSec = actualEndSec;

    const startByte = Math.floor(actualStartSec * SAMPLE_RATE) * 2;
    const endByte = startByte + effectivePcm.length;
    if (endByte > maxNeededBytes) {
      maxNeededBytes = endByte;
    }
    audioChunks.push({ startByte, buffer: effectivePcm });

    segmentReports.push({
      index: idx + 1,
      time_range: `${formatSecondsToHms(actualStartSec, true)} - ${formatSecondsToHms(actualEndSec, true)}`,
      target_slot_sec: Number(targetSlot.toFixed(1)),
      speech_dur_sec: Number(speechDur.toFixed(1)),
      status,
      speed_factor: speedFactor,
      text,
    });

    // Subtitle cues selaras persis dengan rentang bicara aktual
    const cues = splitTextIntoSubtitleCues(text, actualStartSec, actualEndSec);
    srtCues.push(...cues);
  }

  // Alokasi master buffer sesuai durasi total aktual yang dibutuhkan (termasuk buffer jeda)
  const finalTotalSec = Math.max(initialDurationSec, maxNeededBytes / (SAMPLE_RATE * 2) + 0.5);
  const finalTotalBytes = Math.ceil(finalTotalSec * SAMPLE_RATE) * 2;
  const masterBuffer = Buffer.alloc(finalTotalBytes, 0);

  for (const chunk of audioChunks) {
    if (chunk.startByte < masterBuffer.length) {
      const copyLen = Math.min(chunk.buffer.length, masterBuffer.length - chunk.startByte);
      chunk.buffer.copy(masterBuffer, chunk.startByte, 0, copyLen);
    }
  }

  // Buat string SRT lengkap
  const srtContent = srtCues
    .map((c, i) => `${i + 1}\n${formatSrtTimestamp(c.start)} --> ${formatSrtTimestamp(c.end)}\n${c.text}\n`)
    .join("\n");

  // Buat string ASS 1280x720 lengkap
  const assContent = generateAssContent(srtCues, {
    fontSize: options.subtitleFontSize,
    ypad: options.subtitleYpad,
    style: options.subtitleStyle,
  });

  // Bungkus master PCM menjadi file WAV utuh
  const wavBuffer = pcm16ToWavBuffer(masterBuffer, SAMPLE_RATE, 1);
  const elapsedSec = Number(((Date.now() - startTime) / 1000).toFixed(2));

  return {
    totalTimelineSec: Number(finalTotalSec.toFixed(1)),
    elapsedSec,
    wavBuffer,
    srtContent,
    assContent,
    segmentReports,
  };
}

