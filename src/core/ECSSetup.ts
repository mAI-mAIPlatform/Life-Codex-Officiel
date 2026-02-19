export const enum ComponentStorageKind {
  Float32 = 'float32',
  Int8 = 'int8',
  Uint32 = 'uint32',
}

export type ComponentMask = number;
export type EntityId = number;

export interface ComponentLayout {
  /** Bit unique du composant dans le masque global (1 << n). */
  bit: number;
  kind: ComponentStorageKind;
  defaultValue?: number;
}

type SoABuffer = Float32Array | Int8Array | Uint32Array;

type EntityMeta = {
  mask: ComponentMask;
  table: ArchetypeTable;
  row: number;
  active: boolean;
};

function createBuffer(kind: ComponentStorageKind, size: number): SoABuffer {
  switch (kind) {
    case ComponentStorageKind.Float32:
      return new Float32Array(size);
    case ComponentStorageKind.Int8:
      return new Int8Array(size);
    case ComponentStorageKind.Uint32:
      return new Uint32Array(size);
    default: {
      const unreachable: never = kind;
      throw new Error(`Type de stockage non supporté: ${String(unreachable)}`);
    }
  }
}

class ArchetypeTable {
  public readonly mask: ComponentMask;
  public length = 0;

  private capacity: number;
  private entities: Uint32Array;
  private readonly componentLayouts: Map<number, ComponentLayout>;
  private readonly columns = new Map<number, SoABuffer>();

  constructor(mask: ComponentMask, componentLayouts: Map<number, ComponentLayout>, initialCapacity = 64) {
    this.mask = mask;
    this.componentLayouts = componentLayouts;
    this.capacity = Math.max(1, initialCapacity);
    this.entities = new Uint32Array(this.capacity);

    for (const [bit, layout] of componentLayouts.entries()) {
      if ((mask & bit) !== 0) {
        this.columns.set(bit, createBuffer(layout.kind, this.capacity));
      }
    }
  }

  insert(entityId: EntityId, values?: Partial<Record<number, number>>): number {
    this.ensureCapacity(this.length + 1);
    const row = this.length;
    this.entities[row] = entityId;

    for (const [bit, column] of this.columns.entries()) {
      const layout = this.componentLayouts.get(bit);
      const fallback = layout?.defaultValue ?? 0;
      column[row] = values?.[bit] ?? fallback;
    }

    this.length += 1;
    return row;
  }

  removeAt(row: number): EntityId | null {
    if (row < 0 || row >= this.length) {
      throw new Error(`Index de ligne invalide ${row} pour un archétype de taille ${this.length}`);
    }

    const last = this.length - 1;
    const movedEntity = row !== last ? this.entities[last] : null;

    if (row !== last) {
      this.entities[row] = this.entities[last];
      for (const column of this.columns.values()) {
        column[row] = column[last];
      }
    }

    this.length = last;
    return movedEntity;
  }

  readComponent(row: number, componentBit: number): number {
    const column = this.columns.get(componentBit);
    if (!column) {
      throw new Error(`Composant ${componentBit} absent de l'archétype ${this.mask}`);
    }
    return column[row];
  }

  writeComponent(row: number, componentBit: number, value: number): void {
    const column = this.columns.get(componentBit);
    if (!column) {
      throw new Error(`Composant ${componentBit} absent de l'archétype ${this.mask}`);
    }
    column[row] = value;
  }

  entityAt(row: number): EntityId {
    return this.entities[row];
  }

  hasComponent(componentBit: number): boolean {
    return this.columns.has(componentBit);
  }

  compatibleWith(requiredMask: ComponentMask): boolean {
    return (this.mask & requiredMask) === requiredMask;
  }

  private ensureCapacity(minCapacity: number): void {
    if (this.capacity >= minCapacity) {
      return;
    }

    while (this.capacity < minCapacity) {
      this.capacity *= 2;
    }

    const resizedEntities = new Uint32Array(this.capacity);
    resizedEntities.set(this.entities.subarray(0, this.length));
    this.entities = resizedEntities;

    for (const [bit, prev] of this.columns.entries()) {
      const layout = this.componentLayouts.get(bit);
      if (!layout) {
        continue;
      }
      const next = createBuffer(layout.kind, this.capacity);
      next.set(prev.subarray(0, this.length));
      this.columns.set(bit, next);
    }
  }
}

