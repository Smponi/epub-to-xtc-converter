/**
 * Core EPUB to XTC/XTCH converter
 * Uses CREngine WASM for EPUB rendering
 */

const fs = require('fs');
const path = require('path');
const { XTCStreamWriter } = require('./stream-writer');
const { PageProcessorPool, getWorkerCount } = require('./page-pipeline');
const { getXTGPageSize, getXTHPageSize } = require('./encoder');

let Module = null;
let renderer = null;

function getContainerOverheadBytes(pageCount, chapterCount) {
    return 56 + 256 + (chapterCount * 96) + (pageCount * 16);
}

function createExportStatsAccumulator({ width, height, isHQ, pageCount, chapterCount }) {
    const xtgPageBytes = getXTGPageSize(width, height);
    const xthPageBytes = getXTHPageSize(width, height);

    return {
        pageCount,
        chapterCount,
        isHQ,
        xtgPageBytes,
        xthPageBytes,
        storedPageFormats: { xtg: 0, xth: 0 },
        strictMonochromePages: 0,
        adaptiveMonochromePages: 0,
        grayscalePages: 0,
        strictMonochromeSavedBytes: 0,
        adaptiveMonochromeSavedBytes: 0,
        totalEncodedPageBytes: 0
    };
}

function recordPageStats(accumulator, pageStats) {
    if (!pageStats) {
        return;
    }

    accumulator.totalEncodedPageBytes += pageStats.pageBytes;

    if (accumulator.storedPageFormats[pageStats.pageFormat] !== undefined) {
        accumulator.storedPageFormats[pageStats.pageFormat]++;
    }

    if (pageStats.strategy === 'strict-monochrome') {
        accumulator.strictMonochromePages++;
        accumulator.strictMonochromeSavedBytes += Math.max(0, pageStats.xthBytes - pageStats.pageBytes);
        return;
    }

    if (pageStats.strategy === 'adaptive-monochrome') {
        accumulator.adaptiveMonochromePages++;
        accumulator.adaptiveMonochromeSavedBytes += Math.max(0, pageStats.xthBytes - pageStats.pageBytes);
        return;
    }

    if (pageStats.strategy === 'grayscale') {
        accumulator.grayscalePages++;
    }
}

function finalizeExportStats(accumulator, writerStats, outputSize) {
    const containerOverheadBytes = getContainerOverheadBytes(
        accumulator.pageCount,
        accumulator.chapterCount
    );
    const theoreticalPageBytes = accumulator.pageCount * (
        accumulator.isHQ ? accumulator.xthPageBytes : accumulator.xtgPageBytes
    );
    const theoreticalOutputSize = containerOverheadBytes + theoreticalPageBytes;
    const encodedOutputSizeWithoutDedupe = containerOverheadBytes + accumulator.totalEncodedPageBytes;

    return {
        pageCount: accumulator.pageCount,
        storedPageFormats: accumulator.storedPageFormats,
        strictMonochromePages: accumulator.strictMonochromePages,
        adaptiveMonochromePages: accumulator.adaptiveMonochromePages,
        grayscalePages: accumulator.grayscalePages,
        strictMonochromeSavedBytes: accumulator.strictMonochromeSavedBytes,
        adaptiveMonochromeSavedBytes: accumulator.adaptiveMonochromeSavedBytes,
        monochromeSavedBytes: accumulator.strictMonochromeSavedBytes + accumulator.adaptiveMonochromeSavedBytes,
        totalEncodedPageBytes: accumulator.totalEncodedPageBytes,
        containerOverheadBytes,
        theoreticalOutputSize,
        encodedOutputSizeWithoutDedupe,
        totalSavingsBytes: Math.max(0, theoreticalOutputSize - outputSize),
        outputSize,
        uniqueStoredPages: writerStats.uniquePages,
        deduplicatedPages: writerStats.reusedPages,
        uniqueDataBytes: writerStats.uniqueBytes,
        reusedDataBytes: writerStats.reusedBytes
    };
}

