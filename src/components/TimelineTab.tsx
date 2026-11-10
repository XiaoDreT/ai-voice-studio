"use client";

import React, { useState, useRef, useEffect } from "react";
import { StoryboardSegment, FitMode, SubtitleStyle, VoiceSetting } from "@/types";
import {
  CETAKIA_DEFAULT_SEGMENTS,
  PAYMENT_METHOD_SEGMENTS,
  PAYMENT_METHOD_VIDEO_SYNCED_SEGMENTS,
} from "@/lib/constants";
import {
  formatSecondsToHms,
  parseTimeRangeStr,
  normalizeToHmsRange,
  resequenceTimelineTimestamps,
  parseTimecodeToSeconds,
} from "@/lib/timeline-utils";
import {
  Clock,
  Play,
  RotateCcw,
  Sparkles,
  Upload,
  Video,
  FileText,
  Trash2,
  ArrowUp,
  ArrowDown,
  Plus,
  Download,
  CheckCircle2,
  AlertCircle,
  Eye,
  Film,
  Type,
  MoveVertical,
  Loader2,
  RefreshCw,
} from "lucide-react";

interface TimelineTabProps {
  selectedVoiceId: string;
  selectedVoiceName: string;
  selectedModelId: string;
  selectedLangCode: string;
  voiceSettings: VoiceSetting;
}

