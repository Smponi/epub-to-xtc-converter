const { parentPort, workerData } = require('worker_threads');
const { processPageData } = require('./page-pipeline');

parentPort.on('message', (message) => {
    try {
        const imageData = new Uint8ClampedArray(
            message.buffer,
            message.byteOffset,
            message.byteLength
        );
        const encodedResult = processPageData(
            imageData,
            workerData.width,
            workerData.height,
            workerData.isHQ,
            workerData.output
        );

        parentPort.postMessage({
            taskId: message.taskId,
            pageIndex: message.pageIndex,
            buffer: encodedResult.pageData.buffer,
            byteLength: encodedResult.pageData.byteLength,
            pageStats: encodedResult.stats
        }, [encodedResult.pageData.buffer]);
    } catch (err) {
        parentPort.postMessage({
            taskId: message.taskId,
            error: err && err.message ? err.message : String(err)
        });
    }
});
