import { NextResponse } from "next/server";
import { generateTimelineVoiceover } from "@/lib/timeline-engine";
import {
  parseSrtToCues,
  generateAssContent,
  parseTimeRangeStr,
  splitTextIntoSubtitleCues,
} from "@/lib/timeline-utils";
import {
  saveHistoryItem,
  saveOutputFile,
  getOutputFilePath,
  getOutputDir,
  updateHistoryItem,
} from "@/lib/history-manager";
import { StoryboardSegment, FitMode, SubtitleStyle } from "@/types";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

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

function resolveVideoPath(videoPath?: string): string | null {
  if (!videoPath) return null;
  let resolvedVPath: string | null = null;
  if (videoPath.startsWith("/api/files/")) {
    const fname = videoPath.replace("/api/files/", "").split("?")[0];
    resolvedVPath = getOutputFilePath(fname) || path.join(getOutputDir(), fname);
  } else if (videoPath.startsWith("/reference_videos/")) {
    resolvedVPath = path.join(process.cwd(), "public", videoPath.slice(1).split("?")[0]);
  } else {
    const clean = videoPath.split("?")[0];
    const candidate = getOutputFilePath(clean) || path.join(getOutputDir(), clean);
    if (fs.existsSync(/*turbopackIgnore: true*/ candidate)) {
      resolvedVPath = candidate;
    }
  }

  if (resolvedVPath && fs.existsSync(/*turbopackIgnore: true*/ resolvedVPath)) {
    return resolvedVPath;
  }
  return null;
}

interface MuxDubbedOptions {
  ffmpegBin: string;
  savedAudioPath: string;
  savedAssPath: string;
  resolvedVPath: string | null;
  outDubPath: string;
  totalDurationSec: number;
  burnSubtitles?: boolean;
}

