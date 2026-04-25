const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function encodeField(text, maxChars) {
    return Buffer.from(new TextEncoder().encode((text || '').substring(0, maxChars)));
}

class XTCStreamWriter {
    constructor(outputPath, options) {
        this.outputPath = outputPath;
        this.pageCount = options.pageCount;
        this.width = options.width;
        this.height = options.height;
        this.closed = false;

        const dir = path.dirname(outputPath);
        fs.mkdirSync(dir, { recursive: true });

        const headerSize = 56;
        const metadataSize = 256;
        const chapterEntrySize = 96;
        const indexEntrySize = 16;
        const chaptersSize = options.toc.length * chapterEntrySize;
        const indexSize = this.pageCount * indexEntrySize;

        this.metadataOffset = headerSize;
        this.chapterOffset = this.metadataOffset + metadataSize;
        this.indexOffset = this.chapterOffset + chaptersSize;
        this.pageDataOffset = this.indexOffset + indexSize;
        this.currentOffset = this.pageDataOffset;
        this.pageEntries = [];
        this.pageCache = new Map();
        this.stats = {
            uniquePages: 0,
            reusedPages: 0,
            uniqueBytes: 0,
            reusedBytes: 0
        };

        this.fd = fs.openSync(outputPath, 'w');
        this.writeHeader(options);
        this.writeMetadata(options);
        this.writeChapters(options);
        fs.writeSync(this.fd, Buffer.alloc(indexSize), 0, indexSize, this.indexOffset);
    }

    writeHeader(options) {
        const magic = options.isHQ ? 'XTCH' : 'XTC\0';
        const header = Buffer.alloc(56);

        header.write(magic, 0, 'ascii');
        header.writeUInt16LE(1, 4);
        header.writeUInt16LE(this.pageCount, 6);
        header[8] = 0;
        header[9] = 1;
        header[10] = 0;
        header[11] = options.toc.length > 0 ? 1 : 0;
        header.writeUInt32LE(1, 12);
        header.writeBigUInt64LE(BigInt(this.metadataOffset), 16);
        header.writeBigUInt64LE(BigInt(this.indexOffset), 24);
        header.writeBigUInt64LE(BigInt(this.pageDataOffset), 32);
        header.writeBigUInt64LE(0n, 40);
        header.writeBigUInt64LE(BigInt(this.chapterOffset), 48);

        fs.writeSync(this.fd, header, 0, header.length, 0);
    }

    writeMetadata(options) {
        const bytes = Buffer.alloc(256);
        const titleBytes = encodeField(options.metadata.title, 126);
        const authorBytes = encodeField(options.metadata.author, 62);

        titleBytes.copy(bytes, 0);
        bytes[127] = 0;
        authorBytes.copy(bytes, 128);
        bytes[191] = 0;
        bytes.writeUInt32LE(Math.floor(Date.now() / 1000), 192);
        bytes.writeUInt16LE(options.toc.length, 196);

        fs.writeSync(this.fd, bytes, 0, bytes.length, this.metadataOffset);
    }

    writeChapters(options) {
        const bytes = Buffer.alloc(options.toc.length * 96);

        for (let i = 0; i < options.toc.length; i++) {
            const chapter = options.toc[i];
            if (!chapter) continue;

            const base = i * 96;
            const title = chapter.title || chapter.name || `Chapter ${i + 1}`;
            const page = chapter.page || chapter.startPage || 0;
            const titleBytes = encodeField(title, 78);

            titleBytes.copy(bytes, base);
            bytes[base + 79] = 0;
            bytes.writeUInt16LE(page + 1, base + 80);
            bytes.writeUInt16LE(page + 1, base + 82);
        }

        fs.writeSync(this.fd, bytes, 0, bytes.length, this.chapterOffset);
    }

    appendPage(pageData) {
        const cacheKey = `${pageData.length}:${crypto.createHash('sha1').update(pageData).digest('hex')}`;
        const cachedEntry = this.pageCache.get(cacheKey);

        if (cachedEntry) {
            this.pageEntries.push({
                offset: cachedEntry.offset,
                size: cachedEntry.size
            });
            this.stats.reusedPages++;
            this.stats.reusedBytes += pageData.length;
            return {
                deduplicated: true,
                offset: cachedEntry.offset,
                size: cachedEntry.size
            };
        }

        const entry = {
            offset: this.currentOffset,
            size: pageData.length
        };

        fs.writeSync(this.fd, pageData, 0, pageData.length, this.currentOffset);
        this.pageEntries.push(entry);
        this.pageCache.set(cacheKey, entry);
        this.currentOffset += pageData.length;
        this.stats.uniquePages++;
        this.stats.uniqueBytes += pageData.length;

        return {
            deduplicated: false,
            offset: entry.offset,
            size: entry.size
        };
    }

    getStats() {
        return {
            uniquePages: this.stats.uniquePages,
            reusedPages: this.stats.reusedPages,
            uniqueBytes: this.stats.uniqueBytes,
            reusedBytes: this.stats.reusedBytes
        };
    }

    finish() {
        if (this.closed) return;

        for (let i = 0; i < this.pageEntries.length; i++) {
            const entry = this.pageEntries[i];
            const row = Buffer.alloc(16);
            row.writeBigUInt64LE(BigInt(entry.offset), 0);
            row.writeUInt32LE(entry.size, 8);
            row.writeUInt16LE(this.width, 12);
            row.writeUInt16LE(this.height, 14);
            fs.writeSync(this.fd, row, 0, row.length, this.indexOffset + (i * 16));
        }

        fs.closeSync(this.fd);
        this.pageCache.clear();
        this.closed = true;
    }

    close() {
        if (this.closed) return;
        fs.closeSync(this.fd);
        this.pageCache.clear();
        this.closed = true;
    }
}

module.exports = {
    XTCStreamWriter
};
