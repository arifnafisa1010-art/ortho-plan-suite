import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Play, RotateCcw, Square, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { velocityLossPercent, velocityZone, type VbtRep } from '@/lib/vbt';
import { VelocityGauge } from '@/components/vbt/VelocityGauge';

interface Props {
  onRepsChange?: (reps: VbtRep[]) => void;
}

interface MotionEventCtor {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

const MIN_ROM = 0.12; // m
const MIN_DURATION = 0.15; // s
const V_START = 0.12; // m/s

/**
 * VBT berbasis sensor gerak HP (accelerometer/IMU).
 * HP diikat di barbel / sabuk, akselerasi vertikal diintegrasikan menjadi
 * kecepatan, dengan zero-velocity update (ZUPT) untuk menahan drift.
 */
export function VBTSensor({ onRepsChange }: Props) {
  const [supported, setSupported] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reps, setReps] = useState<VbtRep[]>([]);
  const [liveV, setLiveV] = useState(0);
  const [liveA, setLiveA] = useState(0);
  const [sensitivity, setSensitivity] = useState(0.35); // m/s² noise gate
  const [cutoff, setCutoff] = useState(20);
  const [alertOn, setAlertOn] = useState(true);

  const vRef = useRef(0);
  const yRef = useRef(0);
  const tRef = useRef(0);
  const gRef = useRef<{ x: number; y: number; z: number }>({ x: 0, y: 0, z: 9.81 });
  const biasRef = useRef(0);
  const repRef = useRef<{ active: boolean; startT: number; startY: number; peak: number } | null>(null);
  const alertedRef = useRef(false);

  const bestMpv = reps.length ? Math.max(...reps.map((r) => r.mpv)) : 0;
  const lastRep = reps[reps.length - 1];
  const vLoss = lastRep ? velocityLossPercent(bestMpv, lastRep.mpv) : 0;
  const overCutoff = !!lastRep && vLoss >= cutoff;
  const zone = lastRep ? velocityZone(lastRep.mpv) : null;

  useEffect(() => {
    setSupported(typeof window !== 'undefined' && 'DeviceMotionEvent' in window);
  }, []);

  useEffect(() => {
    onRepsChange?.(reps);
  }, [reps, onRepsChange]);

  useEffect(() => {
    if (!alertOn || !overCutoff || alertedRef.current) {
      if (!overCutoff) alertedRef.current = false;
      return;
    }
    alertedRef.current = true;
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    toast.error(`Velocity loss ${vLoss.toFixed(1)}% ≥ cutoff ${cutoff}%`, {
      description: 'Hentikan set atau turunkan beban.',
      duration: 7000,
    });
  }, [overCutoff, vLoss, cutoff, alertOn]);

  const handleMotion = useCallback(
    (e: DeviceMotionEvent) => {
      const now = performance.now() / 1000;
      const dt = tRef.current ? Math.min(0.1, now - tRef.current) : 0;
      tRef.current = now;
      if (!dt) return;

      const grav = e.accelerationIncludingGravity;
      const lin = e.acceleration;
      if (!grav) return;

      // low-pass gravity vector -> arah "atas"
      const a = 0.9;
      gRef.current = {
        x: gRef.current.x * a + (grav.x ?? 0) * (1 - a),
        y: gRef.current.y * a + (grav.y ?? 0) * (1 - a),
        z: gRef.current.z * a + (grav.z ?? 0) * (1 - a),
      };
      const g = gRef.current;
      const mag = Math.hypot(g.x, g.y, g.z) || 9.81;
      const gh = { x: g.x / mag, y: g.y / mag, z: g.z / mag };

      // akselerasi linear (tanpa gravitasi)
      const acc = lin?.x != null
        ? { x: lin.x ?? 0, y: lin.y ?? 0, z: lin.z ?? 0 }
        : { x: (grav.x ?? 0) - g.x, y: (grav.y ?? 0) - g.y, z: (grav.z ?? 0) - g.z };

      let aVert = acc.x * gh.x + acc.y * gh.y + acc.z * gh.z;
      aVert -= biasRef.current;
      setLiveA(aVert);

      if (Math.abs(aVert) < sensitivity) {
        // fase diam -> ZUPT + update bias
        biasRef.current = biasRef.current * 0.99 + (aVert + biasRef.current) * 0.01;
        vRef.current *= 0.5;
        if (Math.abs(vRef.current) < 0.05) vRef.current = 0;
      } else {
        vRef.current += aVert * dt;
      }

      const v = vRef.current;
      yRef.current += v * dt;
      setLiveV(v);

      const rep = repRef.current;
      if (!rep && v > V_START) {
        repRef.current = { active: true, startT: now, startY: yRef.current, peak: v };
      } else if (rep) {
        if (v > rep.peak) rep.peak = v;
        if (v <= V_START * 0.4) {
          const duration = now - rep.startT;
          const rom = yRef.current - rep.startY;
          repRef.current = null;
          if (rom >= MIN_ROM && duration >= MIN_DURATION) {
            const mpv = rom / duration;
            if (Number.isFinite(mpv) && mpv > 0 && mpv < 5) {
              setReps((prev) => [
                ...prev,
                {
                  index: prev.length + 1,
                  mpv: Number(mpv.toFixed(3)),
                  peak: Number(rep.peak.toFixed(3)),
                  rom: Number(rom.toFixed(3)),
                  duration: Number(duration.toFixed(3)),
                  timestamp: Date.now(),
                },
              ]);
            }
          }
        }
      }
    },
    [sensitivity],
  );

