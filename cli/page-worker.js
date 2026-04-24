const { parentPort, workerData } = require('worker_threads');
const { processPageData } = require('./page-pipeline');

parentPort.on('message', (message) => {
    try {
        const imageData = new Uint8ClampedArray(
            message.buffer,
            message.byteOffset,
            message.byteLength
        );
        const encoded = processPageData(
            imageData,
            workerData.width,
            workerData.height,
            workerData.isHQ,
            workerData.output
        );

        parentPort.postMessage({
            taskId: message.taskId,
            pageIndex: message.pageIndex,
            buffer: encoded.buffer,
            byteLength: encoded.byteLength
        }, [encoded.buffer]);
    } catch (err) {
        parentPort.postMessage({
            taskId: message.taskId,
            error: err && err.message ? err.message : String(err)
        });
    }
});