async function muxDubbedVideo(opts: MuxDubbedOptions): Promise<boolean> {
  const {
    ffmpegBin,
    savedAudioPath,
    savedAssPath,
    resolvedVPath,
    outDubPath,
    totalDurationSec,
    burnSubtitles,
  } = opts;

  const escapedAssPath = savedAssPath
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");

  const shouldBurn = burnSubtitles !== false && fs.existsSync(savedAssPath);
  const subFilter = shouldBurn ? `ass='${escapedAssPath}'` : "";

  let ffmpegArgs: string[] = [];

  if (resolvedVPath && fs.existsSync(resolvedVPath)) {
    const vf = subFilter
      ? `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,${subFilter}`
      : `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black`;

    ffmpegArgs = [
      "-y",
      "-threads", "2",
      "-stream_loop", "-1",
      "-i", resolvedVPath,
      "-i", savedAudioPath,
      "-vf", vf,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-t", String(totalDurationSec),
      outDubPath,
    ];
  } else {
    // Tanpa video acuan fisik, buat video 1280x720 elegan berlatar gelap dengan audio & subtitle utuh
    const vf = subFilter || "null";
    ffmpegArgs = [
      "-y",
      "-threads", "2",
      "-f", "lavfi",
      "-i", `color=c=0x0b0f19:s=1280x720:d=${totalDurationSec}:r=25`,
      "-i", savedAudioPath,
      "-vf", vf,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-t", String(totalDurationSec),
      outDubPath,
    ];
  }

  const runFfmpeg = (args: string[]) =>
    new Promise<boolean>((resolve) => {
      const proc = spawn(/*turbopackIgnore: true*/ ffmpegBin, args);
      let stderr = "";
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        console.error("FFmpeg render timed out after 180s");
        resolve(false);
      }, 180000);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0 && fs.existsSync(outDubPath) && fs.statSync(outDubPath).size > 0) {
          resolve(true);
        } else {
          console.error("FFmpeg error exit code:", code, stderr.slice(-400));
          resolve(false);
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        console.error("FFmpeg process spawn error:", err);
        resolve(false);
      });
    });

  let ok = await runFfmpeg(ffmpegArgs);
  // Fallback tanpa filter ASS jika sistem mengalami kendala font libass
  if (!ok && subFilter) {
    console.warn("[muxDubbedVideo] Gagal dengan filter ASS, mencoba remux dasar...");
    const fallbackArgs = ffmpegArgs.filter((a, idx) => a !== "-vf" && ffmpegArgs[idx - 1] !== "-vf");
    ok = await runFfmpeg(fallbackArgs);
  }

  return ok;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Jalur A: Remux Subtitle Instan (0 Kuota Token ElevenLabs, ~3-5 detik)
    if (body.action === "remux") {
      const {
        audioUrl,
        srtUrl,
        videoPath,
        subtitleFontSize,
        subtitleYpad,
        subtitleStyle,
        segments,
        burnSubtitles,
      } = body;

      if (!audioUrl) {
        return NextResponse.json(
          { success: false, error: "Audio URL wajib disertakan untuk remux" },
          { status: 400 }
        );
      }

      const audioFileName = (audioUrl as string).replace("/api/files/", "").split("?")[0];
      const savedAudioPath =
        getOutputFilePath(audioFileName) || path.join(process.cwd(), "outputs", audioFileName);

      if (!fs.existsSync(/*turbopackIgnore: true*/ savedAudioPath)) {
        return NextResponse.json(
          { success: false, error: "File audio master tidak ditemukan di server" },
          { status: 404 }
        );
      }

      const baseName = audioFileName.replace(/\.wav$/i, "");
      let cues: Array<{ start: number; end: number; text: string }> = [];

      if (srtUrl) {
        const srtFileName = (srtUrl as string).replace("/api/files/", "").split("?")[0];
        const srtPath =
          getOutputFilePath(srtFileName) || path.join(process.cwd(), "outputs", srtFileName);
        if (fs.existsSync(/*turbopackIgnore: true*/ srtPath)) {
          const srtContent = fs.readFileSync(/*turbopackIgnore: true*/ srtPath, "utf-8");
          cues = parseSrtToCues(srtContent);
        }
      }

      if (cues.length === 0 && Array.isArray(segments) && segments.length > 0) {
        for (const seg of segments) {
          const [s, e] = parseTimeRangeStr(seg.time_range);
          const subCues = splitTextIntoSubtitleCues(seg.text, s, e);
          cues.push(...subCues);
        }
      }

      if (cues.length === 0) {
        return NextResponse.json(
          { success: false, error: "Data cue subtitle tidak ditemukan untuk di-remux" },
          { status: 400 }
        );
      }

      const assContent = generateAssContent(cues, {
        fontSize: subtitleFontSize || 34,
        ypad: subtitleYpad !== undefined ? subtitleYpad : 40,
        style: subtitleStyle || "outline",
      });

      const assFileName = `${baseName}.ass`;
      const savedAssPath = saveOutputFile(assFileName, assContent);

      const ffmpegBin = getFfmpegBinary();
      const resolvedVPath = resolveVideoPath(videoPath);
      const dubbedFileName = `${baseName}_dubbed.mp4`;
      const outDubPath = path.join(getOutputDir(), dubbedFileName);

      let dubbedVideoUrl: string | undefined;

      const audioStat = fs.statSync(/*turbopackIgnore: true*/ savedAudioPath);
      const totalDurationSec = Math.max(
        1,
        Number(((audioStat.size - 44) / (24000 * 2)).toFixed(2))
      );

      const ok = await muxDubbedVideo({
        ffmpegBin,
        savedAudioPath,
        savedAssPath,
        resolvedVPath,
        outDubPath,
        totalDurationSec,
        burnSubtitles,
      });

      if (ok) {
        dubbedVideoUrl = `/api/files/${dubbedFileName}`;
        updateHistoryItem(baseName, { video_url: dubbedVideoUrl });
      }

      return NextResponse.json({
        success: true,
        dubbedVideoUrl,
        srtUrl: `/api/files/${baseName}.srt`,
        assUrl: `/api/files/${assFileName}`,
        message: "Subtitle berhasil diperbarui tanpa mengonsumsi kuota ElevenLabs!",
      });
    }

    // Jalur B: Generate Baru Penuh (TTS ElevenLabs + Muxing Video & Subtitle)
    const {
      segments,
      voiceId,
      voiceName,
      featureName,
      modelId,
      languageCode,
      stability,
      similarityBoost,
      style,
      speed,
      useSpeakerBoost,
      fitMode,
      stretchShorter,
      burnSubtitles,
      subtitleStyle,
      subtitleFontSize,
      subtitleYpad,
      videoPath,
      apiKey,
    }: {
      segments: StoryboardSegment[];
      voiceId?: string;
      voiceName?: string;
      featureName?: string;
      modelId?: string;
      languageCode?: string;
      stability?: number;
      similarityBoost?: number;
      style?: number;
      speed?: number;
      useSpeakerBoost?: boolean;
      fitMode?: FitMode;
      stretchShorter?: boolean;
      burnSubtitles?: boolean;
      subtitleStyle?: SubtitleStyle;
      subtitleFontSize?: number;
      subtitleYpad?: number;
      videoPath?: string;
      apiKey?: string;
    } = body;

    if (!segments || !segments.length) {
      return NextResponse.json(
        { success: false, error: "Daftar segmen storyboard tidak boleh kosong" },
        { status: 400 }
      );
    }

    // 1. Generate master timeline audio, SRT, dan ASS (PlayRes 1280x720 1:1 pixel perfect)
    const tlResult = await generateTimelineVoiceover({
      segments,
      voiceId,
      voiceName,
      modelId,
      languageCode,
      stability,
      similarityBoost,
      style,
      speed,
      useSpeakerBoost,
      fitMode,
      stretchShorter,
      apiKey,
      subtitleFontSize: subtitleFontSize || 34,
      subtitleYpad: subtitleYpad !== undefined ? subtitleYpad : 40,
      subtitleStyle: subtitleStyle || "outline",
    });

    const timestampStr = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
    const cleanVoiceName = (voiceName || "Zen").replace(/[^\w-]/g, "_");
    const cleanFeatureName = (featureName || "Payment_Method").replace(/[^\w-]/g, "_");

    const baseName = `timeline_${timestampStr}_${cleanVoiceName}`;
    const audioFileName = `${baseName}.wav`;
    const srtFileName = `${baseName}.srt`;
    const assFileName = `${baseName}.ass`;

    const savedAudioPath = saveOutputFile(audioFileName, tlResult.wavBuffer);
    const savedSrtPath = saveOutputFile(srtFileName, tlResult.srtContent);
    const savedAssPath = saveOutputFile(assFileName, tlResult.assContent);

    const audioUrl = `/api/files/${audioFileName}`;
    const srtUrl = `/api/files/${srtFileName}`;
    const ffmpegBin = getFfmpegBinary();

    // 2. Buat versi audio MP3 fleksibel (192kbps) di samping file WAV master
    const mp3FileName = `${baseName}.mp3`;
    const outMp3Path = path.join(getOutputDir(), mp3FileName);
    let mp3Url: string | undefined;

    try {
      const mp3Ok = await new Promise<boolean>((resolve) => {
        const proc = spawn(/*turbopackIgnore: true*/ ffmpegBin, [
          "-y",
          "-threads", "2",
          "-i", savedAudioPath,
          "-c:a", "libmp3lame",
          "-b:a", "192k",
          outMp3Path,
        ]);
        proc.on("close", (code) => {
          resolve(code === 0 && fs.existsSync(outMp3Path) && fs.statSync(outMp3Path).size > 0);
        });
        proc.on("error", (e) => {
          console.warn("[timeline] FFmpeg mp3 conversion error:", e);
          resolve(false);
        });
      });

      if (mp3Ok) {
        mp3Url = `/api/files/${mp3FileName}`;
      }
    } catch (err) {
      console.warn("[timeline] MP3 generation failed:", err);
    }

    let dubbedVideoUrl: string | undefined;

    // 3. Gabungkan (mux/dubbing) video acuan jika ada file fisik di server, atau buat video presentasi lengkap
    const resolvedVPath = resolveVideoPath(videoPath);
    const dubbedFileName = `${baseName}_dubbed.mp4`;
    const outDubPath = path.join(getOutputDir(), dubbedFileName);

    const dubbedOk = await muxDubbedVideo({
      ffmpegBin,
      savedAudioPath,
      savedAssPath,
      resolvedVPath,
      outDubPath,
      totalDurationSec: tlResult.totalTimelineSec,
      burnSubtitles,
    });

    if (dubbedOk) {
      dubbedVideoUrl = `/api/files/${dubbedFileName}`;
    }

    const fullScriptSummary = tlResult.segmentReports
      .map((r) => `[${r.time_range}] ${r.text}`)
      .join(" | ");

    saveHistoryItem({
      id: baseName,
      timestamp: new Date().toLocaleString("id-ID"),
      mode: "timeline_tts",
      voice_id: voiceId || "3OAL9h0y2edOwGJbMU4X",
      voice_name: voiceName || "Zen",
      feature_name: cleanFeatureName,
      model_id: modelId || "eleven_v4",
      text: fullScriptSummary,
      settings: {
        stability: stability ?? 0.55,
        similarity_boost: similarityBoost ?? 0.8,
        style: style ?? 0,
        speed: speed ?? 1,
        use_speaker_boost: useSpeakerBoost !== false,
      },
      output_format: "pcm_24000 (WAV Timeline) + MP3 192k",
      audio_url: audioUrl,
      mp3_url: mp3Url,
      srt_url: srtUrl,
      video_url: dubbedVideoUrl,
      size_bytes: tlResult.wavBuffer.length,
      elapsed_sec: tlResult.elapsedSec,
    });

    return NextResponse.json({
      success: true,
      audioUrl,
      mp3Url,
      srtUrl,
      dubbedVideoUrl,
      totalTimelineSec: tlResult.totalTimelineSec,
      elapsedSec: tlResult.elapsedSec,
      segmentReports: tlResult.segmentReports,
      sizeBytes: tlResult.wavBuffer.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Gagal generate timeline";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
