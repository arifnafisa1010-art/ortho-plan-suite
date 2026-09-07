// VBT (Velocity Based Training) core utilities: marker tracking, auto scale
// calibration and rep detection from vertical displacement samples.

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface TrackResult {
  /** centroid x in canvas px */
  x: number;
  /** centroid y in canvas px */
  y: number;
  /** blob width in px */
  width: number;
  /** blob height in px */
  height: number;
  /** number of matched pixels */
  pixels: number;
}

export interface VbtRep {
  index: number;
  /** mean concentric velocity (m/s) */
  mpv: number;
  /** peak velocity (m/s) */
  peak: number;
  /** range of motion (m) */
  rom: number;
  /** concentric duration (s) */
  duration: number;
  timestamp: number;
}

export interface VbtSample {
  t: number; // seconds
  y: number; // meters, upward positive
}

/** Squared distance in RGB space, normalised 0..1 */
export function colorDistance(a: RgbColor, b: RgbColor): number {
  const dr = (a.r - b.r) / 255;
  const dg = (a.g - b.g) / 255;
  const db = (a.b - b.b) / 255;
  return Math.sqrt((dr * dr + dg * dg + db * db) / 3);
}

/**
 * Finds the centroid + bounding box of pixels matching `target` colour.
 * `tolerance` is 0..1 (higher = looser match). Sub-samples every 2px for speed.
 */
