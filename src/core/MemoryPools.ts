export interface PoolDebugSnapshot {
  capacity: number;
  inUse: number;
  highWaterMark: number;
  leakSuspectCount: number;
}

export class PoolDebugTracker {
  private inUse = 0;
  private highWaterMark = 0;
  private leakSuspectCount = 0;

  constructor(private capacity = 0) {}

  onAcquire(capacity: number): void {
    this.capacity = capacity;
    this.inUse += 1;
    this.highWaterMark = Math.max(this.highWaterMark, this.inUse);
  }

  onRelease(capacity: number): void {
    this.capacity = capacity;
    this.inUse = Math.max(0, this.inUse - 1);
  }

  markLeakSuspect(count = 1): void {
    this.leakSuspectCount += count;
  }

  snapshot(): PoolDebugSnapshot {
    return {
      capacity: this.capacity,
      inUse: this.inUse,
      highWaterMark: this.highWaterMark,
      leakSuspectCount: this.leakSuspectCount,
    };
  }
}

export class ObjectPool<T extends object> {
  private readonly objects: T[] = [];
  private readonly freeIndices: number[] = [];
  private readonly indexByObject = new WeakMap<T, number>();
  private readonly inUse = new Set<number>();

  public readonly debug = new PoolDebugTracker(0);

  constructor(
    private readonly createItem: () => T,
    private readonly resetItem?: (item: T) => void,
    initialCapacity = 0,
  ) {
    for (let i = 0; i < initialCapacity; i += 1) {
      const item = this.createItem();
      this.objects.push(item);
      this.indexByObject.set(item, i);
      this.freeIndices.push(i);
    }
  }

  acquire(): T {
    let index = this.freeIndices.pop();

    if (index === undefined) {
      const item = this.createItem();
      index = this.objects.length;
      this.objects.push(item);
      this.indexByObject.set(item, index);
    }

    const item = this.objects[index];
    this.inUse.add(index);
    this.debug.onAcquire(this.capacity());
    return item;
  }

  release(item: T): void {
    const index = this.indexByObject.get(item);
    if (index === undefined) {
      this.debug.markLeakSuspect();
      return;
    }

    if (!this.inUse.has(index)) {
      this.debug.markLeakSuspect();
      return;
    }

    if (this.resetItem) {
      this.resetItem(item);
    }

    this.inUse.delete(index);
    this.freeIndices.push(index);
    this.debug.onRelease(this.capacity());
  }

  capacity(): number {
    return this.objects.length;
  }
}

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export class TempVectorPool {
  private readonly pool: ObjectPool<Vector3>;

  constructor(capacity = 256) {
    this.pool = new ObjectPool<Vector3>(
      () => ({ x: 0, y: 0, z: 0 }),
      (v) => {
        v.x = 0;
        v.y = 0;
        v.z = 0;
      },
      capacity,
    );
  }

  acquire(x = 0, y = 0, z = 0): Vector3 {
    const v = this.pool.acquire();
    v.x = x;
    v.y = y;
    v.z = z;
    return v;
  }

  release(v: Vector3): void {
    this.pool.release(v);
  }

  stats(): PoolDebugSnapshot {
    return this.pool.debug.snapshot();
  }
}

/**
 * Gestionnaire de cycle de vie léger:
 * - bit 0 = actif
 * - bit 1 = soft-deleted
 */
export class EntityLifecyclePool {
  private static readonly ACTIVE = 1 << 0;
  private static readonly SOFT_DELETED = 1 << 1;

  private nextEntityId = 1;
  private flags = new Uint8Array(256);
  private readonly freeEntityIds: number[] = [];

  create(): number {
    const entityId = this.freeEntityIds.pop() ?? this.nextEntityId++;
    this.ensureCapacity(entityId + 1);
    this.flags[entityId] = EntityLifecyclePool.ACTIVE;
    return entityId;
  }

  softDelete(entityId: number): void {
    if (entityId <= 0 || entityId >= this.flags.length) {
      return;
    }

    const current = this.flags[entityId];
    if ((current & EntityLifecyclePool.ACTIVE) === 0) {
      return;
    }

    this.flags[entityId] = EntityLifecyclePool.SOFT_DELETED;
    this.freeEntityIds.push(entityId);
  }

  isActive(entityId: number): boolean {
    return (this.flags[entityId] & EntityLifecyclePool.ACTIVE) !== 0;
  }

  private ensureCapacity(min: number): void {
    if (this.flags.length >= min) {
      return;
    }

    let next = this.flags.length;
    while (next < min) {
      next *= 2;
    }

    const resized = new Uint8Array(next);
    resized.set(this.flags);
    this.flags = resized;
  }
}
