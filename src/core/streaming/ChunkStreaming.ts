export type ChunkPriority = 'High' | 'Medium' | 'Low';

export interface Vec2 {
  x: number;
  y: number;
}

export interface ChunkCoord {
  cx: number;
  cy: number;
}

export interface ChunkState extends ChunkCoord {
  key: string;
  priority: ChunkPriority;
  distance: number;
  loaded: boolean;
}

export interface StreamingConfig {
  chunkSizeMeters?: number;
  enterRadiusChunks?: number;
  exitRadiusChunks?: number;
}

export class ChunkStreamingManager {
  readonly chunkSizeMeters: number;
  readonly enterRadiusChunks: number;
  readonly exitRadiusChunks: number;

  private activeChunks = new Map<string, ChunkState>();

  constructor(config: StreamingConfig = {}) {
    this.chunkSizeMeters = config.chunkSizeMeters ?? 100;
    this.enterRadiusChunks = config.enterRadiusChunks ?? 4;
    // Hystérésis sortie > entrée pour éviter le thrash de chargement.
    this.exitRadiusChunks = config.exitRadiusChunks ?? this.enterRadiusChunks + 2;
  }

  updateFocus(position: Vec2): ChunkState[] {
    const focus = this.worldToChunk(position);

    // Charge les chunks dans le rayon d'entrée.
    for (let y = focus.cy - this.enterRadiusChunks; y <= focus.cy + this.enterRadiusChunks; y += 1) {
      for (let x = focus.cx - this.enterRadiusChunks; x <= focus.cx + this.enterRadiusChunks; x += 1) {
        const key = this.keyOf(x, y);
        const distance = Math.max(Math.abs(x - focus.cx), Math.abs(y - focus.cy));
        const priority = this.computePriority(distance);
        const existing = this.activeChunks.get(key);

        if (!existing) {
          this.activeChunks.set(key, { cx: x, cy: y, key, distance, priority, loaded: true });
          continue;
        }

        existing.distance = distance;
        existing.priority = priority;
        existing.loaded = true;
      }
    }

    // Décharge seulement au-delà du rayon de sortie (hystérésis).
    for (const [key, chunk] of this.activeChunks.entries()) {
      const distance = Math.max(Math.abs(chunk.cx - focus.cx), Math.abs(chunk.cy - focus.cy));
      if (distance > this.exitRadiusChunks) {
        this.activeChunks.delete(key);
      }
    }

    return [...this.activeChunks.values()];
  }

  getActiveChunks(): ChunkState[] {
    return [...this.activeChunks.values()];
  }

  private worldToChunk(position: Vec2): ChunkCoord {
    return {
      cx: Math.floor(position.x / this.chunkSizeMeters),
      cy: Math.floor(position.y / this.chunkSizeMeters),
    };
  }

  private computePriority(distance: number): ChunkPriority {
    if (distance <= 1) return 'High';
    if (distance <= 3) return 'Medium';
    return 'Low';
  }

  private keyOf(cx: number, cy: number): string {
    return `${cx}:${cy}`;
  }
}
