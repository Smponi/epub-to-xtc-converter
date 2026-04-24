const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { applyDithering, applyNegative } = require('./dither');
const { encodeXTG, encodeXTH } = require('./encoder');

function processPageData(imageData, width, height, isHQ, output) {
    const bits = isHQ ? 2 : 1;
    let processed = imageData;

    if (output.dithering) {
        processed = applyDithering(processed, width, height, bits, output.ditherStrength);
    }

    if (output.negative) {
        applyNegative(processed);
    }

    return isHQ
        ? encodeXTH(processed, width, height)
        : encodeXTG(processed, width, height);
}

function getWorkerCount(totalPages) {
    const fromEnv = process.env.EPUB_TO_XTC_WORKERS;
    if (fromEnv !== undefined) {
        const parsed = Number.parseInt(fromEnv, 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    }

    if (totalPages <= 1) {
        return 0;
    }

    const parallelism = typeof os.availableParallelism === 'function'
        ? os.availableParallelism()
        : os.cpus().length;

    return Math.max(0, Math.min(4, parallelism - 1));
}

class PageProcessorPool {
    constructor(options) {
        this.options = options;
        this.queue = [];
        this.pending = new Map();
        this.idleWorkers = [];
        this.workers = [];
        this.nextTaskId = 1;

        for (let i = 0; i < options.workerCount; i++) {
            const worker = new Worker(path.join(__dirname, 'page-worker.js'), {
                workerData: {
                    width: options.width,
                    height: options.height,
                    isHQ: options.isHQ,
                    output: options.output
                }
            });

            worker.on('message', (message) => {
                const task = this.pending.get(message.taskId);
                if (!task) return;

                this.pending.delete(message.taskId);
                this.idleWorkers.push(worker);
                if (message.error) {
                    task.reject(new Error(message.error));
                    this.pumpQueue();
                    return;
                }
                task.resolve({
                    pageIndex: message.pageIndex,
                    encoded: new Uint8Array(message.buffer, 0, message.byteLength)
                });
                this.pumpQueue();
            });

            worker.on('error', (err) => {
                this.rejectWorkerTasks(worker, err);
            });

            worker.on('exit', (code) => {
                if (code !== 0) {
                    this.rejectWorkerTasks(worker, new Error(`Worker exited with code ${code}`));
                }
            });

            this.idleWorkers.push(worker);
            this.workers.push(worker);
        }
    }

    rejectWorkerTasks(worker, err) {
        this.idleWorkers = this.idleWorkers.filter((candidate) => candidate !== worker);

        for (const [taskId, task] of this.pending.entries()) {
            if (task.worker === worker) {
                this.pending.delete(taskId);
                task.reject(err);
            }
        }
    }

    processPage(pageIndex, imageData) {
        if (this.workers.length === 0) {
            return Promise.resolve({
                pageIndex,
                encoded: processPageData(
                    imageData,
                    this.options.width,
                    this.options.height,
                    this.options.isHQ,
                    this.options.output
                )
            });
        }

        return new Promise((resolve, reject) => {
            this.queue.push({
                pageIndex,
                imageData,
                resolve,
                reject
            });
            this.pumpQueue();
        });
    }

    pumpQueue() {
        while (this.queue.length > 0 && this.idleWorkers.length > 0) {
            const worker = this.idleWorkers.shift();
            const job = this.queue.shift();
            const taskId = this.nextTaskId++;

            this.pending.set(taskId, {
                worker,
                resolve: job.resolve,
                reject: job.reject
            });

            worker.postMessage({
                taskId,
                pageIndex: job.pageIndex,
                buffer: job.imageData.buffer,
                byteOffset: job.imageData.byteOffset,
                byteLength: job.imageData.byteLength
            }, [job.imageData.buffer]);
        }
    }

    async close() {
        const shutdownError = new Error('Page processor pool closed');

        for (const task of this.pending.values()) {
            task.reject(shutdownError);
        }
        for (const job of this.queue) {
            job.reject(shutdownError);
        }

        const terminations = this.workers.map((worker) => worker.terminate());
        this.workers = [];
        this.idleWorkers = [];
        this.pending.clear();
        this.queue.length = 0;
        await Promise.allSettled(terminations);
    }
}

module.exports = {
    processPageData,
    PageProcessorPool,
    getWorkerCount
};