export const TimelineTab: React.FC<TimelineTabProps> = ({
  selectedVoiceId,
  selectedVoiceName,
  selectedModelId,
  selectedLangCode,
  voiceSettings,
}) => {
  const [segments, setSegments] = useState<StoryboardSegment[]>(CETAKIA_DEFAULT_SEGMENTS);
  const [featureName, setFeatureName] = useState<string>("Payment_Method");
  const [activeVideoUrl, setActiveVideoUrl] = useState<string | null>(null);
  const [activeVideoName, setActiveVideoName] = useState<string | null>(null);
  const [videoSeekTime, setVideoSeekTime] = useState<number>(0);

  // Settings
  const [fitMode, setFitMode] = useState<FitMode>("natural_pad");
  const [stretchShorter, setStretchShorter] = useState<boolean>(false);
  const [burnSubtitles, setBurnSubtitles] = useState<boolean>(true);
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>("outline");
  const [subtitleFontSize, setSubtitleFontSize] = useState<number>(34);
  const [subtitleYpad, setSubtitleYpad] = useState<number>(40);
  const [currentVideoTime, setCurrentVideoTime] = useState<number>(0);
  const [showLiveSubtitleOnPlayer, setShowLiveSubtitleOnPlayer] = useState<boolean>(true);
  const [isRemuxing, setIsRemuxing] = useState<boolean>(false);
  const [remuxSuccessMsg, setRemuxSuccessMsg] = useState<string | null>(null);

  // Player container ref & scale calculation untuk WYSIWYG presisi 1:1 terhadap kanvas 1280x720
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const [playerWidth, setPlayerWidth] = useState<number>(640);

  useEffect(() => {
    if (!playerContainerRef.current) return;
    const updateSize = () => {
      if (playerContainerRef.current) {
        const w = playerContainerRef.current.clientWidth;
        if (w > 0) setPlayerWidth(w);
      }
    };
    updateSize();
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          setPlayerWidth(entry.contentRect.width);
        }
      }
    });
    ro.observe(playerContainerRef.current);
    return () => ro.disconnect();
  }, []);

  const previewScale = Math.max(0.2, playerWidth / 1280);

  // Cari segmen yang aktif pada detik pemutaran video saat ini
  const activeSegmentAtTime = React.useMemo(() => {
    for (const s of segments) {
      const [start, end] = parseTimeRangeStr(s.time_range);
      if (currentVideoTime >= start && currentVideoTime <= end) {
        return s;
      }
    }
    return null;
  }, [segments, currentVideoTime]);

  // Teks subtitle yang selalu aktif (aktif saat playback atau baris segmen pertama saat jeda)
  const effectiveSegment = activeSegmentAtTime || segments.find((s) => s.text.trim()) || segments[0];
  const effectiveSubtitleText = effectiveSegment?.text || "";

  // Generation state
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [progressMsg, setProgressMsg] = useState<string>("");
  const [timelineResult, setTimelineResult] = useState<{
    audioUrl: string;
    srtUrl?: string;
    dubbedVideoUrl?: string;
    totalTimelineSec: number;
    elapsedSec: number;
    segmentReports: Array<{
      index: number;
      time_range: string;
      target_slot_sec: number;
      speech_dur_sec: number;
      status: string;
      text: string;
    }>;
  } | null>(null);

  // File upload state
  const [isUploadingDoc, setIsUploadingDoc] = useState<boolean>(false);
  const [uploadDocMsg, setUploadDocMsg] = useState<string | null>(null);
  const [isUploadingVideo, setIsUploadingVideo] = useState<boolean>(false);

  // Video player ref
  const videoRef = useRef<HTMLVideoElement>(null);
  const dubbedAudioRef = useRef<HTMLAudioElement>(null);
  const [serverVideoPath, setServerVideoPath] = useState<string | null>(null);
  const [activePlayerMode, setActivePlayerMode] = useState<"original" | "dubbed">("original");

  // Muat hasil generate timeline terakhir dari history saat pertama kali dibuka (jika ada)
  useEffect(() => {
    const fetchLatestTimeline = async () => {
      try {
        const res = await fetch("/api/history");
        const data = await res.json();
        if (Array.isArray(data)) {
          const latest = data.find(
            (item: { mode?: string; audio_url?: string; video_url?: string; elapsed_sec?: number }) =>
              item.mode === "timeline_tts" && item.audio_url
          );
          if (latest) {
            setTimelineResult({
              audioUrl: latest.audio_url,
              srtUrl: latest.srt_url,
              dubbedVideoUrl: latest.video_url,
              totalTimelineSec: 102,
              elapsedSec: latest.elapsed_sec || 13,
              segmentReports: [],
            });
            if (latest.video_url) {
              setActivePlayerMode("dubbed");
            }
          }
        }
      } catch {
        // Abaikan jika offline / fetch gagal
      }
    };
    fetchLatestTimeline();
  }, []);

  // Perbarui Subtitle Langsung ke Video Tanpa Generate Ulang Suara (0 Kuota Token ElevenLabs)
  const handleRemuxSubtitles = async () => {
    if (!timelineResult?.audioUrl) return;
    setIsRemuxing(true);
    setRemuxSuccessMsg(null);
    try {
      const res = await fetch("/api/timeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "remux",
          audioUrl: timelineResult.audioUrl,
          srtUrl: timelineResult.srtUrl,
          videoPath: activeVideoUrl,
          subtitleFontSize,
          subtitleYpad,
          subtitleStyle,
          segments,
          burnSubtitles,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Gagal memperbarui subtitle video");
      }

      const freshUrl = `${data.dubbedVideoUrl}?t=${Date.now()}`;
      setTimelineResult((prev) => (prev ? { ...prev, dubbedVideoUrl: freshUrl } : null));
      setRemuxSuccessMsg("Subtitle berhasil diperbarui & disinkronkan ke video tanpa kuota ElevenLabs!");
      setActivePlayerMode("dubbed");
      if (videoRef.current) {
        videoRef.current.load();
      }
      setTimeout(() => setRemuxSuccessMsg(null), 5000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Terjadi kesalahan saat memperbarui subtitle";
      alert(msg);
    } finally {
      setIsRemuxing(false);
    }
  };

  // Handle Seek Video
  const handleSeekVideo = (seconds: number) => {
    setVideoSeekTime(seconds);
    if (videoRef.current) {
      videoRef.current.currentTime = seconds;
      videoRef.current.play().catch(() => {});
    }
  };

  // Upload Document
  const handleUploadDocument = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploadingDoc(true);
    setUploadDocMsg(null);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/upload-document", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Gagal memproses dokumen");
      }

      setSegments(data.segments);
      if (data.featureName) setFeatureName(data.featureName);
      setUploadDocMsg(
        `✓ Berhasil menerapkan ${data.count} segmen storyboard dari ${file.name} (Estimasi Waktu | Arahan Visual | Naskah Voice Over)`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error upload";
      setUploadDocMsg(`⚠️ ${msg}`);
    } finally {
      setIsUploadingDoc(false);
      e.target.value = "";
    }
  };

  // Upload Reference Video (Aman untuk Vercel Serverless & File Video Ukuran Besar 50MB - 300MB+)
  const handleUploadVideo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploadingVideo(true);
    try {
      // 1. Selalu buat URL objek lokal instan:
      // - Berjalan instan (0 milidetik, tanpa waktu tunggu upload jaringan)
      // - Mendukung file video ukuran berapapun (misal 50MB - 500MB+)
      // - Bebas dari error Vercel 4.5MB Payload Too Large (FUNCTION_PAYLOAD_TOO_LARGE)
      const localBlobUrl = URL.createObjectURL(file);
      setActiveVideoUrl(localBlobUrl);
      setActiveVideoName(file.name);
      setActivePlayerMode("original");

      // 2. Jika ukuran file kecil (<= 4MB), sinkronkan ke server untuk backend FFmpeg jika tersedia
      if (file.size <= 4 * 1024 * 1024) {
        try {
          const formData = new FormData();
          formData.append("file", file);
          const res = await fetch("/api/upload-video", {
            method: "POST",
            body: formData,
          });
          const data = await res.json();
          if (data.success && data.videoUrl) {
            setServerVideoPath(data.videoUrl);
          }
        } catch {
          // Abaikan kegagalan serverless payload, pemutar lokal tetap berjalan sempurna
        }
      } else {
        setServerVideoPath(null);
      }
    } catch (err: unknown) {
      console.warn("[handleUploadVideo] Error:", err);
    } finally {
      setIsUploadingVideo(false);
      e.target.value = "";
    }
  };

  // Generate Timeline Voice Over
  const handleGenerateTimeline = async () => {
    const nonEmpties = segments.filter((s) => s.text.trim());
    if (!nonEmpties.length) {
      alert("Silakan isi minimal 1 baris Naskah Voice Over.");
      return;
    }

    setIsGenerating(true);
    setProgressMsg("Menghasilkan audio narasi AI ElevenLabs & merender video lengkap bersubtitle...");
    setTimelineResult(null);

    try {
      const res = await fetch("/api/timeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segments,
          voiceId: selectedVoiceId,
          voiceName: selectedVoiceName,
          featureName,
          modelId: selectedModelId,
          languageCode: selectedLangCode,
          stability: voiceSettings.stability,
          similarityBoost: voiceSettings.similarity_boost,
          style: voiceSettings.style,
          speed: voiceSettings.speed,
          useSpeakerBoost: voiceSettings.use_speaker_boost,
          fitMode,
          stretchShorter,
          burnSubtitles,
          subtitleStyle,
          subtitleFontSize,
          subtitleYpad,
          videoPath:
            serverVideoPath ||
            (activeVideoUrl?.startsWith("/api/") || activeVideoUrl?.startsWith("/reference_videos/")
              ? activeVideoUrl
              : undefined),
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Gagal memproses timeline");
      }

      setTimelineResult(data);
      if (data.dubbedVideoUrl) {
        setActivePlayerMode("dubbed");
      } else if (activeVideoUrl) {
        setActivePlayerMode("dubbed");
      } else {
        setActivePlayerMode("original");
      }
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Terjadi kesalahan saat generate");
    } finally {
      setIsGenerating(false);
      setProgressMsg("");
    }
  };

  return (
    <div className="space-y-6">
      {/* Tab Subheader */}
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-5">
        <h3 className="text-lg font-bold text-white flex items-center gap-2">
          <Clock className="w-5 h-5 text-blue-400" />
          Naskah Voice Over Berbasis Rentang Waktu (Format HH:MM:SS - HH:MM:SS)
        </h3>
        <p className="text-xs text-slate-400 mt-1 leading-relaxed">
          Susun atau unggah file naskah Anda (PDF, Word .docx/.doc, Google Docs, Excel .xlsx, .csv, .srt, .txt, .md).
          Seluruh durasi otomatis diselaraskan secara presisi dengan pengucapan AI.
        </p>

        {/* 3-Column Top Controls */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-5">
          {/* Preset Buttons */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-3.5 space-y-2">
            <span className="text-xs font-semibold text-slate-300 block">1. Preset & Format Tabel:</span>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <button
                onClick={() => {
                  setSegments(PAYMENT_METHOD_SEGMENTS);
                  setFeatureName("Payment_Method");
                }}
                className="bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 px-2.5 py-1.5 rounded-lg transition text-left"
              >
                💳 Naskah Payment
              </button>
              <button
                onClick={() => {
                  setSegments(PAYMENT_METHOD_VIDEO_SYNCED_SEGMENTS);
                  setFeatureName("Payment_Method");
                  setActiveVideoUrl("/reference_videos/Payment_Method_Tutorial.mp4");
                  setActiveVideoName("Payment_Method_Tutorial.mp4");
                  setActivePlayerMode("original");
                }}
                className="bg-slate-900 hover:bg-slate-800 border border-slate-800 text-blue-300 px-2.5 py-1.5 rounded-lg transition text-left font-medium"
              >
                📹 Synced Video (41s)
              </button>
              <button
                onClick={() => {
                  setSegments(CETAKIA_DEFAULT_SEGMENTS);
                  setFeatureName("Component");
                }}
                className="bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 px-2.5 py-1.5 rounded-lg transition text-left"
              >
                📄 Naskah Component
              </button>
              <button
                onClick={() => setSegments(resequenceTimelineTimestamps(segments))}
                className="bg-slate-900 hover:bg-slate-800 border border-slate-800 text-emerald-300 px-2.5 py-1.5 rounded-lg transition text-left"
              >
                🕒 Rapikan Waktu
              </button>
              <button
                onClick={() =>
                  setSegments(
                    segments.map((s) => ({ ...s, time_range: normalizeToHmsRange(s.time_range) }))
                  )
                }
                className="bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 px-2.5 py-1.5 rounded-lg transition text-left"
              >
                🕒 Standarkan HH:MM:SS
              </button>
              <button
                onClick={() =>
                  setSegments([
                    {
                      time_range: "00:00:00 - 00:00:05",
                      visual: "Adegan pembuka muncul.",
                      text: "Selamat datang di panduan penggunaan Cetakia.",
                    },
                  ])
                }
                className="bg-slate-900 hover:bg-slate-800 border border-slate-800 text-rose-300 px-2.5 py-1.5 rounded-lg transition text-left"
              >
                🧹 Reset (1 Baris)
              </button>
            </div>
          </div>

          {/* Document Upload */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-3.5 space-y-2">
            <span className="text-xs font-semibold text-slate-300 block">
              2. Upload File Naskah (Multi-Format):
            </span>
            <label className="flex flex-col items-center justify-center border border-dashed border-slate-700 hover:border-blue-500 rounded-xl p-3.5 cursor-pointer bg-slate-900/50 hover:bg-slate-900 transition">
              <Upload className="w-5 h-5 text-blue-400 mb-1" />
              <span className="text-xs text-slate-200 font-medium">Pilih Dokumen Naskah</span>
              <span className="text-[10px] text-slate-400">PDF, DOCX, XLSX, CSV, SRT, TXT</span>
              <input
                type="file"
                accept=".pdf,.docx,.doc,.xlsx,.xls,.csv,.srt,.vtt,.txt,.md"
                onChange={handleUploadDocument}
                disabled={isUploadingDoc}
                className="hidden"
              />
            </label>
            {uploadDocMsg && (
              <p className="text-[11px] text-emerald-400 bg-emerald-950/40 border border-emerald-800/50 rounded-lg p-2">
                {uploadDocMsg}
              </p>
            )}
          </div>

          {/* Mode Penyesuaian & Subtitle */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-3.5 space-y-2.5 text-xs">
            <span className="text-xs font-semibold text-slate-300 block">3. Mode & Subtitle:</span>
            <select
              value={fitMode}
              onChange={(e) => setFitMode(e.target.value as FitMode)}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-slate-200"
            >
              <option value="natural_pad">🌊 Kecepatan Alami + Jeda Hening</option>
              <option value="auto_fit">🎯 Auto-Fit Durasi (Sesuaikan Slot)</option>
              <option value="strict_trim">✂️ Potong Presisi Batas Waktu</option>
            </select>

            <label className="flex items-center gap-2 text-slate-300 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={burnSubtitles}
                onChange={(e) => setBurnSubtitles(e.target.checked)}
                className="rounded bg-slate-900 border-slate-700 text-blue-600 w-4 h-4"
              />
              <span>📝 Sertakan Subtitle Video (Bottom Center)</span>
            </label>

            {burnSubtitles && (
              <p className="text-[11px] text-slate-400 leading-relaxed pt-1">
                Subtitle disinkronkan langsung pada pemutar video di bawah. Atur ukuran font & margin bawah pada panel kontrol di bawah.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Panel Pengaturan Subtitle Video (Kontrol Luas & Sinkron ke Player) */}
      {burnSubtitles && (
        <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-lg">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
            <div>
              <h4 className="text-sm font-bold text-white flex items-center gap-2">
                <span className="text-base">🎨</span>
                Pengaturan Subtitle Video (Pratinjau Langsung pada Video di Bawah)
              </h4>
              <p className="text-xs text-slate-400 mt-0.5">
                Atur gaya visual, ukuran font, dan jarak aman posisi subtitle. Perubahan langsung terlihat pada pemutar video di bawah.
              </p>
            </div>
            {/* 3 Style Buttons */}
            <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-xl border border-slate-800">
              <button
                type="button"
                onClick={() => setSubtitleStyle("outline")}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${
                  subtitleStyle === "outline"
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <span>✨</span> Outline Hitam
              </button>
              <button
                type="button"
                onClick={() => setSubtitleStyle("shaded_box")}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${
                  subtitleStyle === "shaded_box"
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <span>⬛</span> Shaded Box
              </button>
              <button
                type="button"
                onClick={() => setSubtitleStyle("yellow_outline")}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${
                  subtitleStyle === "yellow_outline"
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <span>🟡</span> Yellow Outline
              </button>
            </div>
          </div>

          {/* Jangkauan Luas Ukuran Font & Margin Bawah dengan Stepper Buttons & Presets */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
            {/* Ukuran Font Subtitle: 18px - 60px (Canvas 1280x720) */}
            <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3.5 space-y-2.5">
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-300 font-semibold flex items-center gap-1.5">
                  <Type className="w-3.5 h-3.5 text-blue-400" />
                  Ukuran Font Subtitle (720p Canvas):
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSubtitleFontSize((prev) => Math.max(18, prev - 1))}
                    className="w-6 h-6 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 flex items-center justify-center font-mono text-xs font-bold transition"
                    title="Perkecil font (1px)"
                  >
                    -
                  </button>
                  <span className="font-mono text-blue-400 font-bold bg-blue-950/70 border border-blue-900/60 px-2 py-0.5 rounded text-xs min-w-[56px] text-center">
                    {subtitleFontSize} px
                  </span>
                  <button
                    type="button"
                    onClick={() => setSubtitleFontSize((prev) => Math.min(60, prev + 1))}
                    className="w-6 h-6 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 flex items-center justify-center font-mono text-xs font-bold transition"
                    title="Perbesar font (1px)"
                  >
                    +
                  </button>
                </div>
              </div>
              <input
                type="range"
                min={18}
                max={60}
                step={1}
                value={subtitleFontSize}
                onChange={(e) => setSubtitleFontSize(parseInt(e.target.value, 10))}
                className="w-full accent-blue-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
              />
              <div className="flex justify-between items-center text-[10px] text-slate-400 font-mono">
                <span className="text-slate-500">18px (Kompak)</span>
                <div className="flex items-center gap-1">
                  {[24, 30, 34, 40, 48].map((size) => (
                    <button
                      key={size}
                      type="button"
                      onClick={() => setSubtitleFontSize(size)}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition border ${
                        subtitleFontSize === size
                          ? "bg-blue-600 text-white border-blue-500 font-bold"
                          : size === 34
                          ? "bg-blue-950/60 text-blue-300 border-blue-800/80 hover:text-white"
                          : "bg-slate-900 text-slate-400 border-slate-800 hover:text-white"
                      }`}
                      title={size === 34 ? "Ukuran Standar 720p Rekomendasi" : undefined}
                    >
                      {size}px{size === 34 ? " ★" : ""}
                    </button>
                  ))}
                </div>
                <span className="text-slate-500">60px (Besar)</span>
              </div>
            </div>

            {/* Jarak Aman dari Bawah (ypad): 10px - 140px */}
            <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3.5 space-y-2.5">
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-300 font-semibold flex items-center gap-1.5">
                  <MoveVertical className="w-3.5 h-3.5 text-emerald-400" />
                  Jarak Aman dari Bawah (ypad):
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSubtitleYpad((prev) => Math.max(10, prev - 2))}
                    className="w-6 h-6 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 flex items-center justify-center font-mono text-xs font-bold transition"
                    title="Turunkan posisi (2px)"
                  >
                    -
                  </button>
                  <span className="font-mono text-emerald-400 font-bold bg-emerald-950/70 border border-emerald-900/60 px-2 py-0.5 rounded text-xs min-w-[56px] text-center">
                    {subtitleYpad} px
                  </span>
                  <button
                    type="button"
                    onClick={() => setSubtitleYpad((prev) => Math.min(140, prev + 2))}
                    className="w-6 h-6 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 flex items-center justify-center font-mono text-xs font-bold transition"
                    title="Naikkan posisi (2px)"
                  >
                    +
                  </button>
                </div>
              </div>
              <input
                type="range"
                min={10}
                max={140}
                step={2}
                value={subtitleYpad}
                onChange={(e) => setSubtitleYpad(parseInt(e.target.value, 10))}
                className="w-full accent-emerald-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
              />
              <div className="flex justify-between items-center text-[10px] text-slate-400 font-mono">
                <span className="text-slate-500">10px (Bawah)</span>
                <div className="flex items-center gap-1">
                  {[20, 30, 40, 65, 95].map((pad) => (
                    <button
                      key={pad}
                      type="button"
                      onClick={() => setSubtitleYpad(pad)}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition border ${
                        subtitleYpad === pad
                          ? "bg-emerald-600 text-white border-emerald-500 font-bold"
                          : pad === 40
                          ? "bg-emerald-950/60 text-emerald-300 border-emerald-800/80 hover:text-white"
                          : "bg-slate-900 text-slate-400 border-slate-800 hover:text-white"
                      }`}
                      title={pad === 40 ? "Posisi Margin Bawah Rekomendasi" : undefined}
                    >
                      {pad}px{pad === 40 ? " ★" : ""}
                    </button>
                  ))}
                </div>
                <span className="text-slate-500">140px (Atas)</span>
              </div>
            </div>
          </div>

          {/* Quick Zero-Token Remux Bar saat video/audio sudah ada */}
          {timelineResult?.audioUrl && (
            <div className="mt-3 p-3.5 rounded-xl bg-gradient-to-r from-amber-950/40 via-slate-950 to-emerald-950/40 border border-amber-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-lg">
              <div className="flex items-center gap-2.5 text-xs">
                <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
                <div>
                  <span className="font-bold text-amber-300">Mau ubah subtitle pada video yang sudah dibuat?</span>
                  <p className="text-slate-300 text-[11px] mt-0.5">
                    Terapkan font ({subtitleFontSize}px), gaya, & posisi ({subtitleYpad}px) ini langsung ke video tanpa kuota ElevenLabs (proses kilat ~3-5 detik).
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleRemuxSubtitles}
                disabled={isRemuxing}
                className="bg-gradient-to-r from-amber-500 to-emerald-500 hover:from-amber-400 hover:to-emerald-400 disabled:opacity-50 text-slate-950 font-bold text-xs px-4 py-2 rounded-xl shadow-md transition flex items-center justify-center gap-1.5 shrink-0"
              >
                {isRemuxing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-950" />
                    <span>Memperbarui Subtitle...</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 text-slate-950" />
                    <span>⚡ Perbarui Subtitle Video (0 Token API)</span>
                  </>
                )}
              </button>
            </div>
          )}

          {remuxSuccessMsg && (
            <div className="mt-2.5 p-3 bg-emerald-950/80 border border-emerald-500/50 rounded-xl text-xs text-emerald-300 flex items-center gap-2 animate-in fade-in">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{remuxSuccessMsg}</span>
            </div>
          )}
        </div>
      )}

      {/* Video Acuan MP4 & Synchronized Video Player */}
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-5">
        <div className="flex flex-col md:flex-row gap-5">
          {/* Video upload & action column */}
          <div className="md:w-1/2 space-y-3">
            <h4 className="text-sm font-bold text-white flex items-center gap-2">
              <Film className="w-4 h-4 text-purple-400" />
              Referensi & Sinkronisasi Video Acuan
            </h4>
            <label className="flex items-center justify-between border border-dashed border-slate-700 hover:border-purple-500 rounded-xl p-3 cursor-pointer bg-slate-950 hover:bg-slate-900 transition">
              <div className="flex items-center gap-2.5">
                <Video className="w-5 h-5 text-purple-400" />
                <div>
                  <span className="text-xs text-slate-200 font-medium block">
                    {activeVideoName || "Unggah Video MP4 / WebM Acuan"}
                  </span>
                  <span className="text-[10px] text-slate-400">
                    Mendukung video hingga 300MB (Hemat RAM)
                  </span>
                </div>
              </div>
              <input
                type="file"
                accept="video/mp4,video/webm,video/quicktime,video/mkv"
                onChange={handleUploadVideo}
                disabled={isUploadingVideo}
                className="hidden"
              />
            </label>

            <div className="flex gap-2">
              <button
                onClick={() => {
                  setActiveVideoUrl("/reference_videos/Payment_Method_Tutorial.mp4");
                  setActiveVideoName("Payment_Method_Tutorial.mp4");
                  setActivePlayerMode("original");
                }}
                className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-lg transition"
              >
                🎬 Preset Payment Method (41s)
              </button>
              {activeVideoUrl && (
                <button
                  onClick={() => {
                    setActiveVideoUrl(null);
                    setActiveVideoName(null);
                  }}
                  className="text-xs bg-rose-950/60 hover:bg-rose-900 border border-rose-800/50 text-rose-300 px-3 py-1.5 rounded-lg transition"
                >
                  ❌ Lepas Video
                </button>
              )}
            </div>

            {activeVideoUrl && (
              <div className="text-xs bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-300 space-y-1">
                <p>
                  🎥 <strong>Video Aktif:</strong> {activeVideoName}
                </p>
                <p className="text-slate-400">
                  ✓ Anda dapat melompatkan pemutar video ke detik awal tiap baris storyboard di bawah.
                </p>
              </div>
            )}
          </div>

          {/* Video player column dengan skala preview real-time presisi 1:1 */}
          <div className="md:w-1/2 flex flex-col justify-center" ref={playerContainerRef}>
            {activeVideoUrl ? (
              <div className="space-y-2">
                {(timelineResult?.dubbedVideoUrl || (activeVideoUrl && timelineResult?.audioUrl)) && (
                  <div className="flex items-center gap-2 text-xs mb-1">
                    <span className="text-slate-400">Mode Tampilan:</span>
                    <button
                      onClick={() => {
                        setActivePlayerMode("dubbed");
                        if (dubbedAudioRef.current && videoRef.current) {
                          dubbedAudioRef.current.currentTime = videoRef.current.currentTime;
                          if (!videoRef.current.paused) {
                            dubbedAudioRef.current.play().catch(() => {});
                          }
                        }
                      }}
                      className={`px-2.5 py-1 rounded-lg font-medium transition ${
                        activePlayerMode === "dubbed"
                          ? "bg-blue-600 text-white shadow-md shadow-blue-600/30"
                          : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                      }`}
                    >
                      🎬 {timelineResult?.dubbedVideoUrl ? "Video Final Dubbing (Suara AI)" : "Video + Suara AI (Voice Over)"}
                    </button>
                    <button
                      onClick={() => {
                        setActivePlayerMode("original");
                        if (dubbedAudioRef.current) {
                          dubbedAudioRef.current.pause();
                        }
                      }}
                      className={`px-2.5 py-1 rounded-lg font-medium transition ${
                        activePlayerMode === "original"
                          ? "bg-blue-600 text-white shadow-md shadow-blue-600/30"
                          : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                      }`}
                    >
                      📹 Video Acuan Asli
                    </button>
                  </div>
                )}
                <div className="relative rounded-xl overflow-hidden bg-black border border-slate-800 aspect-video flex items-center justify-center">
                  <video
                    ref={videoRef}
                    controls
                    onTimeUpdate={(e) => {
                      const cur = e.currentTarget.currentTime;
                      setCurrentVideoTime(cur);
                      const isDubbedWithSync =
                        activePlayerMode === "dubbed" &&
                        !timelineResult?.dubbedVideoUrl &&
                        Boolean(timelineResult?.audioUrl);
                      if (isDubbedWithSync && dubbedAudioRef.current) {
                        if (Math.abs(dubbedAudioRef.current.currentTime - cur) > 0.3) {
                          dubbedAudioRef.current.currentTime = cur;
                        }
                      }
                    }}
                    onPlay={() => {
                      const isDubbedWithSync =
                        activePlayerMode === "dubbed" &&
                        !timelineResult?.dubbedVideoUrl &&
                        Boolean(timelineResult?.audioUrl);
                      if (isDubbedWithSync && dubbedAudioRef.current) {
                        dubbedAudioRef.current.currentTime = videoRef.current?.currentTime || 0;
                        dubbedAudioRef.current.play().catch(() => {});
                      }
                    }}
                    onPause={() => {
                      if (dubbedAudioRef.current) {
                        dubbedAudioRef.current.pause();
                      }
                    }}
                    onSeeked={() => {
                      const isDubbedWithSync =
                        activePlayerMode === "dubbed" &&
                        !timelineResult?.dubbedVideoUrl &&
                        Boolean(timelineResult?.audioUrl);
                      if (isDubbedWithSync && dubbedAudioRef.current && videoRef.current) {
                        dubbedAudioRef.current.currentTime = videoRef.current.currentTime;
                      }
                    }}
                    onVolumeChange={() => {
                      const isDubbedWithSync =
                        activePlayerMode === "dubbed" &&
                        !timelineResult?.dubbedVideoUrl &&
                        Boolean(timelineResult?.audioUrl);
                      if (isDubbedWithSync && dubbedAudioRef.current && videoRef.current) {
                        dubbedAudioRef.current.volume = videoRef.current.volume;
                      }
                    }}
                    src={
                      activePlayerMode === "dubbed" && timelineResult?.dubbedVideoUrl
                        ? timelineResult.dubbedVideoUrl
                        : activeVideoUrl || undefined
                    }
                    className="w-full h-full object-contain"
                    muted={Boolean(
                      activePlayerMode === "dubbed" &&
                        !timelineResult?.dubbedVideoUrl &&
                        timelineResult?.audioUrl
                    )}
                  />

                  {/* Hidden Audio Element untuk Sinkronisasi Suara Voice Over AI secara Real-Time */}
                  {timelineResult?.audioUrl && (
                    <audio
                      ref={dubbedAudioRef}
                      src={timelineResult.audioUrl}
                      className="hidden"
                      preload="auto"
                    />
                  )}

                  {/* Real-time Subtitle Overlay on Video Player (Proporsional 1:1 dengan Kanvas 1280x720) */}
                  {burnSubtitles &&
                    showLiveSubtitleOnPlayer &&
                    (activePlayerMode === "original" ||
                      (activePlayerMode === "dubbed" && !timelineResult?.dubbedVideoUrl)) && (
                    <div className="absolute inset-0 pointer-events-none overflow-hidden select-none z-10">
                      <div
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "1280px",
                          height: "720px",
                          transform: `scale(${previewScale})`,
                          transformOrigin: "top left",
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "flex-end",
                          alignItems: "center",
                          paddingBottom: `${subtitleYpad}px`,
                          paddingLeft: "70px",
                          paddingRight: "70px",
                          boxSizing: "border-box",
                        }}
                      >
                        {effectiveSubtitleText && (
                          <div
                            style={{
                              fontSize: `${subtitleFontSize}px`,
                              fontWeight: "bold",
                              lineHeight: 1.25,
                              textAlign: "center",
                              maxWidth: "1140px",
                              fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
                              letterSpacing: "0.01em",
                              ...(subtitleStyle === "shaded_box"
                                ? {
                                    color: "#ffffff",
                                    backgroundColor: "rgba(11, 19, 43, 0.90)",
                                    padding: "6px 18px",
                                    borderRadius: "6px",
                                    boxShadow: "0 6px 18px rgba(0, 0, 0, 0.6)",
                                  }
                                : subtitleStyle === "yellow_outline"
                                ? {
                                    color: "#ffff00",
                                    textShadow:
                                      "-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 3px 6px rgba(0,0,0,0.8)",
                                  }
                                : {
                                    color: "#ffffff",
                                    textShadow:
                                      "-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 3px 6px rgba(0,0,0,0.8)",
                                  }),
                            }}
                          >
                            {effectiveSubtitleText}
                          </div>
                        )}

                        {/* Safe Margin Guide Line in 1280x720 canvas coordinates */}
                        <div
                          style={{
                            position: "absolute",
                            bottom: `${subtitleYpad}px`,
                            left: "40px",
                            right: "40px",
                            borderBottom: "1.5px dashed rgba(59, 130, 246, 0.5)",
                            display: "flex",
                            justifyContent: "space-between",
                            fontSize: "14px",
                            color: "#60a5fa",
                            fontFamily: "monospace",
                            fontWeight: "bold",
                            paddingBottom: "3px",
                          }}
                        >
                          <span>Safe Margin ({subtitleYpad}px)</span>
                          <span>Font: {subtitleFontSize}px (720p 1:1 WYSIWYG)</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              /* Sleek 16:9 Canvas Preview if no video loaded yet */
              <div className="relative rounded-xl overflow-hidden bg-slate-950 border border-slate-800 aspect-video flex flex-col items-center justify-center p-6 text-center select-none shadow-xl">
                <div className="space-y-1.5 max-w-sm z-0 opacity-60">
                  <Film className="w-8 h-8 text-purple-400 mx-auto" />
                  <p className="text-xs font-semibold text-slate-200">Pratinjau Subtitle (Kanvas Video 16:9)</p>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Unggah video acuan atau pilih preset di samping. Tampilan subtitle di bawah diselaraskan 1:1 dengan video final 1280x720.
                  </p>
                </div>

                {/* Subtitle overlay on empty canvas */}
                {burnSubtitles && (
                  <div className="absolute inset-0 pointer-events-none overflow-hidden select-none z-10">
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "1280px",
                        height: "720px",
                        transform: `scale(${previewScale})`,
                        transformOrigin: "top left",
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "flex-end",
                        alignItems: "center",
                        paddingBottom: `${subtitleYpad}px`,
                        paddingLeft: "70px",
                        paddingRight: "70px",
                        boxSizing: "border-box",
                      }}
                    >
                      {effectiveSubtitleText && (
                        <div
                          style={{
                            fontSize: `${subtitleFontSize}px`,
                            fontWeight: "bold",
                            lineHeight: 1.25,
                            textAlign: "center",
                            maxWidth: "1140px",
                            fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
                            letterSpacing: "0.01em",
                            ...(subtitleStyle === "shaded_box"
                              ? {
                                  color: "#ffffff",
                                  backgroundColor: "rgba(11, 19, 43, 0.90)",
                                  padding: "6px 18px",
                                  borderRadius: "6px",
                                  boxShadow: "0 6px 18px rgba(0, 0, 0, 0.6)",
                                }
                              : subtitleStyle === "yellow_outline"
                              ? {
                                  color: "#ffff00",
                                  textShadow:
                                    "-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 3px 6px rgba(0,0,0,0.8)",
                                }
                              : {
                                  color: "#ffffff",
                                  textShadow:
                                    "-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 3px 6px rgba(0,0,0,0.8)",
                                }),
                          }}
                        >
                          {effectiveSubtitleText}
                        </div>
                      )}

                      {/* Safe Margin Guide Line in 1280x720 canvas coordinates */}
                      <div
                        style={{
                          position: "absolute",
                          bottom: `${subtitleYpad}px`,
                          left: "40px",
                          right: "40px",
                          borderBottom: "1.5px dashed rgba(59, 130, 246, 0.5)",
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: "14px",
                          color: "#60a5fa",
                          fontFamily: "monospace",
                          fontWeight: "bold",
                          paddingBottom: "3px",
                        }}
                      >
                        <span>Safe Margin ({subtitleYpad}px)</span>
                        <span>Font: {subtitleFontSize}px (720p 1:1 WYSIWYG)</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Storyboard Interactive Table */}
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-bold text-white flex items-center gap-2">
            <FileText className="w-4 h-4 text-emerald-400" />
            Tabel Storyboard ({segments.length} Segmen)
          </h4>
          <span className="text-xs text-slate-400">
            Estimasi Waktu | Arahan Visual | Naskah Voice Over
          </span>
        </div>

        {/* Table rows */}
        <div className="space-y-3">
          {segments.map((seg, idx) => {
            const [sSec, eSec] = parseTimeRangeStr(seg.time_range);
            const startHms = formatSecondsToHms(sSec, true);
            const endHms = formatSecondsToHms(eSec, true);
            const dur = Math.max(0, eSec - sSec);
            const words = (seg.text || "").trim().split(/\s+/).filter(Boolean).length;
            const estSec = Number((words / 2.4).toFixed(1));

            return (
              <div
                key={idx}
                className="bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-xl p-3.5 flex flex-col md:flex-row gap-3 text-xs transition"
              >
                {/* Index & Timecode Dropdown */}
                <div className="md:w-56 space-y-2 shrink-0">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-200">#{idx + 1}</span>
                    <span className="text-[11px] font-mono text-blue-400 bg-blue-950/60 px-1.5 py-0.5 rounded">
                      {dur} detik
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-1.5">
                    <div>
                      <span className="text-[10px] text-slate-400 block mb-0.5">🟢 Mulai</span>
                      <input
                        type="text"
                        value={startHms}
                        onChange={(e) => {
                          const newStart = e.target.value;
                          const copy = [...segments];
                          copy[idx].time_range = `${newStart} - ${endHms}`;
                          setSegments(copy);
                        }}
                        onBlur={() => {
                          const copy = [...segments];
                          copy[idx].time_range = normalizeToHmsRange(copy[idx].time_range);
                          setSegments(copy);
                        }}
                        className="w-full bg-slate-900 border border-slate-800 rounded p-1 text-[11px] text-slate-200 font-mono text-center focus:border-blue-500 outline-none"
                        placeholder="00:00:00"
                        title="Jam:Menit:Detik Mulai (HH:MM:SS)"
                      />
                    </div>

                    <div>
                      <span className="text-[10px] text-slate-400 block mb-0.5">🔴 Selesai</span>
                      <input
                        type="text"
                        value={endHms}
                        onChange={(e) => {
                          const newEnd = e.target.value;
                          const copy = [...segments];
                          copy[idx].time_range = `${startHms} - ${newEnd}`;
                          setSegments(copy);
                        }}
                        onBlur={() => {
                          const copy = [...segments];
                          copy[idx].time_range = normalizeToHmsRange(copy[idx].time_range);
                          setSegments(copy);
                        }}
                        className="w-full bg-slate-900 border border-slate-800 rounded p-1 text-[11px] text-slate-200 font-mono text-center focus:border-blue-500 outline-none"
                        placeholder="00:00:05"
                        title="Jam:Menit:Detik Selesai (HH:MM:SS)"
                      />
                    </div>
                  </div>

                  {activeVideoUrl && (
                    <button
                      onClick={() => handleSeekVideo(sSec)}
                      className="w-full mt-1 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-purple-300 py-1 rounded text-[10px] flex items-center justify-center gap-1 transition"
                    >
                      <Play className="w-3 h-3" />
                      Pratinjau di Video ({startHms})
                    </button>
                  )}
                </div>

                {/* Arahan Visual */}
                <div className="md:w-1/3 flex flex-col justify-center">
                  <textarea
                    value={seg.visual}
                    onChange={(e) => {
                      const copy = [...segments];
                      copy[idx].visual = e.target.value;
                      setSegments(copy);
                    }}
                    placeholder="Arahan visual / adegan video..."
                    className="w-full h-20 bg-slate-900/90 border border-slate-800 rounded-lg p-2 text-xs text-slate-300 placeholder:text-slate-600 focus:outline-none focus:border-slate-700 resize-none"
                  />
                </div>

                {/* Naskah Voice Over */}
                <div className="flex-1 flex flex-col justify-between">
                  <textarea
                    value={seg.text}
                    onChange={(e) => {
                      const copy = [...segments];
                      copy[idx].text = e.target.value;
                      setSegments(copy);
                    }}
                    placeholder="Teks naskah yang akan diucapkan oleh Voice Over..."
                    className="w-full h-20 bg-slate-900/90 border border-slate-800 rounded-lg p-2 text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-blue-500 resize-none"
                  />
                  <div className="flex justify-between items-center text-[10px] text-slate-500 pt-1">
                    <span>
                      {words} kata (~{estSec}s bicara)
                    </span>
                    <span className={estSec <= dur + 0.8 ? "text-emerald-400" : "text-amber-400"}>
                      {estSec <= dur + 0.8 ? "🟢 Pas di slot" : "🟡 Auto-Fit ke durasi"}
                    </span>
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex md:flex-col justify-between gap-1 shrink-0">
                  <div className="flex md:flex-col gap-1">
                    <button
                      onClick={() => {
                        if (idx > 0) {
                          const copy = [...segments];
                          [copy[idx - 1], copy[idx]] = [copy[idx], copy[idx - 1]];
                          setSegments(copy);
                        }
                      }}
                      disabled={idx === 0}
                      className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white disabled:opacity-30 transition"
                      title="Geser ke atas"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => {
                        if (idx < segments.length - 1) {
                          const copy = [...segments];
                          [copy[idx + 1], copy[idx]] = [copy[idx], copy[idx + 1]];
                          setSegments(copy);
                        }
                      }}
                      disabled={idx === segments.length - 1}
                      className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white disabled:opacity-30 transition"
                      title="Geser ke bawah"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <button
                    onClick={() => {
                      const copy = segments.filter((_, i) => i !== idx);
                      setSegments(copy);
                    }}
                    className="p-1.5 rounded hover:bg-rose-950/80 text-rose-400 transition"
                    title="Hapus baris"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Buttons: Add Segment & Generate */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
          <button
            onClick={() => {
              let nextStart = 0;
              if (segments.length) {
                const [, e] = parseTimeRangeStr(segments[segments.length - 1].time_range);
                nextStart = e + 1;
              }
              const nextEnd = nextStart + 5;
              setSegments([
                ...segments,
                {
                  time_range: `${formatSecondsToHms(nextStart, true)} - ${formatSecondsToHms(nextEnd, true)}`,
                  visual: "",
                  text: "",
                },
              ]);
            }}
            className="w-full sm:w-auto bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 px-4 py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition"
          >
            <Plus className="w-4 h-4" />
            Tambah Baris Segmen Waktu
          </button>

          <button
            onClick={handleGenerateTimeline}
            disabled={isGenerating}
            className="w-full sm:w-auto bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold px-6 py-2.5 rounded-xl text-xs flex items-center justify-center gap-2 transition disabled:opacity-50 shadow-lg shadow-blue-600/20"
          >
            <Sparkles className="w-4 h-4" />
            {isGenerating
              ? "Sedang Memproses Timeline..."
              : `Generate Timeline Voice Over (${segments.length} Segmen — '${selectedVoiceName}')`}
          </button>
        </div>

        {isGenerating && (
          <div className="p-4 bg-blue-950/40 border border-blue-800/50 rounded-xl space-y-2">
            <div className="flex items-center justify-between text-xs text-blue-300">
              <span>{progressMsg}</span>
              <span className="animate-pulse">Menghubungkan ke ElevenLabs API...</span>
            </div>
            <div className="w-full h-1.5 bg-slate-900 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full animate-indeterminate" />
            </div>
          </div>
        )}
      </div>

      {/* Result Section */}
      {timelineResult && (
        <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 space-y-6 animate-in fade-in shadow-2xl">
          {/* Header Banner */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 pb-4 border-b border-slate-800/80">
            <div>
              <div className="flex items-center gap-2 text-emerald-400 font-bold text-base">
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                Hasil Generate Lengkap Berhasil Dibuat!
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Video, Voice Over AI ({selectedVoiceName}), dan Subtitle otomatis telah digabungkan secara sinkron.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
              <span className="bg-slate-950 border border-slate-800 text-blue-400 px-3 py-1 rounded-lg">
                ⏱️ {formatSecondsToHms(timelineResult.totalTimelineSec, true)}
              </span>
              <span className="bg-slate-950 border border-slate-800 text-slate-400 px-3 py-1 rounded-lg">
                ⚡ {timelineResult.elapsedSec}s
              </span>
            </div>
          </div>

          {/* Primary Hero: Video Final Dubbing Bersubtitle (Video + Voice Over + Subtitle) */}
          {timelineResult.dubbedVideoUrl && (
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-5 space-y-3.5 shadow-lg">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-base">🎬</span>
                  <div>
                    <h5 className="text-sm font-bold text-white">
                      Video Lengkap (Video + Voice Over + Subtitle)
                    </h5>
                    <p className="text-[11px] text-slate-400">
                      Telah diselaraskan dengan suara narasi AI & subtitle terbakar permanen (burned-in) di tengah bawah.
                    </p>
                  </div>
                </div>
                <span className="text-[11px] font-mono bg-purple-950/60 border border-purple-800/50 text-purple-300 px-2.5 py-1 rounded-lg">
                  HD 720p • MP4
                </span>
              </div>

              <div className="relative rounded-lg overflow-hidden bg-black aspect-video max-h-[460px] mx-auto border border-slate-800 flex items-center justify-center">
                <video
                  controls
                  src={timelineResult.dubbedVideoUrl}
                  className="w-full h-full object-contain"
                  playsInline
                />
              </div>

              {/* Main Video Download & Quick Subtitle Remux Buttons */}
              <div className="pt-2 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                <div className="text-xs text-slate-400 flex items-center gap-2">
                  <span>💡</span>
                  <span>Video siap digunakan langsung untuk publikasi atau kebutuhan presentasi Anda.</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleRemuxSubtitles}
                    disabled={isRemuxing}
                    className="bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 px-4 py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition shadow-sm"
                    title="Perbarui subtitle pada video ini mengikuti ukuran font & jarak aman saat ini tanpa menggunakan kuota ElevenLabs"
                  >
                    {isRemuxing ? (
                      <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
                    ) : (
                      <RefreshCw className="w-4 h-4 text-amber-400" />
                    )}
                    <span>⚡ Perbarui Subtitle ({subtitleFontSize}px) • 0 Token</span>
                  </button>
                  <a
                    href={timelineResult.dubbedVideoUrl}
                    download={`${featureName || "video_voiceover_subtitle"}.mp4`}
                    className="bg-gradient-to-r from-purple-600 via-indigo-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white px-5 py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition shadow-lg shadow-purple-600/30"
                  >
                    <Download className="w-4 h-4" />
                    Unduh Video Lengkap (.MP4)
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* Primary Hero ketika Video Acuan diunggah langsung di browser (Client-Side Video & Voice Over Sync) */}
          {!timelineResult.dubbedVideoUrl && activeVideoUrl && (
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-5 space-y-3.5 shadow-lg">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-base">🎬</span>
                  <div>
                    <h5 className="text-sm font-bold text-white">
                      Sinkronisasi Video + Suara Narasi AI + Subtitle Aktif
                    </h5>
                    <p className="text-[11px] text-slate-400">
                      Video acuan Anda telah terhubung secara presisi dengan Voice Over AI & subtitle otomatis di pemutar di atas.
                    </p>
                  </div>
                </div>
                <span className="text-[11px] font-mono bg-emerald-950/60 border border-emerald-800/50 text-emerald-300 px-2.5 py-1 rounded-lg">
                  ⚡ Live Interactive Sync
                </span>
              </div>

              <div className="text-xs bg-slate-900 border border-slate-800 rounded-xl p-4 text-slate-300 flex items-start gap-3">
                <span className="text-lg">✨</span>
                <div>
                  <p className="font-semibold text-white">Pratinjau Instan Berjalan di Pemutar Video Acuan</p>
                  <p className="text-slate-400 mt-0.5 leading-relaxed">
                    Pemutar video di atas otomatis beralih ke mode <strong>&ldquo;🎬 Video + Suara AI (Voice Over)&rdquo;</strong> dengan subtitle presisi. Anda dapat memutar video di atas untuk melihat hasilnya secara langsung, atau mengunduh master audio narasi WAV dan file subtitle SRT di bawah untuk kebutuhan editing Anda.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Secondary Components: Audio & Subtitle */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Master Audio Track */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                  🎧 Master Audio Voice Over Saja
                </span>
                <span className="text-[10px] text-slate-500 font-mono">WAV 24kHz</span>
              </div>
              <audio controls src={timelineResult.audioUrl} className="w-full" />
              <div className="pt-1">
                <a
                  href={timelineResult.audioUrl}
                  download={`${featureName || "timeline_audio"}.wav`}
                  className="w-full bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 px-3 py-1.5 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition"
                >
                  <Download className="w-3.5 h-3.5 text-blue-400" />
                  Unduh Master Audio (.WAV)
                </a>
              </div>
            </div>

            {/* Standalone Subtitle SRT */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2.5 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                    📝 File Subtitle Eksternal
                  </span>
                  <span className="text-[10px] text-slate-500 font-mono">SRT Format</span>
                </div>
                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                  File subtitle mandiri jika Anda ingin mengedit kembali di CapCut, Premiere Pro, atau YouTube Studio.
                </p>
              </div>
              {timelineResult.srtUrl ? (
                <a
                  href={timelineResult.srtUrl}
                  download={`${featureName || "subtitle"}.srt`}
                  className="w-full bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 px-3 py-1.5 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition"
                >
                  <Download className="w-3.5 h-3.5 text-emerald-400" />
                  Unduh Subtitle (.SRT)
                </a>
              ) : (
                <span className="text-xs text-slate-500 italic">Subtitle tidak diaktifkan</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