export interface Roi {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function trackMarker(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  target: RgbColor,
  tolerance: number,
  roi?: Roi | null,
): TrackResult | null {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  let minX = width;
  let maxX = 0;
  let minY = height;
  let maxY = 0;
  const step = 2;

  const x0 = Math.max(0, Math.floor(roi ? roi.x : 0));
  const y0 = Math.max(0, Math.floor(roi ? roi.y : 0));
  const x1 = Math.min(width, Math.ceil(roi ? roi.x + roi.w : width));
  const y1 = Math.min(height, Math.ceil(roi ? roi.y + roi.h : height));

  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * width + x) * 4;
      const px = { r: data[i], g: data[i + 1], b: data[i + 2] };
      if (colorDistance(px, target) <= tolerance) {
        sumX += x;
        sumY += y;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (count < 6) return null;


  return {
    x: sumX / count,
    y: sumY / count,
    width: maxX - minX,
    height: maxY - minY,
    pixels: count,
  };
}

/**
 * Automatic scale calibration: converts the tracked blob size (px) into a
 * metres-per-pixel factor using the known real diameter of the reference
 * object (plate 45cm / marker sticker etc.). Because it is recomputed from the
 * live blob, the scale stays consistent at any camera distance or screen size.
 */
export function metersPerPixel(blobSizePx: number, realDiameterCm: number): number | null {
  if (blobSizePx < 4 || realDiameterCm <= 0) return null;
  return realDiameterCm / 100 / blobSizePx;
}

/** Exponential smoothing helper for a noisy scale estimate. */
export function smoothScale(prev: number | null, next: number, alpha = 0.15): number {
  if (prev === null || !Number.isFinite(prev)) return next;
  return prev * (1 - alpha) + next * alpha;
}

const MIN_ROM = 0.15; // m — ignore jitter / partial movements
const MIN_DURATION = 0.15; // s
const VELOCITY_THRESHOLD = 0.15; // m/s to consider movement started

/**
 * Detects a completed concentric (upward) rep from a rolling sample buffer.
 * Returns rep metrics when the bar stops rising, otherwise null.
 */
export function detectRep(samples: VbtSample[]): Omit<VbtRep, 'index' | 'timestamp'> | null {
  if (samples.length < 6) return null;

  // Walk backwards to find the last continuous upward run.
  let end = samples.length - 1;
  // Confirm movement has stopped (last few samples ~ static or downward)
  const tailVel = velocityAt(samples, end);
  if (tailVel > VELOCITY_THRESHOLD * 0.5) return null;

  while (end > 0 && velocityAt(samples, end) <= VELOCITY_THRESHOLD) end--;
  if (end <= 1) return null;

  let start = end;
  while (start > 1 && velocityAt(samples, start) > VELOCITY_THRESHOLD * 0.4) start--;

  const rom = samples[end].y - samples[start].y;
  const duration = samples[end].t - samples[start].t;
  if (rom < MIN_ROM || duration < MIN_DURATION) return null;

  let peak = 0;
  for (let i = start + 1; i <= end; i++) {
    const v = velocityAt(samples, i);
    if (v > peak) peak = v;
  }

  const mpv = rom / duration;
  if (!Number.isFinite(mpv) || mpv <= 0) return null;

  return { mpv, peak, rom, duration };
}

export function velocityAt(samples: VbtSample[], i: number): number {
  if (i <= 0 || i >= samples.length) return 0;
  const dt = samples[i].t - samples[i - 1].t;
  if (dt <= 0) return 0;
  return (samples[i].y - samples[i - 1].y) / dt;
}

export function velocityLossPercent(best: number, current: number): number {
  if (best <= 0) return 0;
  return Math.max(0, ((best - current) / best) * 100);
}

/** Load-velocity zone guidance (Gonzalez-Badillo style reference table). */
export function velocityZone(mpv: number): { label: string; hint: string; tone: 'green' | 'blue' | 'amber' | 'red' } {
  if (mpv >= 1.3) return { label: 'Starting Strength', hint: '~30-45% 1RM · kecepatan maksimal', tone: 'green' };
  if (mpv >= 1.0) return { label: 'Speed-Strength', hint: '~45-60% 1RM · power tinggi', tone: 'blue' };
  if (mpv >= 0.75) return { label: 'Power', hint: '~60-75% 1RM · zona daya maksimum', tone: 'blue' };
  if (mpv >= 0.5) return { label: 'Strength-Speed', hint: '~75-85% 1RM · kekuatan cepat', tone: 'amber' };
  return { label: 'Absolute Strength', hint: '>85% 1RM · kekuatan maksimal', tone: 'red' };
}

/* ------------------------------------------------------------------ */
/* Estimasi 1RM berbasis kecepatan (Load-Velocity Profile)             */
/* ------------------------------------------------------------------ */

export type LvExercise = 'squat' | 'bench' | 'deadlift' | 'row' | 'press' | 'generic';

export const LV_EXERCISES: { id: LvExercise; label: string }[] = [
  { id: 'squat', label: 'Back Squat' },
  { id: 'bench', label: 'Bench Press' },
  { id: 'deadlift', label: 'Deadlift' },
  { id: 'row', label: 'Bent-over Row' },
  { id: 'press', label: 'Overhead Press' },
  { id: 'generic', label: 'Umum / lainnya' },
];

/** Koefisien regresi kuadratik %1RM = a·MPV² + b·MPV + c (Gonzalez-Badillo dkk.) */
const LV_COEF: Record<LvExercise, [number, number, number]> = {
  squat: [-5.961, -50.71, 117.0],
  bench: [-7.5312, -75.882, 131.75],
  deadlift: [-8.2, -60.5, 122.0],
  row: [-6.5, -63.0, 124.0],
  press: [-7.0, -70.0, 128.0],
  generic: [-7.0, -62.0, 122.0],
};

/** Tebak jenis latihan dari namanya untuk memilih profil L-V. */
export function guessLvExercise(name: string): LvExercise {
  const n = name.toLowerCase();
  if (n.includes('squat')) return 'squat';
  if (n.includes('bench') || n.includes('chest press')) return 'bench';
  if (n.includes('deadlift') || n.includes('dl')) return 'deadlift';
  if (n.includes('row')) return 'row';
  if (n.includes('press') || n.includes('ohp')) return 'press';
  return 'generic';
}

/** %1RM yang diprediksi dari MPV. */
export function percent1RMFromMpv(mpv: number, exercise: LvExercise = 'generic'): number {
  const [a, b, c] = LV_COEF[exercise];
  const pct = a * mpv * mpv + b * mpv + c;
  return Math.min(100, Math.max(20, pct));
}

export interface OneRmEstimate {
  /** estimasi 1RM (kg) */
  oneRm: number;
  /** persentase 1RM dari beban yang dipakai */
  percent: number;
  /** koreksi kelelahan berdasarkan velocity loss */
  fatigueAdjusted: number;
  exercise: LvExercise;
}

/**
 * Estimasi 1RM dari beban + MPV terbaik set. Velocity loss dipakai sebagai
 * faktor koreksi kelelahan (set yang sangat lelah cenderung meremehkan 1RM).
 */
export function estimate1RMFromVbt(
  loadKg: number,
  bestMpv: number,
  velocityLoss = 0,
  exercise: LvExercise = 'generic',
): OneRmEstimate | null {
  if (!loadKg || loadKg <= 0 || !bestMpv || bestMpv <= 0) return null;
  const percent = percent1RMFromMpv(bestMpv, exercise);
  const oneRm = (loadKg * 100) / percent;
  // tiap 10% velocity loss ≈ 1.5% underestimation
  const fatigueAdjusted = oneRm * (1 + Math.min(30, Math.max(0, velocityLoss)) * 0.0015);
  return {
    oneRm: Number(oneRm.toFixed(1)),
    percent: Number(percent.toFixed(1)),
    fatigueAdjusted: Number(fatigueAdjusted.toFixed(1)),
    exercise,
  };
}

/** Beban target (kg) untuk mencapai MPV tertentu dari 1RM yang diketahui. */
export function loadForTargetVelocity(
  oneRm: number,
  targetMpv: number,
  exercise: LvExercise = 'generic',
): number {
  return Number(((oneRm * percent1RMFromMpv(targetMpv, exercise)) / 100).toFixed(1));
}

/** Median (robust terhadap outlier) — dipakai untuk kalibrasi skala dinamis. */
export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* ------------------------------------------------------------------ */
/* Konversi set VBT -> beban latihan (TSS) untuk ACWR                   */
/* ------------------------------------------------------------------ */

/** Estimasi RPE (1-10) dari velocity loss sebuah set. */
export function rpeFromVelocityLoss(velocityLoss: number): number {
  const vl = Math.max(0, velocityLoss);
  if (vl < 10) return 6;
  if (vl < 15) return 7;
  if (vl < 20) return 8;
  if (vl < 30) return 9;
  return 10;
}

/** Estimasi durasi kerja+istirahat sebuah set VBT (menit). */
export function durationFromReps(reps: VbtRep[]): number {
  const work = reps.reduce((s, r) => s + (r.duration || 1) * 3, 0); // konsentrik + eksentrik
  const rest = 120; // istirahat antar set (detik)
  return Math.max(2, Math.round((work + rest) / 60));
}

/** Skala meter/piksel dari panjang garis kalibrasi manual (px) di canvas. */
export function scaleFromLine(pixelLength: number, realCm: number): number | null {
  if (pixelLength < 4 || realCm <= 0) return null;
  return realCm / 100 / pixelLength;
}
