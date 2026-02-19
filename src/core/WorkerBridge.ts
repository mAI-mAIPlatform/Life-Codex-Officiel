export const WORKER_PROTOCOL_VERSION = 1;

export type WorkerDomain = 'physics' | 'pathfinding' | 'procgen';
export type WorkerMessageType = 'INIT' | 'STEP' | 'SYNC' | 'SHUTDOWN';

export interface BaseWorkerMessage {
  version: number;
  type: WorkerMessageType;
  domain: WorkerDomain;
  timestamp: number;
}

export interface InitMessage extends BaseWorkerMessage {
  type: 'INIT';
  payload: {
    workerId: string;
    sharedBuffer: SharedArrayBuffer;
    sharedBufferByteLength: number;
  };
}

export interface StepMessage extends BaseWorkerMessage {
  type: 'STEP';
  payload: { dt: number; frameIndex: number };
}

export interface SyncMessage extends BaseWorkerMessage {
  type: 'SYNC';
  payload: { sequence: number };
}

export interface ShutdownMessage extends BaseWorkerMessage {
  type: 'SHUTDOWN';
  payload: { reason?: string };
}

export type WorkerBridgeMessage = InitMessage | StepMessage | SyncMessage | ShutdownMessage;

export interface SharedStateViews {
  header: Int32Array;
  transforms: Float32Array;
  meta: Uint32Array;
}

export interface WorkerChannel {
  domain: WorkerDomain;
  worker: Worker;
  views: SharedStateViews;
  post(msg: WorkerBridgeMessage): void;
}

const HEADER_SIZE = 16;
const TRANSFORM_FLOATS = 8192;
const META_UINTS = 2048;

export class WorkerBridge {
  private channels = new Map<WorkerDomain, WorkerChannel>();

  createChannel(domain: WorkerDomain, worker: Worker): WorkerChannel {
    const sharedBuffer = new SharedArrayBuffer(
      HEADER_SIZE * Int32Array.BYTES_PER_ELEMENT +
        TRANSFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT +
        META_UINTS * Uint32Array.BYTES_PER_ELEMENT,
    );

    const header = new Int32Array(sharedBuffer, 0, HEADER_SIZE);
    const transforms = new Float32Array(
      sharedBuffer,
      HEADER_SIZE * Int32Array.BYTES_PER_ELEMENT,
      TRANSFORM_FLOATS,
    );
    const meta = new Uint32Array(
      sharedBuffer,
      HEADER_SIZE * Int32Array.BYTES_PER_ELEMENT +
        TRANSFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      META_UINTS,
    );

    const channel: WorkerChannel = {
      domain,
      worker,
      views: { header, transforms, meta },
      post: (msg) => worker.postMessage(msg),
    };

    this.channels.set(domain, channel);

    this.send(channel, 'INIT', {
      workerId: `${domain}-${Date.now()}`,
      sharedBuffer,
      sharedBufferByteLength: sharedBuffer.byteLength,
    });

    return channel;
  }

  step(frameIndex: number, dt: number): void {
    for (const channel of this.channels.values()) {
      this.send(channel, 'STEP', { frameIndex, dt });
      Atomics.store(channel.views.header, 0, frameIndex);
      Atomics.notify(channel.views.header, 0, 1);
    }
  }

  sync(sequence: number): void {
    for (const channel of this.channels.values()) {
      this.send(channel, 'SYNC', { sequence });
    }
  }

  shutdown(reason = 'Engine dispose'): void {
    for (const channel of this.channels.values()) {
      this.send(channel, 'SHUTDOWN', { reason });
      channel.worker.terminate();
    }
    this.channels.clear();
  }

  private send<T extends WorkerBridgeMessage['type']>(
    channel: WorkerChannel,
    type: T,
    payload: Extract<WorkerBridgeMessage, { type: T }>['payload'],
  ): void {
    channel.post({
      version: WORKER_PROTOCOL_VERSION,
      type,
      domain: channel.domain,
      timestamp: performance.now(),
      payload,
    } as Extract<WorkerBridgeMessage, { type: T }>);
  }
}