/**
 * Destroy renderer and free WASM memory
 */
function destroyRenderer() {
    if (renderer) {
        renderer.delete();  // Emscripten destructor - frees WASM heap
        renderer = null;
    }
}

/**
 * Initialize CREngine WASM module
 */
async function initWasm() {
    if (Module) return;

    const wasmPath = path.join(__dirname, '..', 'web', 'crengine.js');

    if (!fs.existsSync(wasmPath)) {
        throw new Error(`CREngine WASM not found at: ${wasmPath}`);
    }

    // Load CREngine module
    const CREngine = require(wasmPath);
    Module = await CREngine();
}

/**
 * Create renderer with specified dimensions
 */
function createRenderer(width, height) {
    if (!Module) {
        throw new Error('WASM module not initialized. Call initWasm() first.');
    }
    destroyRenderer();  // Clean up existing renderer before creating new one
    renderer = new Module.EpubRenderer(width, height);

    return renderer;
}

/**
 * Register font from file
 */
async function registerFont(fontPath) {
    if (!renderer) {
        throw new Error('Renderer not initialized');
    }

    const fontData = fs.readFileSync(fontPath);
    const fontName = path.basename(fontPath);

    const ptr = Module.allocateMemory(fontData.length);
    Module.HEAPU8.set(new Uint8Array(fontData), ptr);
    renderer.registerFontFromMemory(ptr, fontData.length, fontName);
    Module.freeMemory(ptr);

    return fontName;
}

/**
 * Load EPUB file into renderer
 */
async function loadEpub(epubPath) {
    if (!renderer) {
        throw new Error('Renderer not initialized');
    }

    const epubData = fs.readFileSync(epubPath);

    const ptr = Module.allocateMemory(epubData.length);
    Module.HEAPU8.set(new Uint8Array(epubData), ptr);

    try {
        renderer.loadEpubFromMemory(ptr, epubData.length);

        // Disable built-in status bar (must be after loading document)
        renderer.configureStatusBar(false, false, false, false, false, false, false, false, false);
    } finally {
        Module.freeMemory(ptr);
    }

    return {
        pageCount: renderer.getPageCount(),
        info: renderer.getDocumentInfo() || {},
        toc: renderer.getToc() || []
    };
}

/**
 * Apply rendering settings
 */
function applySettings(settings) {
    if (!renderer) {
        throw new Error('Renderer not initialized');
    }

    const { margins, font, lineHeight, textAlignValue, hyphenation } = settings;

    renderer.setMargins(
        margins.left,
        margins.top,
        margins.right,
        margins.bottom
    );
    renderer.setFontSize(font.size);
    renderer.setFontWeight(font.weight);
    renderer.setInterlineSpace(lineHeight);
    renderer.setTextAlign(textAlignValue);

    if (hyphenation.enabled) {
        renderer.setHyphenation(2); // Dictionary-based
        if (renderer.setHyphenationLanguage) {
            renderer.setHyphenationLanguage(hyphenation.language);
        }
    } else {
        renderer.setHyphenation(0); // Disabled
    }
}

/**
 * Render a single page
 */
function renderPage(pageNum) {
    if (!renderer) {
        throw new Error('Renderer not initialized');
    }

    renderer.goToPage(pageNum);
    renderer.renderCurrentPage();

    const frameBuffer = renderer.getFrameBuffer();
    if (!frameBuffer || frameBuffer.length === 0) {
        throw new Error(`Empty frame buffer for page ${pageNum}`);
    }

    // Copy buffer (frame buffer may be reused by WASM)
    return new Uint8ClampedArray(frameBuffer);
}

/**
 * Convert single EPUB to XTC/XTCH
 */
