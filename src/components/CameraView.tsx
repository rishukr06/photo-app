import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  RefreshCw, Zap, ZapOff, Clock, Settings2, Aperture, Camera,
  Video, ChevronDown, CheckCircle, AlertCircle, Loader, Grid2x2, ArrowLeft,
} from "lucide-react";
import { uploadS3FileWithProgress } from "../utils/s3";
import type { S3Credentials } from "../utils/s3";
import { batchUpsertMetaEntries } from "../utils/metaIndex";
import type { MetaEntry } from "../utils/metaIndex";
import { reverseGeocode } from "../utils/geocode";

type CameraMode = "photo" | "video" | "portrait";
type Resolution = "hd" | "fhd" | "4k";

const RES: Record<Resolution, { label: string; w: number; h: number }> = {
  hd:  { label: "HD",  w: 1280, h: 720  },
  fhd: { label: "FHD", w: 1920, h: 1080 },
  "4k": { label: "4K",  w: 3840, h: 2160 },
};

interface Props {
  creds: S3Credentials;
  onUploadComplete: () => void;
  onBack: () => void;
}

export function CameraView({ creds, onUploadComplete, onBack }: Props) {
  const [mode, setMode]               = useState<CameraMode>("photo");
  const [facing, setFacing]           = useState<"environment" | "user">("environment");
  const [flash, setFlash]             = useState(false);
  const [res, setRes]                 = useState<Resolution>("fhd");
  const [timerSecs, setTimerSecs]     = useState<0 | 3 | 10>(0);
  const [showGrid, setShowGrid]       = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [countdown, setCountdown]     = useState<number | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recSecs, setRecSecs]         = useState(0);
  const [thumbUrl, setThumbUrl]       = useState<string | null>(null);
  const [upState, setUpState]         = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [upPct, setUpPct]             = useState(0);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [gps, setGps]                 = useState<{ lat: number; lng: number } | null>(null);

  const videoRef       = useRef<HTMLVideoElement>(null);
  const streamRef      = useRef<MediaStream | null>(null);
  const recorderRef    = useRef<MediaRecorder | null>(null);
  const chunksRef      = useRef<Blob[]>([]);
  const recTimerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef   = useRef<ReturnType<typeof setInterval> | null>(null);

  // Get GPS once on mount
  useEffect(() => {
    navigator.geolocation?.getCurrentPosition(
      p => setGps({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => {}
    );
  }, []);

  // Start/restart camera stream
  const startStream = useCallback(async () => {
    // Fully tear down existing stream before starting a new one
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setStreamError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // ideal instead of exact — lets browser pick the closest camera on any device
        video: { facingMode: { ideal: facing }, width: { ideal: RES[res].w }, height: { ideal: RES[res].h } },
        audio: mode === "video",
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }

      if (flash && facing === "environment") {
        const track = stream.getVideoTracks()[0];
        await (track as any).applyConstraints({ advanced: [{ torch: true }] }).catch(() => {});
      }
    } catch (err: any) {
      setStreamError(
        err.name === "NotAllowedError"
          ? "Camera permission denied. Enable camera access in your browser settings."
          : "Camera unavailable — it may be in use by another app."
      );
    }
  }, [facing, res, mode, flash]);

  useEffect(() => {
    startStream();
    return () => { streamRef.current?.getTracks().forEach(t => t.stop()); };
  }, [startStream]);

  // Cleanup thumb URL on unmount
  useEffect(() => () => { if (thumbUrl) URL.revokeObjectURL(thumbUrl); }, [thumbUrl]);

  // ── Upload ────────────────────────────────────────────────────────────────

  const upload = useCallback(async (blob: Blob, filename: string, mime: string) => {
    setUpState("uploading");
    setUpPct(0);
    try {
      const file    = new File([blob], filename, { type: mime });
      const destKey = `${creds.prefix ?? ""}${filename}`;
      const now     = new Date().toISOString();
      const meta: Record<string, string> = {
        "original-name": filename,
        "file-date": now,
        "date-taken": now,
        "camera-mode": mode,
        "camera-facing": facing,
      };
      if (gps) { meta["gps-lat"] = String(gps.lat); meta["gps-lng"] = String(gps.lng); }

      await uploadS3FileWithProgress(creds, file, destKey, pct => setUpPct(pct), meta);

      const entry: MetaEntry = { dateTaken: now };
      if (gps) {
        entry.gpsLat = String(gps.lat);
        entry.gpsLng = String(gps.lng);
        const geo = await reverseGeocode(String(gps.lat), String(gps.lng));
        if (geo.city)        entry.city        = geo.city;
        if (geo.country)     entry.country     = geo.country;
        if (geo.countryCode) entry.countryCode = geo.countryCode;
        if (geo.area)        entry.area        = geo.area;
        if (geo.street)      entry.street      = geo.street;
      }
      await batchUpsertMetaEntries(creds, { [destKey]: entry });

      setUpState("done");
      onUploadComplete();
      setTimeout(() => setUpState("idle"), 2500);
    } catch {
      setUpState("error");
      setTimeout(() => setUpState("idle"), 3000);
    }
  }, [creds, mode, facing, gps, onUploadComplete]);

  // ── Portrait bokeh effect on canvas ───────────────────────────────────────

  const applyPortrait = useCallback((video: HTMLVideoElement): HTMLCanvasElement => {
    const w = video.videoWidth, h = video.videoHeight;

    // Blurred background
    const bg = document.createElement("canvas");
    bg.width = w; bg.height = h;
    const bgCtx = bg.getContext("2d")!;
    bgCtx.filter = "blur(18px)";
    bgCtx.drawImage(video, -20, -20, w + 40, h + 40);
    bgCtx.filter = "none";

    // Sharp subject with radial alpha mask
    const fg = document.createElement("canvas");
    fg.width = w; fg.height = h;
    const fgCtx = fg.getContext("2d")!;
    fgCtx.drawImage(video, 0, 0, w, h);
    const grad = fgCtx.createRadialGradient(w / 2, h * 0.42, h * 0.18, w / 2, h * 0.42, h * 0.52);
    grad.addColorStop(0, "rgba(0,0,0,1)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    fgCtx.globalCompositeOperation = "destination-in";
    fgCtx.fillStyle = grad;
    fgCtx.fillRect(0, 0, w, h);

    // Composite
    const out = document.createElement("canvas");
    out.width = w; out.height = h;
    const ctx = out.getContext("2d")!;
    ctx.drawImage(bg, 0, 0);
    ctx.drawImage(fg, 0, 0);
    return out;
  }, []);

  // ── Photo capture ─────────────────────────────────────────────────────────

  const doCapture = useCallback(() => {
    const video = videoRef.current;
    if (!video || !streamRef.current) return;

    const canvas = mode === "portrait" ? applyPortrait(video) : (() => {
      const c = document.createElement("canvas");
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext("2d")!.drawImage(video, 0, 0);
      return c;
    })();

    canvas.toBlob(blob => {
      if (!blob) return;
      const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
      const name = `IMG_${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jpg`;
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
      setThumbUrl(URL.createObjectURL(blob));
      upload(blob, name, "image/jpeg");
    }, "image/jpeg", 0.95);
  }, [mode, applyPortrait, upload, thumbUrl]);

  const triggerCapture = useCallback(() => {
    if (countdown !== null) return;
    if (timerSecs === 0) { doCapture(); return; }
    let rem = timerSecs;
    setCountdown(rem);
    countdownRef.current = setInterval(() => {
      rem--;
      if (rem <= 0) { clearInterval(countdownRef.current!); setCountdown(null); doCapture(); }
      else setCountdown(rem);
    }, 1000);
  }, [countdown, timerSecs, doCapture]);

  // ── Video recording ───────────────────────────────────────────────────────

  const startRec = useCallback(() => {
    if (!streamRef.current) return;
    chunksRef.current = [];
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
      ? "video/webm;codecs=vp8,opus" : "video/mp4";
    const rec = new MediaRecorder(streamRef.current, { mimeType: mime });
    rec.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mime });
      const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
      const ext = mime.includes("mp4") ? "mp4" : "webm";
      const name = `VID_${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
      setThumbUrl(URL.createObjectURL(blob));
      upload(blob, name, mime);
    };
    rec.start(1000);
    recorderRef.current = rec;
    setIsRecording(true);
    setRecSecs(0);
    recTimerRef.current = setInterval(() => setRecSecs(s => s + 1), 1000);
  }, [upload, thumbUrl]);

  const stopRec = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    clearInterval(recTimerRef.current!);
    setIsRecording(false);
    setRecSecs(0);
  }, []);

  const handleCapture = useCallback(() => {
    if (mode === "video") { isRecording ? stopRec() : startRec(); }
    else triggerCapture();
  }, [mode, isRecording, stopRec, startRec, triggerCapture]);

  const fmtTime = (s: number) => `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={c.root}>

      {/* ── Top bar ─────────────────────────────────────────────── */}
      <div style={c.topBar}>
        <button style={c.iconBtn} onClick={onBack} title="Back to Gallery">
          <ArrowLeft size={20} color="rgba(255,255,255,0.8)" />
        </button>
        <button style={c.iconBtn} onClick={() => setFlash(f => !f)} title="Flash">
          {flash ? <Zap size={20} color="#FFD60A" /> : <ZapOff size={20} color="rgba(255,255,255,0.6)" />}
        </button>

        {isRecording && (
          <div style={c.recBadge}>
            <span style={c.recDot} />
            {fmtTime(recSecs)}
          </div>
        )}
        {countdown !== null && (
          <div style={c.countdownNum}>{countdown}</div>
        )}

        <div style={{ display: "flex", gap: "4px", marginLeft: "auto" }}>
          <button
            style={{ ...c.iconBtn, background: showGrid ? "rgba(255,255,255,0.18)" : "transparent" }}
            onClick={() => setShowGrid(g => !g)}
            title="Grid"
          >
            <Grid2x2 size={18} color="rgba(255,255,255,0.8)" />
          </button>
          <button
            style={{ ...c.iconBtn, background: showSettings ? "rgba(255,255,255,0.18)" : "transparent" }}
            onClick={() => setShowSettings(s => !s)}
            title="Settings"
          >
            <Settings2 size={18} color="rgba(255,255,255,0.8)" />
          </button>
          <button style={c.iconBtn} onClick={() => setFacing(f => f === "environment" ? "user" : "environment")} title="Flip">
            <RefreshCw size={18} color="rgba(255,255,255,0.8)" />
          </button>
        </div>
      </div>

      {/* ── Viewfinder ──────────────────────────────────────────── */}
      <div style={c.viewfinder}>
        {streamError ? (
          <div style={c.errorBox}>
            <AlertCircle size={36} color="rgba(255,255,255,0.5)" />
            <p style={{ color: "rgba(255,255,255,0.7)", textAlign: "center", maxWidth: "280px", fontSize: "0.88rem", lineHeight: 1.5 }}>
              {streamError}
            </p>
          </div>
        ) : (
          <video ref={videoRef} autoPlay playsInline muted style={c.video} />
        )}

        {/* Grid overlay */}
        {showGrid && !streamError && (
          <div style={c.gridOverlay}>
            {[1, 2].map(i => (
              <React.Fragment key={i}>
                <div style={{ ...c.gridLine, left: `${i * 33.33}%`, top: 0, width: "1px", height: "100%" }} />
                <div style={{ ...c.gridLine, top: `${i * 33.33}%`, left: 0, height: "1px", width: "100%" }} />
              </React.Fragment>
            ))}
          </div>
        )}

        {/* Portrait mode — blurred side bars + frame */}
        {mode === "portrait" && !streamError && (
          <>
            <div style={{ ...c.portraitSide, left: 0 }} />
            <div style={{ ...c.portraitSide, right: 0 }} />
            <div style={c.portraitFrame} />
          </>
        )}

        {/* Upload status overlay */}
        {upState !== "idle" && (
          <div style={c.uploadOverlay}>
            {upState === "uploading" && (
              <>
                <Loader size={22} color="#fff" style={{ animation: "spin 1s linear infinite" }} />
                <span style={c.uploadLabel}>Uploading {upPct}%</span>
                <div style={c.progressTrack}><div style={{ ...c.progressFill, width: `${upPct}%` }} /></div>
              </>
            )}
            {upState === "done" && <><CheckCircle size={22} color="#34D399" /><span style={c.uploadLabel}>Saved to S3</span></>}
            {upState === "error" && <><AlertCircle size={22} color="#F87171" /><span style={c.uploadLabel}>Upload failed</span></>}
          </div>
        )}
      </div>

      {/* ── Mode selector ──────────────────────────────────────── */}
      <div style={c.modeBar}>
        {([
          { key: "photo",    label: "Photo",    icon: <Camera   size={14} /> },
          { key: "video",    label: "Video",    icon: <Video    size={14} /> },
          { key: "portrait", label: "Portrait", icon: <Aperture size={14} /> },
        ] as const).map(m => (
          <button
            key={m.key}
            style={{
              ...c.modeBtn,
              color: mode === m.key ? "#FFD60A" : "rgba(255,255,255,0.55)",
              borderBottom: mode === m.key ? "2px solid #FFD60A" : "2px solid transparent",
            }}
            onClick={() => setMode(m.key)}
          >
            {m.icon}
            <span style={{ fontSize: "0.72rem", fontWeight: 600, letterSpacing: "0.04em" }}>{m.label}</span>
          </button>
        ))}
      </div>

      {/* ── Capture bar ────────────────────────────────────────── */}
      <div style={c.captureBar}>
        {/* Last capture thumbnail */}
        <div style={c.thumbWrap}>
          {thumbUrl ? (
            <img src={thumbUrl} alt="last capture" style={c.thumb} />
          ) : (
            <div style={c.thumbEmpty} />
          )}
        </div>

        {/* Capture button */}
        <button
          style={{
            ...c.captureBtn,
            ...(mode === "video" && isRecording ? c.captureBtnStop : {}),
          }}
          onClick={handleCapture}
          disabled={!!streamError || countdown !== null}
        >
          {mode === "video" && isRecording ? (
            <div style={c.stopIcon} />
          ) : mode === "portrait" ? (
            <Aperture size={28} color={streamError || countdown !== null ? "rgba(0,0,0,0.3)" : "#000"} />
          ) : (
            <Camera size={28} color={streamError || countdown !== null ? "rgba(0,0,0,0.3)" : "#000"} />
          )}
        </button>

        {/* Right: GPS indicator */}
        <div style={{ width: 60, display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
          {gps && (
            <div style={c.gpsDot} title={`GPS: ${gps.lat.toFixed(4)}, ${gps.lng.toFixed(4)}`}>
              <span style={{ fontSize: "0.6rem", color: "#34D399" }}>GPS</span>
            </div>
          )}
          {timerSecs > 0 && (
            <div style={c.timerBadge}>
              <Clock size={10} />{timerSecs}s
            </div>
          )}
        </div>
      </div>

      {/* ── Settings panel ─────────────────────────────────────── */}
      {showSettings && (
        <div style={c.settingsPanel}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <span style={{ color: "#fff", fontWeight: 700, fontSize: "0.9rem" }}>Camera Settings</span>
            <button style={c.iconBtn} onClick={() => setShowSettings(false)}><ChevronDown size={18} color="#fff" /></button>
          </div>

          {/* Resolution */}
          <div style={c.settingRow}>
            <span style={c.settingLabel}>Resolution</span>
            <div style={c.settingOptions}>
              {(["hd", "fhd", "4k"] as Resolution[]).map(r => (
                <button key={r} style={{ ...c.optBtn, ...(res === r ? c.optBtnActive : {}) }} onClick={() => setRes(r)}>
                  {RES[r].label}
                </button>
              ))}
            </div>
          </div>

          {/* Timer */}
          <div style={c.settingRow}>
            <span style={c.settingLabel}>Timer</span>
            <div style={c.settingOptions}>
              {([0, 3, 10] as const).map(t => (
                <button key={t} style={{ ...c.optBtn, ...(timerSecs === t ? c.optBtnActive : {}) }} onClick={() => setTimerSecs(t)}>
                  {t === 0 ? "Off" : `${t}s`}
                </button>
              ))}
            </div>
          </div>

          {/* Grid */}
          <div style={c.settingRow}>
            <span style={c.settingLabel}>Grid</span>
            <div style={c.settingOptions}>
              {([false, true] as const).map(v => (
                <button key={String(v)} style={{ ...c.optBtn, ...(showGrid === v ? c.optBtnActive : {}) }} onClick={() => setShowGrid(v)}>
                  {v ? "On" : "Off"}
                </button>
              ))}
            </div>
          </div>

          {/* Flash mode */}
          <div style={c.settingRow}>
            <span style={c.settingLabel}>Flash / Torch</span>
            <div style={c.settingOptions}>
              {([false, true] as const).map(v => (
                <button key={String(v)} style={{ ...c.optBtn, ...(flash === v ? c.optBtnActive : {}) }} onClick={() => setFlash(v)}>
                  {v ? "On" : "Off"}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const c: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    background: "#000",
    borderRadius: "var(--radius-lg)",
    overflow: "hidden",
    width: "100%",
    minHeight: "calc(100dvh - 200px)",
    position: "relative",
    userSelect: "none",
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "12px 14px",
    background: "rgba(0,0,0,0.7)",
    zIndex: 10,
  },
  iconBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    padding: "8px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "background 0.15s",
  },
  recBadge: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    background: "rgba(239,68,68,0.2)",
    border: "1px solid rgba(239,68,68,0.5)",
    borderRadius: "20px",
    padding: "4px 12px",
    color: "#fff",
    fontSize: "0.8rem",
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
    margin: "0 auto",
  },
  recDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: "#EF4444",
    animation: "pulse 1s ease-in-out infinite",
    flexShrink: 0,
  },
  countdownNum: {
    fontSize: "3rem",
    fontWeight: 800,
    color: "#FFD60A",
    margin: "0 auto",
    fontVariantNumeric: "tabular-nums",
    textShadow: "0 2px 20px rgba(255,214,10,0.4)",
  },
  viewfinder: {
    flex: 1,
    position: "relative",
    background: "#111",
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "300px",
  },
  video: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  errorBox: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "16px",
    padding: "32px",
  },
  gridOverlay: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    zIndex: 2,
  },
  gridLine: {
    position: "absolute",
    background: "rgba(255,255,255,0.2)",
  },
  portraitSide: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: "18%",
    background: "rgba(0,0,0,0.55)",
    backdropFilter: "blur(12px)",
    zIndex: 2,
  },
  portraitFrame: {
    position: "absolute",
    inset: "0 18%",
    border: "1px solid rgba(255,255,255,0.25)",
    pointerEvents: "none",
    zIndex: 3,
    borderRadius: "2px",
  },
  uploadOverlay: {
    position: "absolute",
    bottom: "12px",
    left: "50%",
    transform: "translateX(-50%)",
    background: "rgba(0,0,0,0.75)",
    backdropFilter: "blur(10px)",
    borderRadius: "12px",
    padding: "10px 20px",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    zIndex: 10,
    minWidth: "180px",
    border: "1px solid rgba(255,255,255,0.1)",
  },
  uploadLabel: {
    color: "#fff",
    fontSize: "0.8rem",
    fontWeight: 600,
  },
  progressTrack: {
    flex: 1,
    height: "3px",
    background: "rgba(255,255,255,0.2)",
    borderRadius: "2px",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "var(--color-primary)",
    borderRadius: "2px",
    transition: "width 0.2s ease",
  },
  modeBar: {
    display: "flex",
    justifyContent: "center",
    gap: "0",
    background: "rgba(0,0,0,0.85)",
    padding: "8px 0 6px",
  },
  modeBtn: {
    background: "none",
    border: "none",
    padding: "8px 28px 6px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "4px",
    cursor: "pointer",
    transition: "color 0.15s",
  },
  captureBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 28px 20px",
    background: "#000",
  },
  thumbWrap: {
    width: "56px",
    height: "56px",
    borderRadius: "10px",
    overflow: "hidden",
    border: "2px solid rgba(255,255,255,0.25)",
    flexShrink: 0,
  },
  thumb: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  thumbEmpty: {
    width: "100%",
    height: "100%",
    background: "rgba(255,255,255,0.06)",
  },
  captureBtn: {
    width: "76px",
    height: "76px",
    borderRadius: "50%",
    background: "#fff",
    border: "4px solid rgba(255,255,255,0.3)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "transform 0.1s, background 0.2s",
    outline: "none",
    boxShadow: "0 0 0 2px rgba(255,255,255,0.15)",
    flexShrink: 0,
  },
  captureBtnStop: {
    background: "#EF4444",
    border: "4px solid rgba(239,68,68,0.4)",
  },
  stopIcon: {
    width: "22px",
    height: "22px",
    background: "#fff",
    borderRadius: "4px",
  },
  gpsDot: {
    background: "rgba(52,211,153,0.12)",
    border: "1px solid rgba(52,211,153,0.35)",
    borderRadius: "6px",
    padding: "3px 7px",
    display: "flex",
    alignItems: "center",
  },
  timerBadge: {
    display: "flex",
    alignItems: "center",
    gap: "3px",
    color: "#FFD60A",
    fontSize: "0.65rem",
    fontWeight: 700,
  },
  settingsPanel: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    background: "rgba(10,10,12,0.96)",
    backdropFilter: "blur(20px)",
    borderTop: "1px solid rgba(255,255,255,0.1)",
    padding: "20px 20px 28px",
    zIndex: 20,
    borderRadius: "20px 20px 0 0",
  },
  settingRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "14px",
    gap: "12px",
  },
  settingLabel: {
    color: "rgba(255,255,255,0.6)",
    fontSize: "0.8rem",
    fontWeight: 500,
    flexShrink: 0,
  },
  settingOptions: {
    display: "flex",
    gap: "6px",
  },
  optBtn: {
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.1)",
    color: "rgba(255,255,255,0.55)",
    borderRadius: "8px",
    padding: "5px 14px",
    fontSize: "0.75rem",
    fontWeight: 600,
    cursor: "pointer",
    transition: "all 0.12s",
  },
  optBtnActive: {
    background: "rgba(255,214,10,0.15)",
    border: "1px solid rgba(255,214,10,0.5)",
    color: "#FFD60A",
  },
};