  const start = async () => {
    setError(null);
    const Ctor = (window as unknown as { DeviceMotionEvent?: MotionEventCtor }).DeviceMotionEvent;
    try {
      if (Ctor?.requestPermission) {
        const res = await Ctor.requestPermission();
        if (res !== 'granted') {
          setError('Izin sensor gerak ditolak. Aktifkan Motion & Orientation Access di pengaturan browser.');
          return;
        }
      }
    } catch {
      setError('Sensor gerak butuh HTTPS dan izin pengguna.');
      return;
    }
    vRef.current = 0;
    yRef.current = 0;
    tRef.current = 0;
    biasRef.current = 0;
    repRef.current = null;
    window.addEventListener('devicemotion', handleMotion);
    setRunning(true);
    toast.success('Sensor aktif', { description: 'Ikat HP pada barbel/sabuk lalu mulai angkat.' });
  };

  const stop = useCallback(() => {
    window.removeEventListener('devicemotion', handleMotion);
    setRunning(false);
  }, [handleMotion]);

  useEffect(() => () => window.removeEventListener('devicemotion', handleMotion), [handleMotion]);

  const reset = () => {
    setReps([]);
    vRef.current = 0;
    yRef.current = 0;
    repRef.current = null;
    alertedRef.current = false;
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4 text-primary" /> Sensor Gerak HP (IMU)
        </CardTitle>
        <CardDescription>
          Ukur kecepatan angkat langsung dari accelerometer HP — tanpa kamera. Ikat HP di barbel,
          dumbbell, atau sabuk, lalu tekan mulai.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!supported && (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            Perangkat/browser ini tidak menyediakan sensor gerak. Gunakan HP dengan HTTPS.
          </p>
        )}
        {error && (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {!running ? (
            <Button onClick={start} disabled={!supported} className="gap-2">
              <Play className="h-4 w-4" /> Mulai Sensor
            </Button>
          ) : (
            <Button variant="destructive" onClick={stop} className="gap-2">
              <Square className="h-4 w-4" /> Stop Sensor
            </Button>
          )}
          <Button variant="outline" onClick={reset} className="gap-2">
            <RotateCcw className="h-4 w-4" /> Reset Set
          </Button>
          {running && <Badge variant="secondary">Merekam · {reps.length} rep</Badge>}
        </div>

        <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
          <VelocityGauge
            value={gauge.value}
            max={gauge.max}
            unit={gauge.unit}
            decimals={gauge.decimals}
            showZones={gauge.showZones}
            label={gauge.label}
            sublabel={gauge.sublabel}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Metrik ditampilkan</Label>
              <Select value={metric} onValueChange={(v) => setMetric(v as MetricId)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METRICS.map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Beban (kg) — untuk hitung power</Label>
              <Input
                type="number"
                inputMode="decimal"
                value={loadKg}
                onChange={(e) => setLoadKg(e.target.value)}
                placeholder="contoh: 60"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Metric label="Kecepatan live" value={`${liveV.toFixed(2)} m/s`} />
          <Metric label="Akselerasi" value={`${liveA.toFixed(2)} m/s²`} />
          <Metric label="MPV terakhir" value={lastRep ? `${lastRep.mpv.toFixed(2)} m/s` : '—'} />
          <Metric label="Best MPV" value={bestMpv ? `${bestMpv.toFixed(2)} m/s` : '—'} />
          <Metric label="Peak velocity" value={lastRep ? `${lastRep.peak.toFixed(2)} m/s` : '—'} />
          <Metric label="Avg velocity set" value={avgMpv ? `${avgMpv.toFixed(2)} m/s` : '—'} />
          <Metric label="Power rata-rata" value={mass ? `${meanPower.toFixed(0)} W` : 'isi beban'} />
          <Metric label="Peak power" value={mass ? `${peakPower.toFixed(0)} W` : 'isi beban'} />
        </div>

        {reps.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Tiap repetisi</p>
            <div className="flex flex-wrap gap-2">
              {reps.map((r) => (
                <span
                  key={r.index}
                  className="rounded-md border bg-background px-2 py-1 text-xs"
                >
                  <span className="text-muted-foreground">#{r.index}</span>{' '}
                  <span className="font-semibold">{r.mpv.toFixed(2)}</span> m/s · peak{' '}
                  {r.peak.toFixed(2)} · ROM {(r.rom * 100).toFixed(0)} cm
                  {mass ? ` · ${(mass * G * r.mpv).toFixed(0)} W` : ''}
                </span>
              ))}
            </div>
          </div>
        )}

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
            {overCutoff ? 'Melewati cutoff — hentikan set' : `Cutoff ${cutoff}%`}
          </p>
        </div>

        {zone && (
          <div className="rounded-lg border p-3">
            <p className="text-sm font-semibold">{zone.label}</p>
            <p className="text-xs text-muted-foreground">{zone.hint}</p>
          </div>
        )}

        <div className="space-y-2">
          <Label className="text-xs">Sensitivitas gerak: {sensitivity.toFixed(2)} m/s²</Label>
          <Slider
            value={[sensitivity]}
            min={0.1}
            max={1.5}
            step={0.05}
            onValueChange={([v]) => setSensitivity(v)}
          />
          <p className="text-[11px] text-muted-foreground">
            Naikkan bila rep palsu terdeteksi saat HP diam, turunkan bila angkatan lambat tidak
            terbaca.
          </p>
        </div>

        <div className="space-y-2">
          <Label className="text-xs">Cutoff velocity loss: {cutoff}%</Label>
          <Slider value={[cutoff]} min={5} max={50} step={1} onValueChange={([v]) => setCutoff(v)} />
          <div className="flex items-center justify-between">
            <Label htmlFor="sensor-alert" className="text-sm">Notifikasi real-time (getar)</Label>
            <Switch id="sensor-alert" checked={alertOn} onCheckedChange={setAlertOn} />
          </div>
        </div>
      </CardContent>
    </Card>
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
