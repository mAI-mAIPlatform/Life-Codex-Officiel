import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BucketAIScheduler, LoopManager, UpdateContext } from './core/LoopManager';
import { WorkerBridge } from './core/WorkerBridge';
import { ChunkState, ChunkStreamingManager } from './core/streaming';

type EngineStats = {
  fps: number;
  poolUsage: number;
  activeChunks: number;
};

class EntityPool {
  constructor(private readonly capacity: number, private used = 0) {}

  reserve(count: number): void {
    this.used = Math.min(this.capacity, this.used + Math.max(0, count));
  }

  getUsageRatio(): number {
    return this.capacity === 0 ? 0 : this.used / this.capacity;
  }

  dispose(): void {
    this.used = 0;
  }
}

export function GameEngine(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const loopRef = useRef<LoopManager | null>(null);
  const workerBridgeRef = useRef<WorkerBridge | null>(null);
  const streamingRef = useRef<ChunkStreamingManager | null>(null);
  const poolRef = useRef<EntityPool | null>(null);

  const [stats, setStats] = useState<EngineStats>({ fps: 0, poolUsage: 0, activeChunks: 0 });
  const [chunks, setChunks] = useState<ChunkState[]>([]);

  const aiScheduler = useMemo(() => new BucketAIScheduler(Array.from({ length: 1200 }, (_, i) => i), 6), []);

  useEffect(() => {
    // Lifecycle init: world + pools + workers.
    const streaming = new ChunkStreamingManager({ chunkSizeMeters: 100 });
    const pool = new EntityPool(10_000);
    const workerBridge = new WorkerBridge();

    streamingRef.current = streaming;
    poolRef.current = pool;
    workerBridgeRef.current = workerBridge;

    // Les workers sont optionnels au runtime (SSR/tests): garde robuste.
    if (typeof Worker !== 'undefined') {
      try {
        workerBridge.createChannel('physics', new Worker(new URL('./workers/physics.worker.ts', import.meta.url)));
        workerBridge.createChannel('pathfinding', new Worker(new URL('./workers/pathfinding.worker.ts', import.meta.url)));
        workerBridge.createChannel('procgen', new Worker(new URL('./workers/procgen.worker.ts', import.meta.url)));
      } catch {
        // En dev sans bundler worker prêt, on continue sans crash.
      }
    }

    let fpsSamples = 0;
    let fpsAccumulator = 0;

    const loop = new LoopManager(
      {
        aiScheduler,
        fixedUpdate: (ctx: UpdateContext) => {
          pool.reserve(4);
          workerBridge.step(ctx.frameIndex, ctx.fixedDt);
        },
        lateUpdate: (ctx: UpdateContext) => {
          const simulatedPosition = { x: ctx.frameIndex * 1.5, y: ctx.frameIndex * 0.75 };
          const active = streaming.updateFocus(simulatedPosition);
          setChunks(active);
        },
        render: (ctx: UpdateContext) => {
          const canvas = canvasRef.current;
          const context = canvas?.getContext('2d');
          if (!context || !canvas) return;

          context.clearRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = '#0f172a';
          context.fillRect(0, 0, canvas.width, canvas.height);

          fpsSamples += 1;
          fpsAccumulator += ctx.frameDt;
          if (fpsAccumulator >= 0.25) {
            const fps = Math.round(fpsSamples / fpsAccumulator);
            fpsAccumulator = 0;
            fpsSamples = 0;

            setStats({
              fps,
              poolUsage: Math.round(pool.getUsageRatio() * 100),
              activeChunks: streaming.getActiveChunks().length,
            });
          }
        },
      },
      { fixedStepSeconds: 1 / 60, maxFrameDeltaSeconds: 0.25, maxFixedStepsPerFrame: 5 },
    );

    loopRef.current = loop;
    loop.start();

    return () => {
      // Lifecycle dispose propre.
      loop.stop();
      workerBridge.shutdown();
      pool.dispose();
      setChunks([]);
    };
  }, [aiScheduler]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas ref={canvasRef} width={1280} height={720} style={{ width: '100%', height: '100%', display: 'block' }} />

      {/* Overlay Liquid Glass: translucide + blur + border lumineux. */}
      <aside
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          width: 280,
          padding: '14px 16px',
          borderRadius: 16,
          color: '#e2e8f0',
          background: 'linear-gradient(135deg, rgba(255,255,255,0.22), rgba(148,163,184,0.12))',
          boxShadow: '0 10px 40px rgba(2, 6, 23, 0.45), inset 0 1px 0 rgba(255,255,255,0.35)',
          border: '1px solid rgba(226,232,240,0.28)',
          backdropFilter: 'blur(14px) saturate(140%)',
          WebkitBackdropFilter: 'blur(14px) saturate(140%)',
        }}
      >
        <h3 style={{ margin: 0, marginBottom: 12, fontSize: 15, letterSpacing: 0.3 }}>Debug HUD — Liquid Glass</h3>
        <DebugLine label='FPS' value={String(stats.fps)} />
        <DebugLine label='Pool usage' value={`${stats.poolUsage}%`} />
        <DebugLine label='Chunks actifs' value={String(stats.activeChunks)} />
        <DebugLine label='IA buckets' value={String(aiScheduler.getBucketCount())} />

        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85 }}>
          High: simulation complète · Medium: LOD + IA réduite · Low: impostors sans physique
        </div>
      </aside>

      <section
        style={{
          position: 'absolute',
          left: 16,
          bottom: 16,
          maxHeight: 220,
          overflow: 'auto',
          minWidth: 250,
          padding: 12,
          borderRadius: 12,
          background: 'rgba(15,23,42,0.52)',
          border: '1px solid rgba(148,163,184,0.25)',
          color: '#bfdbfe',
          fontSize: 12,
          backdropFilter: 'blur(10px)',
        }}
      >
        {chunks.slice(0, 8).map((chunk) => (
          <div key={chunk.key}>
            {chunk.key} · {chunk.priority}
          </div>
        ))}
      </section>
    </div>
  );
}

function DebugLine({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13 }}>
      <span style={{ opacity: 0.8 }}>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
