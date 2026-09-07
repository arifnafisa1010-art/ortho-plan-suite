import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { durationFromReps, rpeFromVelocityLoss, type VbtRep } from '@/lib/vbt';
import { calculateSessionLoad } from '@/hooks/useTrainingLoads';

export interface VbtSet {
  id: string;
  user_id: string;
  athlete_id: string | null;
  exercise_name: string;
  session_date: string;
  load_kg: number | null;
  reps: VbtRep[];
  best_mpv: number | null;
  avg_mpv: number | null;
  velocity_loss: number | null;
  source: string;
  notes: string | null;
  created_at: string;
}

export interface SaveVbtSetInput {
  athleteId: string | null;
  exerciseName: string;
  sessionDate: string;
  loadKg?: number | null;
  reps: VbtRep[];
  source?: string;
  notes?: string | null;
}

export function useVbtSets(athleteId?: string | null) {
  const { user } = useAuth();
  const [sets, setSets] = useState<VbtSet[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) {
      setSets([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let query = supabase
      .from('vbt_sets')
      .select('*')
      .order('session_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (athleteId) query = query.eq('athlete_id', athleteId);

    const { data, error } = await query;
    if (error) {
      console.error(error);
      toast.error('Gagal memuat riwayat VBT');
      setSets([]);
    } else {
      setSets(
        (data ?? []).map((row) => ({
          ...row,
          reps: Array.isArray(row.reps) ? (row.reps as unknown as VbtRep[]) : [],
          load_kg: row.load_kg === null ? null : Number(row.load_kg),
          best_mpv: row.best_mpv === null ? null : Number(row.best_mpv),
          avg_mpv: row.avg_mpv === null ? null : Number(row.avg_mpv),
          velocity_loss: row.velocity_loss === null ? null : Number(row.velocity_loss),
        })) as VbtSet[],
      );
    }
    setLoading(false);
  }, [user?.id, athleteId]);

  useEffect(() => {
    load();
  }, [load]);

  const saveSet = useCallback(
    async (input: SaveVbtSetInput) => {
      if (!user) {
        toast.error('Anda harus login');
        return null;
      }
      if (!input.reps.length) {
        toast.error('Belum ada repetisi untuk disimpan');
        return null;
      }
      const best = Math.max(...input.reps.map((r) => r.mpv));
      const avg = input.reps.reduce((s, r) => s + r.mpv, 0) / input.reps.length;
      const last = input.reps[input.reps.length - 1];
      const vLoss = best > 0 ? ((best - last.mpv) / best) * 100 : 0;

      const { data, error } = await supabase
        .from('vbt_sets')
        .insert({
          user_id: user.id,
          athlete_id: input.athleteId,
          exercise_name: input.exerciseName,
          session_date: input.sessionDate,
          load_kg: input.loadKg ?? null,
          reps: input.reps as unknown as never,
          best_mpv: Number(best.toFixed(3)),
          avg_mpv: Number(avg.toFixed(3)),
          velocity_loss: Number(vLoss.toFixed(2)),
          source: input.source ?? 'camera',
          notes: input.notes ?? null,
        })
        .select()
        .single();

      if (error) {
        console.error(error);
        toast.error('Gagal menyimpan set VBT');
        return null;
      }

      // Otomatis catat sebagai beban latihan (TSS) agar masuk ACWR mingguan
      const rpe = rpeFromVelocityLoss(vLoss);
      const durationMinutes = durationFromReps(input.reps);
      const sessionLoad = calculateSessionLoad(durationMinutes, rpe);
      const { error: loadError } = await supabase.from('training_loads').insert({
        user_id: user.id,
        athlete_id: input.athleteId,
        session_date: input.sessionDate,
        duration_minutes: durationMinutes,
        rpe,
        session_load: sessionLoad,
        training_type: 'strength',
        notes: `VBT ${input.exerciseName}${input.loadKg ? ` ${input.loadKg} kg` : ''} · ${input.reps.length} rep · best MPV ${best.toFixed(2)} m/s · VL ${vLoss.toFixed(0)}%`,
      });
      if (loadError) console.error('Gagal sinkron TSS dari VBT:', loadError);

      toast.success('Set VBT tersimpan', {
        description: `Masuk Peta Otot & beban latihan ${sessionLoad} TSS (RPE ${rpe}, ${durationMinutes} menit).`,
      });
      await load();
      return data;
    },
    [user?.id, load],
  );

  const deleteSet = useCallback(
    async (id: string) => {
      const { error } = await supabase.from('vbt_sets').delete().eq('id', id);
      if (error) {
        console.error(error);
        toast.error('Gagal menghapus set');
        return;
      }
      setSets((prev) => prev.filter((s) => s.id !== id));
    },
    [],
  );

  return { sets, loading, saveSet, deleteSet, reload: load };
}
