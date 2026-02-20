export type UpdateContext = {
  readonly nowMs: number;
  readonly fixedDt: number;
  readonly frameDt: number;
  readonly alpha: number;
  readonly frameIndex: number;
};

export type EntityId = string | number;

export interface IAIScheduler {
  /**
   * Exécute une tranche d'IA pour ce frame.
   */
  tick(frameIndex: number, dt: number): void;
}

export interface LoopHooks {
  fixedUpdate(ctx: UpdateContext): void;
  lateUpdate(ctx: UpdateContext): void;
  render(ctx: UpdateContext): void;
  aiScheduler?: IAIScheduler;
}

export interface LoopConfig {
  fixedStepSeconds?: number;
  maxFrameDeltaSeconds?: number;
  maxFixedStepsPerFrame?: number;
}

/**
 * Scheduler IA « time-sliced »: distribue les entités en buckets, puis
 * traite un bucket par frame pour lisser les coûts CPU.
 */
export class BucketAIScheduler implements IAIScheduler {
  private readonly buckets: EntityId[][];

  constructor(entities: EntityId[], slicesPerFrame = 4) {
    const safeSlices = Math.max(1, slicesPerFrame);
    this.buckets = Array.from({ length: safeSlices }, () => []);

    entities.forEach((entity, index) => {
      this.buckets[index % safeSlices].push(entity);
    });
  }

  tick(frameIndex: number, dt: number): void {
    const bucketIndex = frameIndex % this.buckets.length;
    const bucket = this.buckets[bucketIndex];

    // Place-holder: brancher ici votre système d'IA réel.
    // Le dt est fourni pour garder un comportement déterministe.
    for (const _entity of bucket) {
      void dt;
    }
  }

  getBucketCount(): number {
    return this.buckets.length;
  }
}

/**
 * Boucle de jeu avec pas fixe + anti-spirale + ordre strict:
 * FixedUpdate => LateUpdate => Render.
 */
export class LoopManager {
  private readonly fixedStep: number;
  private readonly maxFrameDelta: number;
  private readonly maxFixedStepsPerFrame: number;

  private accumulator = 0;
  private running = false;
  private frameIndex = 0;
  private rafId: number | null = null;
  private lastTimestampMs: number | null = null;

  constructor(private readonly hooks: LoopHooks, config: LoopConfig = {}) {
    this.fixedStep = config.fixedStepSeconds ?? 1 / 60;
    this.maxFrameDelta = config.maxFrameDeltaSeconds ?? 0.25;
    this.maxFixedStepsPerFrame = config.maxFixedStepsPerFrame ?? 5;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTimestampMs = null;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.lastTimestampMs = null;
    this.accumulator = 0;
  }

  private tick = (nowMs: number): void => {
    if (!this.running) return;

    if (this.lastTimestampMs === null) {
      this.lastTimestampMs = nowMs;
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }

    const rawFrameDt = (nowMs - this.lastTimestampMs) / 1000;
    this.lastTimestampMs = nowMs;

    // Clamp anti-spirale: évite d'empiler des dizaines de steps après un freeze.
    const frameDt = Math.min(Math.max(rawFrameDt, 0), this.maxFrameDelta);
    this.accumulator += frameDt;

    let fixedSteps = 0;
    while (this.accumulator >= this.fixedStep && fixedSteps < this.maxFixedStepsPerFrame) {
      const fixedCtx: UpdateContext = {
        nowMs,
        fixedDt: this.fixedStep,
        frameDt,
        alpha: 0,
        frameIndex: this.frameIndex,
      };

      this.hooks.fixedUpdate(fixedCtx);
      this.hooks.aiScheduler?.tick(this.frameIndex, this.fixedStep);

      this.accumulator -= this.fixedStep;
      fixedSteps += 1;
    }

    // Si on a atteint le cap de steps, on purge l'accumulateur restant.
    if (fixedSteps === this.maxFixedStepsPerFrame && this.accumulator >= this.fixedStep) {
      this.accumulator = 0;
    }

    const alpha = this.fixedStep > 0 ? this.accumulator / this.fixedStep : 0;
    const frameCtx: UpdateContext = {
      nowMs,
      fixedDt: this.fixedStep,
      frameDt,
      alpha,
      frameIndex: this.frameIndex,
    };

    this.hooks.lateUpdate(frameCtx);
    this.hooks.render(frameCtx);

    this.frameIndex += 1;
    this.rafId = requestAnimationFrame(this.tick);
  };
}