export class Query {
  constructor(private readonly world: World, private readonly requiredMask: ComponentMask) {}

  *entities(): IterableIterator<EntityId> {
    for (const table of this.world.getArchetypes()) {
      if (!table.compatibleWith(this.requiredMask)) {
        continue;
      }

      for (let row = 0; row < table.length; row += 1) {
        const entityId = table.entityAt(row);
        if (this.world.isActive(entityId)) {
          yield entityId;
        }
      }
    }
  }
}

export class World {
  private nextEntityId = 1;
  private readonly archetypes = new Map<ComponentMask, ArchetypeTable>();
  private readonly metadata = new Map<EntityId, EntityMeta>();

  constructor(private readonly layouts: ComponentLayout[]) {}

  createEntity(mask: ComponentMask, values?: Partial<Record<number, number>>): EntityId {
    const entityId = this.nextEntityId;
    this.nextEntityId += 1;

    const table = this.getOrCreateArchetype(mask);
    const row = table.insert(entityId, values);

    this.metadata.set(entityId, { mask, table, row, active: true });
    return entityId;
  }

  addComponent(entityId: EntityId, componentBit: number, value = 0): void {
    const meta = this.mustGetMeta(entityId);
    if ((meta.mask & componentBit) !== 0) {
      meta.table.writeComponent(meta.row, componentBit, value);
      return;
    }

    this.migrateEntity(entityId, meta.mask | componentBit, { [componentBit]: value });
  }

  removeComponent(entityId: EntityId, componentBit: number): void {
    const meta = this.mustGetMeta(entityId);
    if ((meta.mask & componentBit) === 0) {
      return;
    }

    this.migrateEntity(entityId, meta.mask & ~componentBit);
  }

  setComponent(entityId: EntityId, componentBit: number, value: number): void {
    const meta = this.mustGetMeta(entityId);
    meta.table.writeComponent(meta.row, componentBit, value);
  }

  getComponent(entityId: EntityId, componentBit: number): number {
    const meta = this.mustGetMeta(entityId);
    return meta.table.readComponent(meta.row, componentBit);
  }

  createQuery(requiredMask: ComponentMask): Query {
    return new Query(this, requiredMask);
  }

  isActive(entityId: EntityId): boolean {
    return this.metadata.get(entityId)?.active ?? false;
  }

  deactivate(entityId: EntityId): void {
    const meta = this.mustGetMeta(entityId);
    meta.active = false;
  }

  getArchetypes(): Iterable<ArchetypeTable> {
    return this.archetypes.values();
  }

  private migrateEntity(entityId: EntityId, nextMask: ComponentMask, overrides?: Partial<Record<number, number>>): void {
    const meta = this.mustGetMeta(entityId);
    const fromTable = meta.table;

    const nextValues: Partial<Record<number, number>> = {};
    for (const layout of this.layouts) {
      if ((nextMask & layout.bit) === 0) {
        continue;
      }

      if (overrides && overrides[layout.bit] !== undefined) {
        nextValues[layout.bit] = overrides[layout.bit];
      } else if (fromTable.hasComponent(layout.bit)) {
        nextValues[layout.bit] = fromTable.readComponent(meta.row, layout.bit);
      } else {
        nextValues[layout.bit] = layout.defaultValue ?? 0;
      }
    }

    const toTable = this.getOrCreateArchetype(nextMask);
    const nextRow = toTable.insert(entityId, nextValues);

    const movedEntity = fromTable.removeAt(meta.row);
    if (movedEntity !== null) {
      const movedMeta = this.mustGetMeta(movedEntity);
      movedMeta.row = meta.row;
    }

    meta.mask = nextMask;
    meta.table = toTable;
    meta.row = nextRow;
  }

  private getOrCreateArchetype(mask: ComponentMask): ArchetypeTable {
    const found = this.archetypes.get(mask);
    if (found) {
      return found;
    }

    const layoutMap = new Map<number, ComponentLayout>();
    for (const layout of this.layouts) {
      layoutMap.set(layout.bit, layout);
    }

    const created = new ArchetypeTable(mask, layoutMap);
    this.archetypes.set(mask, created);
    return created;
  }

  private mustGetMeta(entityId: EntityId): EntityMeta {
    const meta = this.metadata.get(entityId);
    if (!meta) {
      throw new Error(`Entité ${entityId} introuvable dans le monde`);
    }
    return meta;
  }
}
