import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, Crosshair, Move, Pause, Play, RotateCcw, Ruler, SkipBack, TriangleAlert, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  detectRep,
  median,
  metersPerPixel,
  scaleFromLine,
  smoothScale,
  trackMarker,
  velocityLossPercent,
  velocityZone,
  type RgbColor,
  type VbtRep,
  type VbtSample,
} from '@/lib/vbt';


const CANVAS_W = 320;
const CANVAS_H = 240;

interface Props {
  onRepsChange?: (reps: VbtRep[]) => void;
}

export function VBTCamera({ onRepsChange }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>();
  const streamRef = useRef<MediaStream | null>(null);
  const samplesRef = useRef<VbtSample[]>([]);
  const scaleRef = useRef<number | null>(null);
  const lastRepAtRef = useRef(0);
  const startTimeRef = useRef(0);
  const alertedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const sizeBufRef = useRef<number[]>([]);
  const calibStartRef = useRef<{ x: number; y: number } | null>(null);

  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<RgbColor | null>(null);
  const [tolerance, setTolerance] = useState(0.18);
  const [refDiameter, setRefDiameter] = useState(45); // cm (plate olympic)
  const [autoScale, setAutoScale] = useState(true);
  const [manualScale, setManualScale] = useState(0.0025); // m/px
  const [scale, setScale] = useState<number | null>(null);
  const [locked, setLocked] = useState(false);
  const [reps, setReps] = useState<VbtRep[]>([]);
  const [live, setLive] = useState<{ v: number; found: boolean }>({ v: 0, found: false });
  const [cutoff, setCutoff] = useState(20);
  const [alertOn, setAlertOn] = useState(true);
  const [mode, setMode] = useState<'camera' | 'video'>('camera');
  const [videoName, setVideoName] = useState<string | null>(null);
  const [calibMode, setCalibMode] = useState(false);
  const [calibLine, setCalibLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [blobPx, setBlobPx] = useState(0);
  const [roiOn, setRoiOn] = useState(false);
  const [roiSize, setRoiSize] = useState(160); // px pada canvas
  const [roiCenter, setRoiCenter] = useState({ x: CANVAS_W / 2, y: CANVAS_H / 2 });
  const [roiFollow, setRoiFollow] = useState(true);
  const [roiEdit, setRoiEdit] = useState(false);
  const roiDragRef = useRef<'move' | 'resize' | null>(null);
  const [vTime, setVTime] = useState(0);
  const [vDur, setVDur] = useState(0);
  const [vPaused, setVPaused] = useState(false);




  const bestMpv = reps.length ? Math.max(...reps.map((r) => r.mpv)) : 0;
  const lastRep = reps[reps.length - 1];
  const vLoss = lastRep ? velocityLossPercent(bestMpv, lastRep.mpv) : 0;
  const overCutoff = !!lastRep && vLoss >= cutoff;

  const beep = useCallback(() => {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 880;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
      setTimeout(() => ctx.close(), 600);
    } catch {
      /* audio not available */
    }
  }, []);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    videoRef.current?.pause();
    setActive(false);
  }, []);

  useEffect(
    () => () => {
      stop();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    },
    [stop],
  );

  useEffect(() => {
    onRepsChange?.(reps);
  }, [reps, onRepsChange]);

  // Real-time velocity loss notification
  useEffect(() => {
    if (!alertOn || !lastRep) return;
    if (overCutoff && !alertedRef.current) {
      alertedRef.current = true;
      beep();
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      toast.error(`Velocity loss ${vLoss.toFixed(1)}% ≥ cutoff ${cutoff}%`, {
        description: 'Hentikan set atau turunkan beban — kualitas kecepatan sudah menurun.',
        duration: 8000,
      });
    }
    if (!overCutoff) alertedRef.current = false;
  }, [overCutoff, vLoss, cutoff, alertOn, lastRep, beep]);

  const loop = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!video || !canvas || !overlay || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(loop);
      return;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const octx = overlay.getContext('2d');
    if (!ctx || !octx) return;

    ctx.drawImage(video, 0, 0, CANVAS_W, CANVAS_H);
    octx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    const roi = roiOn
      ? {
          x: roiCenter.x - roiSize / 2,
          y: roiCenter.y - roiSize / 2,
          w: roiSize,
          h: roiSize,
        }
      : null;

    if (roi) {
      octx.strokeStyle = calibMode ? '#f59e0b' : roiEdit ? '#38bdf8' : '#a3e635';
      octx.lineWidth = 2;
      octx.setLineDash([6, 4]);
      octx.strokeRect(roi.x, roi.y, roi.w, roi.h);
      octx.setLineDash([]);
      if (roiEdit) {
        // gagang untuk memperbesar / memperkecil area
        octx.fillStyle = '#38bdf8';
        octx.fillRect(roi.x + roi.w - 8, roi.y + roi.h - 8, 12, 12);
        octx.fillRect(roi.x - 4, roi.y - 4, 12, 12);
      }
    }


    if (target) {
      const frame = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
      const blob = trackMarker(frame.data, CANVAS_W, CANVAS_H, target, tolerance, roi);


      if (blob) {
        // --- dynamic scale calibration from reference object size ---
        // Ukuran blob difilter dengan median bergerak sehingga tetap stabil
        // saat plate miring, blur, atau jarak kamera berubah di tengah video.
        let mpp = scaleRef.current;
        const size = Math.max(blob.width, blob.height);
        setBlobPx(Math.round(size));
        if (autoScale && !locked) {
          const sb = sizeBufRef.current;
          sb.push(size);
          if (sb.length > 24) sb.shift();
          const stable = median(sb);
          const est = metersPerPixel(stable, refDiameter);
          if (est) {
            // adaptasi cepat saat awal, halus setelah stabil
            const alpha = sb.length < 10 ? 0.4 : 0.12;
            mpp = smoothScale(scaleRef.current, est, alpha);
            scaleRef.current = mpp;
            setScale(mpp);
          }
        } else if (!autoScale) {
          mpp = manualScale;
          scaleRef.current = mpp;
          setScale(mpp);
        }

        if (mpp) {
          const t =
            mode === 'video' ? video.currentTime : (performance.now() - startTimeRef.current) / 1000;
          // canvas y grows downward -> invert so upward is positive
          const yMeters = (CANVAS_H - blob.y) * mpp;
          const buf = samplesRef.current;
          buf.push({ t, y: yMeters });
          if (buf.length > 180) buf.shift();

          const prev = buf[buf.length - 2];
          const v = prev ? (yMeters - prev.y) / Math.max(t - prev.t, 1e-3) : 0;
          setLive({ v, found: true });

          const rep = detectRep(buf);
          if (rep && t - lastRepAtRef.current > 0.8) {
            lastRepAtRef.current = t;
            setReps((prevReps) => [
              ...prevReps,
              { ...rep, index: prevReps.length + 1, timestamp: Date.now() },
            ]);
            samplesRef.current = buf.slice(-10);
          }
        }

        // overlay marker
        octx.strokeStyle = '#22d3ee';
        octx.lineWidth = 2;
        octx.beginPath();
        octx.arc(blob.x, blob.y, Math.max(8, size / 2), 0, Math.PI * 2);
        octx.stroke();
        octx.beginPath();
        octx.moveTo(0, blob.y);
        octx.lineTo(CANVAS_W, blob.y);
        octx.strokeStyle = 'rgba(34,211,238,0.4)';
        octx.stroke();

        if (roiOn && roiFollow) {
          setRoiCenter((c) => {
            const nx = c.x + (blob.x - c.x) * 0.25;
            const ny = c.y + (blob.y - c.y) * 0.25;
            return Math.abs(nx - c.x) < 0.5 && Math.abs(ny - c.y) < 0.5 ? c : { x: nx, y: ny };
          });
        }
      } else {
        setLive({ v: 0, found: false });
      }
    }

    // garis kalibrasi manual (drag) selalu digambar di atas
    if (calibLine) {
      octx.strokeStyle = '#f59e0b';
      octx.lineWidth = 2;
      octx.beginPath();
      octx.moveTo(calibLine.x1, calibLine.y1);
      octx.lineTo(calibLine.x2, calibLine.y2);
      octx.stroke();
    }

    rafRef.current = requestAnimationFrame(loop);
  }, [
    target,
    tolerance,
    autoScale,
    locked,
    refDiameter,
    manualScale,
    mode,
    calibLine,
    calibMode,
    roiOn,
    roiSize,
    roiCenter,
    roiFollow,
    roiEdit,
  ]);



  useEffect(() => {
    if (!active) return;
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active, loop]);

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      setVideoName(null);
      setMode('camera');
      if (videoRef.current) {
        videoRef.current.removeAttribute('src');
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      startTimeRef.current = performance.now();
      samplesRef.current = [];
      setActive(true);
    } catch (e) {
      setError(
        'Kamera tidak dapat diakses. Pastikan izin kamera diberikan dan halaman dibuka lewat HTTPS.',
      );
      console.error(e);
    }
  };

  const handleFile = async (file: File) => {
    setError(null);
    // stop live camera if running
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    const video = videoRef.current;
    if (!video) return;
    try {
      video.srcObject = null;
      video.src = url;
      video.loop = false;
      video.muted = true;
      video.playbackRate = 1;
      await video.play();
      startTimeRef.current = performance.now();
      samplesRef.current = [];
      lastRepAtRef.current = 0;
      setTarget(null);
      setReps([]);
      setVideoName(file.name);
      setMode('video');
      setActive(true);
      toast.success('Video dimuat', {
        description: 'Ketuk marker/plate pada gambar untuk mengunci warna & kalibrasi skala.',
      });
    } catch (e) {
      console.error(e);
      setError('Video tidak dapat diputar. Gunakan format MP4/WebM.');
    }
  };

  const canvasPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.floor(((e.clientX - rect.left) / rect.width) * CANVAS_W),
      y: Math.floor(((e.clientY - rect.top) / rect.height) * CANVAS_H),
    };
  };

  const pickColor = (x: number, y: number) => {
    const ctx = canvasRef.current?.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const d = ctx.getImageData(x, y, 1, 1).data;
    setTarget({ r: d[0], g: d[1], b: d[2] });
    setRoiCenter({ x, y });

    samplesRef.current = [];
    sizeBufRef.current = [];
    scaleRef.current = null;
    toast.success('Marker terkunci', { description: 'Gerakkan barbel — pelacakan dimulai.' });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = canvasPoint(e);
    if (!p) return;
    if (calibMode) {
      calibStartRef.current = p;
      setCalibLine({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
      e.currentTarget.setPointerCapture(e.pointerId);
    } else if (roiOn && roiEdit) {
      const half = roiSize / 2;
      const nearCorner =
        Math.hypot(p.x - (roiCenter.x + half), p.y - (roiCenter.y + half)) < 22 ||
        Math.hypot(p.x - (roiCenter.x - half), p.y - (roiCenter.y - half)) < 22;
      roiDragRef.current = nearCorner ? 'resize' : 'move';
      if (!nearCorner) setRoiCenter(p);
      e.currentTarget.setPointerCapture(e.pointerId);
    } else {
      pickColor(p.x, p.y);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = canvasPoint(e);
    if (!p) return;
    if (roiDragRef.current) {
      if (roiDragRef.current === 'move') {
        setRoiCenter(p);
      } else {
        const d = Math.max(Math.abs(p.x - roiCenter.x), Math.abs(p.y - roiCenter.y)) * 2;
        setRoiSize(Math.round(Math.min(480, Math.max(30, d))));
      }
      return;
    }
    if (!calibMode || !calibStartRef.current) return;
    const s = calibStartRef.current;
    setCalibLine({ x1: s.x, y1: s.y, x2: p.x, y2: p.y });
  };



  const onPointerUp = () => {
    if (roiDragRef.current) {
      roiDragRef.current = null;
      return;
    }
    if (!calibMode || !calibStartRef.current || !calibLine) return;
    const len = Math.hypot(calibLine.x2 - calibLine.x1, calibLine.y2 - calibLine.y1);
    calibStartRef.current = null;
    const mpp = scaleFromLine(len, refDiameter);
    if (!mpp) {
      toast.error('Garis terlalu pendek', { description: 'Tarik garis melintasi diameter plate.' });
      return;
    }
    setAutoScale(false);
    setManualScale(Number(mpp.toFixed(6)));
    scaleRef.current = mpp;
    setScale(mpp);
    setCalibMode(false);
    toast.success(`Skala terkalibrasi: ${(mpp * 1000).toFixed(2)} mm/px`, {
      description: `${len.toFixed(0)} px = ${refDiameter} cm`,
    });
  };

  const recalibrate = () => {
    sizeBufRef.current = [];
    scaleRef.current = null;
    setScale(null);
    setAutoScale(true);
    setLocked(false);
    toast.info('Kalibrasi skala di-reset — plate akan diukur ulang otomatis.');
  };

  const reset = () => {
    setReps([]);
    samplesRef.current = [];
    lastRepAtRef.current = 0;
    alertedRef.current = false;
    startTimeRef.current = performance.now();
  };


  const zone = lastRep ? velocityZone(lastRep.mpv) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="overflow-hidden">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Camera className="h-4 w-4 text-primary" /> Kamera VBT
          </CardTitle>
          <CardDescription>
            Gunakan kamera langsung atau unggah video lama. Ketuk marker warna terang / plate di
            ujung barbel untuk mengunci pelacakan sekaligus kalibrasi skala otomatis.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative overflow-hidden rounded-lg border bg-black">
            <video
              ref={videoRef}
              playsInline
              muted
              className="hidden"
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                setVDur(Number.isFinite(v.duration) ? v.duration : 0);
                setVPaused(v.paused);
              }}
              onTimeUpdate={(e) => setVTime(e.currentTarget.currentTime)}
              onPlay={() => setVPaused(false)}
              onPause={() => setVPaused(true)}
              onEnded={() => {
                setVPaused(true);
                setActive(false);
              }}
            />
            <canvas
              ref={canvasRef}
              width={CANVAS_W}
              height={CANVAS_H}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              className={cn('w-full touch-none', calibMode ? 'cursor-cell' : 'cursor-crosshair')}

            />
            <canvas
              ref={overlayRef}
              width={CANVAS_W}
              height={CANVAS_H}
              className="pointer-events-none absolute inset-0 h-full w-full"
            />
            {!active && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-center text-sm text-muted-foreground">
                <Crosshair className="h-8 w-8 text-primary" />
                <p className="px-6">Kamera belum aktif — mulai kamera atau unggah video lama</p>
              </div>
            )}
            {active && calibMode && (
              <div className="absolute bottom-2 left-2 right-2 rounded-md bg-amber-500/90 px-3 py-2 text-xs text-black">
                Mode kalibrasi: tarik garis melintasi diameter plate ({refDiameter} cm).
              </div>
            )}
            {active && !target && !calibMode && (
              <div className="absolute bottom-2 left-2 right-2 rounded-md bg-background/85 px-3 py-2 text-xs">
                Ketuk area marker (stiker warna terang) pada gambar untuk mengunci warna.
              </div>
            )}
          </div>


          {error && (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {!active ? (
              <Button onClick={start} className="gap-2">
                <Camera className="h-4 w-4" /> Mulai Kamera
              </Button>
            ) : (
              <Button variant="destructive" onClick={stop} className="gap-2">
                <CameraOff className="h-4 w-4" /> {mode === 'video' ? 'Stop Video' : 'Stop Kamera'}
              </Button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = '';
              }}
            />
            <Button variant="outline" onClick={() => fileInputRef.current?.click()} className="gap-2">
              <Upload className="h-4 w-4" /> Unggah Video
            </Button>
            <Button variant="outline" onClick={reset} className="gap-2">
              <RotateCcw className="h-4 w-4" /> Reset Set
            </Button>
            {videoName && (
              <Badge variant="secondary" className="max-w-[200px] truncate">
                Video: {videoName}
              </Badge>
            )}
            {target && (
              <Badge variant="outline" className="gap-2">
                <span
                  className="h-3 w-3 rounded-full border"
                  style={{ backgroundColor: `rgb(${target.r},${target.g},${target.b})` }}
                />
                Marker aktif
              </Badge>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-xs">Toleransi warna marker: {(tolerance * 100).toFixed(0)}%</Label>
            <Slider
              value={[tolerance]}
              min={0.05}
              max={0.45}
              step={0.01}
              onValueChange={([v]) => setTolerance(v)}
            />
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {/* Live metrics */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Metrik Live</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Metric label="MPV terakhir" value={lastRep ? `${lastRep.mpv.toFixed(2)} m/s` : '—'} />
              <Metric label="Peak Velocity" value={lastRep ? `${lastRep.peak.toFixed(2)} m/s` : '—'} />
              <Metric label="Best MPV" value={bestMpv ? `${bestMpv.toFixed(2)} m/s` : '—'} />
              <Metric label="ROM" value={lastRep ? `${(lastRep.rom * 100).toFixed(0)} cm` : '—'} />
            </div>
            <div
              className={cn(
                'rounded-lg border p-3 text-center',
                overCutoff ? 'border-destructive bg-destructive/10' : 'bg-muted/40',
              )}
            >
              <p className="text-xs text-muted-foreground">Velocity Loss</p>
              <p className={cn('text-2xl font-bold', overCutoff && 'text-destructive')}>
                {vLoss.toFixed(1)}%
              </p>
              <p className="text-xs text-muted-foreground">
                {overCutoff ? 'Melewati cutoff — hentikan set / turunkan beban' : `Cutoff ${cutoff}%`}
              </p>
            </div>
            {zone && (
              <div className="rounded-lg border p-3">
                <p className="text-sm font-semibold">{zone.label}</p>
                <p className="text-xs text-muted-foreground">{zone.hint}</p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Status pelacakan: {live.found ? `terdeteksi · v ${live.v.toFixed(2)} m/s` : 'marker tidak terdeteksi'}
            </p>
          </CardContent>
        </Card>

        {/* Calibration */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Ruler className="h-4 w-4 text-primary" /> Kalibrasi Skala
            </CardTitle>
            <CardDescription className="text-xs">
              Skala dihitung otomatis dari ukuran objek referensi sehingga konsisten di berbagai jarak
              kamera dan ukuran layar.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="autoscale" className="text-sm">Kalibrasi otomatis</Label>
              <Switch id="autoscale" checked={autoScale} onCheckedChange={setAutoScale} />
            </div>
            {autoScale ? (
              <>
                <div className="space-y-1">
                  <Label className="text-xs">Diameter referensi (cm)</Label>
                  <Input
                    type="number"
                    value={refDiameter}
                    min={2}
                    onChange={(e) => setRefDiameter(Number(e.target.value) || 0)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Plate olympic = 45 cm, plate 20 kg standar = 45 cm, stiker marker = ukur sendiri.
                  </p>
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="lockscale" className="text-sm">Kunci skala</Label>
                  <Switch id="lockscale" checked={locked} onCheckedChange={setLocked} />
                </div>
              </>
            ) : (
              <div className="space-y-1">
                <Label className="text-xs">Skala manual (meter / piksel)</Label>
                <Input
                  type="number"
                  step="0.0001"
                  value={manualScale}
                  onChange={(e) => setManualScale(Number(e.target.value) || 0.0025)}
                />
              </div>
            )}
            <div className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="roion" className="text-sm">Area marker (kotak deteksi)</Label>
                <Switch id="roion" checked={roiOn} onCheckedChange={setRoiOn} />
              </div>
              {roiOn && (
                <>
                  <Label className="text-xs">Ukuran area: {roiSize} px</Label>
                  <Slider
                    value={[roiSize]}
                    min={40}
                    max={480}
                    step={10}
                    onValueChange={([v]) => setRoiSize(v)}
                  />
                  <div className="flex items-center justify-between">
                    <Label htmlFor="roifollow" className="text-sm">Ikuti plate otomatis</Label>
                    <Switch id="roifollow" checked={roiFollow} onCheckedChange={setRoiFollow} />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Kecilkan area agar hanya plate yang terbaca — ketuk gambar untuk memindahkan kotak.
                  </p>
                </>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={calibMode ? 'default' : 'outline'}
                onClick={() => {
                  setCalibMode((v) => !v);
                  setCalibLine(null);
                }}
              >
                {calibMode ? 'Batal Ukur' : 'Ukur Diameter Plate'}
              </Button>
              <Button size="sm" variant="outline" onClick={recalibrate}>
                Kalibrasi Ulang
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              Lebar plate terdeteksi: {blobPx ? `${blobPx} px` : '—'}
            </p>
            <p className="text-xs text-muted-foreground">
              Skala aktif: {scale ? `${(scale * 1000).toFixed(2)} mm/px` : '—'}
            </p>

          </CardContent>
        </Card>

        {/* Velocity loss cutoff */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Cutoff Velocity Loss</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Label className="text-xs">Batas: {cutoff}%</Label>
            <Slider value={[cutoff]} min={5} max={50} step={1} onValueChange={([v]) => setCutoff(v)} />
            <div className="flex flex-wrap gap-2">
              {[10, 15, 20, 25, 30].map((p) => (
                <Button key={p} size="sm" variant={cutoff === p ? 'default' : 'outline'} onClick={() => setCutoff(p)}>
                  {p}%
                </Button>
              ))}
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="alerton" className="text-sm">Notifikasi real-time (bunyi + getar)</Label>
              <Switch id="alerton" checked={alertOn} onCheckedChange={setAlertOn} />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
