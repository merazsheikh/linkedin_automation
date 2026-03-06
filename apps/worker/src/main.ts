import 'dotenv/config';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

const publishQueue = new Queue('q:publish', { connection });

await publishQueue.add(
  'heartbeat',
  { createdAt: new Date().toISOString() },
  {
    repeat: { every: 60_000 },
    removeOnComplete: true,
    removeOnFail: 100,
  },
);

const worker = new Worker(
  'q:publish',
  async (job) => {
    console.log('[worker] processing job', job.name, job.id, job.data);
    return { ok: true };
  },
  { connection },
);

worker.on('completed', (job) => {
  console.log('[worker] completed', job.id);
});

worker.on('failed', (job, err) => {
  console.error('[worker] failed', job?.id, err.message);
});

console.log('[worker] running with queue q:publish');
