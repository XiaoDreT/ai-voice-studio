"use client";

import React, { useState, useEffect, useRef } from "react";
import { StoryboardSegment, SubtitleStyle } from "@/types";
import { parseTimeRangeStr, formatSecondsToHms } from "@/lib/timeline-engine";
import {
  Eye,
  Sliders,
  Type,
  MoveVertical,
  Video,
  Play,
  Pause,
  RotateCcw,
  CheckCircle2,
  Sparkles,
} from "lucide-react";

interface SubtitlePreviewProps {
  segments: StoryboardSegment[];
  activeVideoUrl: string | null;
  subtitleStyle: SubtitleStyle;
  onChangeStyle: (style: SubtitleStyle) => void;
  fontSize: number;
  onChangeFontSize: (size: number) => void;
  ypad: number;
  onChangeYpad: (pad: number) => void;
}

export const SubtitlePreview: React.FC<SubtitlePreviewProps> = ({
  segments,
  activeVideoUrl,
  subtitleStyle,
  onChangeStyle,
  fontSize,
  onChangeFontSize,
  ypad,
  onChangeYpad,
}) => {
  const [selectedSegmentIdx, setSelectedSegmentIdx] = useState<number>(0);
  const [customText, setCustomText] = useState<string>("");
  const [useCustomText, setUseCustomText] = useState<boolean>(false);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [videoCurrentTime, setVideoCurrentTime] = useState<number>(0);
  const [videoLoaded, setVideoLoaded] = useState<boolean>(false);

  const videoRef = useRef<HTMLVideoElement>(null);

  const nonEmpties = segments.filter((s) => s.text.trim());
  const currentSegment = nonEmpties[selectedSegmentIdx] || nonEmpties[0] || segments[0];

  // Cari segmen aktif sesuai waktu video saat pemutaran berjalan agar pratinjau sinkron 100%
  const activeSegmentAtTime = React.useMemo(() => {
    for (let i = 0; i < nonEmpties.length; i++) {
      const s = nonEmpties[i];
      const [start, end] = parseTimeRangeStr(s.time_range);
      if (videoCurrentTime >= start && videoCurrentTime <= end) {
        return { seg: s, idx: i };
      }
    }
    return null;
  }, [nonEmpties, videoCurrentTime]);

  const displayedSegment = isPlaying && activeSegmentAtTime ? activeSegmentAtTime.seg : currentSegment;

  const previewText = useCustomText
    ? customText || "Selamat datang di panduan penggunaan Cetakia."
    : displayedSegment?.text || "Selamat datang di panduan penggunaan Cetakia.";

  // Hitung waktu awal dan akhir dari segmen yang sedang aktif
  const [startSec, endSec] = currentSegment?.time_range
    ? parseTimeRangeStr(currentSegment.time_range)
    : [0, 5];

  const startHms = formatSecondsToHms(startSec, true);
  const endHms = formatSecondsToHms(endSec, true);

  // Fungsi untuk melompat ke detik awal segmen pada video
  const seekToSegmentStart = (segIdx: number) => {
    const seg = nonEmpties[segIdx] || segments[segIdx];
    if (!seg) return;
    const [s] = parseTimeRangeStr(seg.time_range);
    const video = videoRef.current;
    if (video) {
      if (video.readyState >= 1) {
        video.currentTime = Math.max(0, s);
        setVideoCurrentTime(Math.max(0, s));
      } else {
        const onLoaded = () => {
          video.currentTime = Math.max(0, s);
          setVideoCurrentTime(Math.max(0, s));
          video.removeEventListener("loadedmetadata", onLoaded);
        };
        video.addEventListener("loadedmetadata", onLoaded);
      }
    }
  };

  // Update posisi video saat segmen berganti
  useEffect(() => {
    seekToSegmentStart(selectedSegmentIdx);
    setIsPlaying(false);
    if (videoRef.current) {
      videoRef.current.pause();
    }
  }, [selectedSegmentIdx, activeVideoUrl]);

  // Toggle play / pause pada video preview
  const handleTogglePlay = () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      video
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  // Reset ke awal segmen
  const handleResetToStart = () => {
    const video = videoRef.current;
    if (video) {
      video.currentTime = Math.max(0, startSec);
      setVideoCurrentTime(Math.max(0, startSec));
    }
  };

  // Compute CSS text style based on subtitleStyle (selaras 100% dengan FFmpeg subtitle output)
  const getSubtitleCss = (): React.CSSProperties => {
    const scaledSize = Math.max(12, Math.round(fontSize * 1.15));

    const baseStyle: React.CSSProperties = {
      fontSize: `${scaledSize}px`,
      lineHeight: "1.35",
      maxWidth: "88%",
      textAlign: "center",
      userSelect: "none",
      fontFamily: "Inter, var(--font-geist-sans), sans-serif",
      letterSpacing: "0.01em",
    };

    if (subtitleStyle === "shaded_box") {
      return {
        ...baseStyle,
        color: "#ffffff",
        backgroundColor: "rgba(15, 23, 42, 0.88)",
        padding: "5px 14px",
        borderRadius: "6px",
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.5)",
        fontWeight: "600",
      };
    }

    if (subtitleStyle === "yellow_outline") {
      return {
        ...baseStyle,
        color: "#ffeb3b",
        fontWeight: "700",
        textShadow:
          "-1.2px -1.2px 0 #000, 1.2px -1.2px 0 #000, -1.2px 1.2px 0 #000, 1.2px 1.2px 0 #000, 0 2px 4px rgba(0,0,0,0.8)",
      };
    }

    // Default: "outline"
    return {
      ...baseStyle,
      color: "#ffffff",
      fontWeight: "700",
      textShadow:
        "-1.2px -1.2px 0 #000, 1.2px -1.2px 0 #000, -1.2px 1.2px 0 #000, 1.2px 1.2px 0 #000, 0 2px 4px rgba(0,0,0,0.8)",
    };
  };

  return (
    <div className="bg-slate-950 border border-slate-800 rounded-2xl p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
        <div>
          <h4 className="text-sm font-bold text-white flex items-center gap-2">
            <Eye className="w-4 h-4 text-blue-400" />
            Pratinjau Langsung Subtitle Video (Real-Time Visual Preview)
          </h4>
          <p className="text-xs text-slate-400 mt-0.5">
            Lihat tampilan aktual teks naskah pada video acuan sebelum menekan tombol Generate.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono text-emerald-400 bg-emerald-950/60 border border-emerald-800/40 px-2.5 py-1 rounded-lg">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Live Interactive 0ms
        </div>
      </div>

      {/* Main Preview Screen (Aspect 16:9) */}
      <div className="relative rounded-xl overflow-hidden bg-slate-900 border border-slate-800 aspect-video flex items-center justify-center select-none shadow-2xl">
        {/* Real Video Player when activeVideoUrl is present */}
        {activeVideoUrl ? (
          <div className="relative w-full h-full bg-black flex items-center justify-center">
            <video
              ref={videoRef}
              src={activeVideoUrl}
              playsInline
              muted
              className="w-full h-full object-contain"
              onLoadedMetadata={() => {
                setVideoLoaded(true);
                seekToSegmentStart(selectedSegmentIdx);
              }}
              onTimeUpdate={(e) => setVideoCurrentTime(e.currentTarget.currentTime)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            />

            {/* Top Video Floating Toolbar */}
            <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-slate-950/85 backdrop-blur-md border border-slate-800/80 rounded-xl p-1 text-[11px] text-slate-200 z-20 shadow-lg">
              <button
                onClick={handleTogglePlay}
                className="px-2.5 py-1 hover:bg-slate-800 rounded-lg flex items-center gap-1.5 transition font-medium"
              >
                {isPlaying ? (
                  <Pause className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
                ) : (
                  <Play className="w-3.5 h-3.5 text-emerald-400 fill-emerald-400" />
                )}
                <span>{isPlaying ? "Jeda" : "Putar Video"}</span>
              </button>

              <div className="w-[1px] h-4 bg-slate-800" />

              <button
                onClick={handleResetToStart}
                className="px-2 py-1 hover:bg-slate-800 rounded-lg flex items-center gap-1 text-blue-400 hover:text-blue-300 transition font-mono"
                title="Lompat ke detik awal segmen ini"
              >
                <RotateCcw className="w-3 h-3" />
                <span>{startHms}</span>
              </button>
            </div>

            {/* Bottom-left current playback timestamp badge */}
            <div className="absolute bottom-3 left-3 bg-black/70 backdrop-blur-sm border border-slate-800/60 rounded-md px-2 py-0.5 text-[10px] font-mono text-slate-300 z-10">
              ⏱️ {formatSecondsToHms(videoCurrentTime, true)} / {endHms}
            </div>
          </div>
        ) : (
          /* Sleek Mockup Canvas if no video is uploaded yet */
          <div className="w-full h-full bg-gradient-to-br from-slate-900 via-slate-950 to-slate-900 flex flex-col items-center justify-center p-6 text-center relative overflow-hidden">
            <div className="absolute inset-0 opacity-15 pointer-events-none">
              <div className="h-8 bg-slate-800 border-b border-slate-700 flex items-center px-4 gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-rose-500" />
                <div className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
              </div>
              <div className="p-4 grid grid-cols-4 gap-3">
                <div className="h-16 bg-slate-800/60 rounded-lg" />
                <div className="h-16 bg-slate-800/60 rounded-lg" />
                <div className="h-16 bg-slate-800/60 rounded-lg" />
                <div className="h-16 bg-slate-800/60 rounded-lg" />
              </div>
            </div>

            <div className="space-y-1.5 z-10 opacity-75 max-w-sm">
              <Video className="w-8 h-8 text-slate-400 mx-auto" />
              <p className="text-xs text-slate-200 font-semibold">Kanvas Video Acuan 16:9</p>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Unggah video acuan di bagian <strong>"Referensi Video Acuan"</strong> di bawah untuk
                melihat frame aktual, atau atur langsung gaya subtitle Anda di kanvas ini.
              </p>
            </div>
          </div>
        )}

        {/* Real-Time Subtitle Overlay Placed Bottom Center */}
        <div
          className="absolute inset-x-0 flex justify-center pointer-events-none z-10"
          style={{ bottom: `${Math.max(8, Math.round(ypad * 1.25))}px` }}
        >
          <div style={getSubtitleCss()} className="text-center transition-all duration-75">
            {previewText}
          </div>
        </div>

        {/* Safe Margin Guide indicator line */}
        <div
          style={{ bottom: `${Math.max(8, Math.round(ypad * 1.25))}px` }}
          className="absolute inset-x-6 border-b border-dashed border-blue-500/30 pointer-events-none flex justify-between text-[9px] text-blue-400 font-mono px-1 pb-0.5 z-10"
        >
          <span>Safe Margin</span>
          <span>{ypad}px</span>
        </div>
      </div>

      {/* Interactive Controls Bar */}
      <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4 space-y-3.5 text-xs">
        {/* Row 1: Segment picker & custom text toggle */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
          <div>
            <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">
              Pilih Segmen Adegan untuk Dipratinjau:
            </label>
            <select
              value={selectedSegmentIdx}
              onChange={(e) => {
                const idx = parseInt(e.target.value, 10);
                setSelectedSegmentIdx(idx);
                setUseCustomText(false);
              }}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:border-blue-500 outline-none"
            >
              {nonEmpties.map((s, i) => (
                <option key={i} value={i}>
                  Segmen #{i + 1} ({s.time_range}): {s.text.slice(0, 45)}...
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                Gunakan Teks Kustom:
              </label>
              <label className="text-[11px] text-blue-400 cursor-pointer flex items-center gap-1 font-medium">
                <input
                  type="checkbox"
                  checked={useCustomText}
                  onChange={(e) => setUseCustomText(e.target.checked)}
                  className="rounded bg-slate-950 border-slate-700 text-blue-600 w-3.5 h-3.5 accent-blue-600"
                />
                Uji Teks Sendiri
              </label>
            </div>
            {useCustomText ? (
              <input
                type="text"
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                placeholder="Ketik teks kustom untuk menguji subtitle..."
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 focus:border-blue-500 outline-none"
              />
            ) : (
              <div
                className="text-[11px] text-slate-300 bg-slate-950 px-2.5 py-1.5 rounded-lg border border-slate-800/80 truncate font-sans"
                title={previewText}
              >
                {previewText}
              </div>
            )}
          </div>
        </div>

        {/* Row 2: Visual Style Buttons */}
        <div className="space-y-1.5">
          <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block">
            Gaya Visual Subtitle:
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <button
              onClick={() => onChangeStyle("outline")}
              className={`px-3 py-2 rounded-xl text-left font-medium transition border flex items-center gap-2.5 ${
                subtitleStyle === "outline"
                  ? "bg-blue-600/20 border-blue-500 text-blue-300 shadow-sm ring-1 ring-blue-500/40"
                  : "bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700"
              }`}
            >
              <span
                className="text-white font-bold text-sm"
                style={{ textShadow: "0 0 2px #000, 0 0 4px #000" }}
              >
                Aa
              </span>
              <div>
                <span className="block text-xs font-semibold text-white">✨ Outline Hitam</span>
                <span className="text-[10px] text-slate-400">YouTube / Netflix Style</span>
              </div>
            </button>

            <button
              onClick={() => onChangeStyle("shaded_box")}
              className={`px-3 py-2 rounded-xl text-left font-medium transition border flex items-center gap-2.5 ${
                subtitleStyle === "shaded_box"
                  ? "bg-blue-600/20 border-blue-500 text-blue-300 shadow-sm ring-1 ring-blue-500/40"
                  : "bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700"
              }`}
            >
              <span className="bg-slate-800 text-white font-bold text-xs px-1.5 py-0.5 rounded border border-slate-700">
                Aa
              </span>
              <div>
                <span className="block text-xs font-semibold text-white">⬛ Shaded Box</span>
                <span className="text-[10px] text-slate-400">Kotak Gelap Transparan</span>
              </div>
            </button>

            <button
              onClick={() => onChangeStyle("yellow_outline")}
              className={`px-3 py-2 rounded-xl text-left font-medium transition border flex items-center gap-2.5 ${
                subtitleStyle === "yellow_outline"
                  ? "bg-blue-600/20 border-blue-500 text-blue-300 shadow-sm ring-1 ring-blue-500/40"
                  : "bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700"
              }`}
            >
              <span
                className="text-yellow-300 font-bold text-sm"
                style={{ textShadow: "0 0 2px #000, 0 0 4px #000" }}
              >
                Aa
              </span>
              <div>
                <span className="block text-xs font-semibold text-white">🟡 Yellow Outline</span>
                <span className="text-[10px] text-slate-400">Teks Kuning Kontras</span>
              </div>
            </button>
          </div>
        </div>

        {/* Row 3: Font Size & Bottom Margin Sliders */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
          <div className="space-y-1.5">
            <div className="flex justify-between items-center text-xs">
              <span className="text-slate-400 flex items-center gap-1.5">
                <Type className="w-3.5 h-3.5 text-blue-400" />
                Ukuran Font Subtitle:
              </span>
              <span className="font-mono text-blue-400 font-bold bg-blue-950/60 border border-blue-900/50 px-2 py-0.5 rounded">
                {fontSize} pt
              </span>
            </div>
            <input
              type="range"
              min={10}
              max={24}
              step={1}
              value={fontSize}
              onChange={(e) => onChangeFontSize(parseInt(e.target.value, 10))}
              className="w-full accent-blue-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
            />
            <p className="text-[10px] text-slate-500">
              Disarankan 12-14pt agar teks ringkas dan tidak menutupi visual penting video.
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between items-center text-xs">
              <span className="text-slate-400 flex items-center gap-1.5">
                <MoveVertical className="w-3.5 h-3.5 text-emerald-400" />
                Jarak Aman dari Bawah (ypad):
              </span>
              <span className="font-mono text-emerald-400 font-bold bg-emerald-950/60 border border-emerald-900/50 px-2 py-0.5 rounded">
                {ypad} px
              </span>
            </div>
            <input
              type="range"
              min={6}
              max={35}
              step={1}
              value={ypad}
              onChange={(e) => onChangeYpad(parseInt(e.target.value, 10))}
              className="w-full accent-emerald-500 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
            />
            <p className="text-[10px] text-slate-500">
              Disarankan 10-14px untuk menempatkan subtitle pas di batas bawah frame video.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