async function convertEpub(epubPath, outputPath, settings, progressCallback) {
    const { width, height, output } = settings;
    const isHQ = output.format === 'xtch';

    // Initialize and setup
    await initWasm();
    createRenderer(width, height);

    // Register font
    await registerFont(settings.font.path);

    // Load EPUB
    const { pageCount, info, toc } = await loadEpub(epubPath);

    if (pageCount === 0) {
        throw new Error('EPUB has no pages');
    }

    // Apply settings after loading (affects pagination)
    applySettings(settings);

    // Re-get page count after settings (pagination may change)
    const totalPages = renderer.getPageCount();

    const metadata = {
        title: info.title || path.basename(epubPath, '.epub'),
        author: info.author || info.authors || ''
    };

    const workerCount = getWorkerCount(totalPages);
    const pool = new PageProcessorPool({
        width,
        height,
        isHQ,
        output,
        workerCount
    });
    const writer = new XTCStreamWriter(outputPath, {
        metadata,
        toc,
        width,
        height,
        isHQ,
        pageCount: totalPages
    });

    const completedPages = new Map();
    let nextPageToWrite = 0;
    let scheduledPages = 0;
    let waiter = null;
    let processingError = null;
    const exportStats = createExportStatsAccumulator({
        width,
        height,
        isHQ,
        pageCount: totalPages,
        chapterCount: toc.length
    });

    function notifyWaiter() {
        if (waiter) {
            const resolve = waiter;
            waiter = null;
            resolve();
        }
    }

    function waitForCompletion() {
        if (processingError) {
            return Promise.reject(processingError);
        }
        return new Promise((resolve) => {
            waiter = resolve;
        });
    }

    async function flushReady(waitForNext) {
        while (!completedPages.has(nextPageToWrite)) {
            if (!waitForNext) {
                return;
            }
            await waitForCompletion();
            if (processingError) {
                throw processingError;
            }
        }

        while (completedPages.has(nextPageToWrite)) {
            const processedPage = completedPages.get(nextPageToWrite);
            completedPages.delete(nextPageToWrite);
            recordPageStats(exportStats, processedPage.pageStats);
            writer.appendPage(processedPage.encoded);

            if (progressCallback) {
                progressCallback(nextPageToWrite + 1, totalPages);
            }

            nextPageToWrite++;
        }
    }

    const maxInFlight = Math.max(2, workerCount > 0 ? workerCount * 2 : 2);

    try {
        // Render all pages, but keep post-processing bounded so we don't balloon memory.
        for (let i = 0; i < totalPages; i++) {
            const imageData = renderPage(i);
            scheduledPages++;

            pool.processPage(i, imageData)
                .then((result) => {
                    completedPages.set(result.pageIndex, result);
                    notifyWaiter();
                })
                .catch((err) => {
                    processingError = err;
                    notifyWaiter();
                });

            if (scheduledPages - nextPageToWrite >= maxInFlight) {
                await flushReady(true);
            } else {
                await flushReady(false);
            }
        }

        while (nextPageToWrite < totalPages) {
            await flushReady(true);
        }

        writer.finish();
        const writerStats = writer.getStats();
        const outputSize = fs.statSync(outputPath).size;
        const finalizedStats = finalizeExportStats(exportStats, writerStats, outputSize);

        return {
            outputPath,
            pageCount: totalPages,
            format: output.format,
            workersUsed: workerCount,
            ...finalizedStats
        };
    } finally {
        await pool.close();
        writer.close();
    }
}

/**
 * Get output path for an EPUB file
 */
function getOutputPath(inputPath, outputDir, format) {
    const basename = path.basename(inputPath, '.epub');
    const extension = format === 'xtch' ? '.xtch' : '.xtc';
    return path.join(outputDir, basename + extension);
}

/**
 * Cleanup renderer resources
 */
function cleanup() {
    destroyRenderer();
}

module.exports = {
    initWasm,
    createRenderer,
    registerFont,
    loadEpub,
    applySettings,
    renderPage,
    convertEpub,
    getOutputPath,
    cleanup
};
